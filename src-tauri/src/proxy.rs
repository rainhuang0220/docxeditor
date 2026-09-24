//! Authenticated loopback proxy. The WebView never sees the session token.

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use tauri::ipc::Channel;
use tokio::sync::watch;

use crate::supervisor::{Phase, SharedSession};

const MAX_BODY: usize = 20_000_000;

fn safe_path(path: &str) -> Result<(), ()> {
    if !path.starts_with("/api/") {
        return Err(());
    }
    if path.contains("://")
        || path.contains("..")
        || path.contains('\\')
        || path.contains('\n')
        || path.contains('\0')
        || path.contains(' ')
    {
        return Err(());
    }
    Ok(())
}

fn endpoint(session: &SharedSession) -> Result<(String, String, reqwest::Client), String> {
    let guard = session.lock().map_err(|_| "The backend is unavailable.".to_string())?;
    if guard.phase != Phase::Ready || guard.port == 0 || guard.token.is_empty() {
        return Err("The backend is unavailable.".to_string());
    }
    let url_prefix = format!("http://127.0.0.1:{}", guard.port);
    let token = hex::encode(&guard.token);
    Ok((url_prefix, token, client()))
}

fn client() -> reqwest::Client {
    // The bearer token must not follow HTTP_PROXY or ALL_PROXY off loopback.
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(120))
        .build()
        .expect("http client")
}

pub struct ApiResult {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

pub async fn request(
    session: &SharedSession,
    method: &str,
    path: &str,
    body: Option<Vec<u8>>,
    content_type: Option<String>,
    file_name: Option<String>,
    file_bytes: Option<Vec<u8>>,
) -> Result<ApiResult, String> {
    safe_path(path).map_err(|_| "The request was rejected.".to_string())?;
    let (prefix, token, http) = endpoint(session)?;
    let url = format!("{prefix}{path}");
    let method = method.to_ascii_uppercase();
    let mut builder = http.request(reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "The request was rejected.".to_string())?, url);
    builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
    if let Some(bytes) = file_bytes {
        if bytes.len() > MAX_BODY {
            return Err("The request was rejected.".to_string());
        }
        let name = file_name.unwrap_or_else(|| "document.docx".to_string());
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(name)
            .mime_str("application/octet-stream")
            .map_err(|_| "The request was rejected.".to_string())?;
        builder = builder.multipart(reqwest::multipart::Form::new().part("file", part));
    } else if let Some(bytes) = body {
        if bytes.len() > MAX_BODY {
            return Err("The request was rejected.".to_string());
        }
        builder = builder.header(
            CONTENT_TYPE,
            content_type.unwrap_or_else(|| "application/json".to_string()),
        );
        builder = builder.body(bytes);
    }
    let response = builder.send().await.map_err(|_| "The backend is unavailable.".to_string())?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let body = response.bytes().await.map_err(|_| "The backend is unavailable.".to_string())?;
    if body.len() > MAX_BODY {
        return Err("The request was rejected.".to_string());
    }
    Ok(ApiResult { status, content_type, body: body.to_vec() })
}

pub async fn stream(
    session: &SharedSession,
    request_id: String,
    path: String,
    body: String,
    channel: Channel<String>,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    safe_path(&path).map_err(|_| "The request was rejected.".to_string())?;
    if body.len() > MAX_BODY {
        return Err("The request was rejected.".to_string());
    }
    if *cancel.borrow() {
        let _ = channel.send("{\"kind\":\"error\"}".to_string());
        return Ok(());
    }
    let (prefix, token, http) = endpoint(session)?;
    let pending = http
        .post(format!("{prefix}{path}"))
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .send();
    let response = tokio::select! {
        _ = cancel.changed() => {
            let _ = channel.send("{\"kind\":\"error\"}".to_string());
            return Ok(());
        }
        result = pending => result.map_err(|_| "The backend is unavailable.".to_string())?,
    };
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("text/event-stream")
        .to_string();
    let _ = channel.send(format!(
        "{{\"kind\":\"status\",\"status\":{status},\"contentType\":{}}}",
        serde_json::to_string(&content_type).unwrap_or_else(|_| "\"\"".to_string())
    ));
    let _ = request_id;
    consume_until_cancel(response, &channel, &mut cancel).await
}

pub(crate) async fn consume_until_cancel(
    response: reqwest::Response,
    channel: &Channel<String>,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    let mut incoming = response.bytes_stream();
    let mut pending: Vec<u8> = Vec::new();
    loop {
        if *cancel.borrow() {
            let _ = channel.send("{\"kind\":\"error\"}".to_string());
            return Ok(());
        }
        tokio::select! {
            _ = cancel.changed() => {
                let _ = channel.send("{\"kind\":\"error\"}".to_string());
                return Ok(());
            }
            item = incoming.next() => {
                match item {
                    Some(Ok(chunk)) => {
                        pending.extend_from_slice(&chunk);
                        let split = match std::str::from_utf8(&pending) {
                            Ok(_) => pending.len(),
                            Err(error) => error.valid_up_to(),
                        };
                        if split > 0 {
                            let text = String::from_utf8_lossy(&pending[..split]).into_owned();
                            pending.drain(..split);
                            let payload = serde_json::json!({"kind": "chunk", "data": text}).to_string();
                            if channel.send(payload).is_err() {
                                return Ok(());
                            }
                        }
                    }
                    Some(Err(_)) => {
                        let _ = channel.send("{\"kind\":\"error\"}".to_string());
                        return Ok(());
                    }
                    None => {
                        let _ = channel.send("{\"kind\":\"end\"}".to_string());
                        return Ok(());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    #[tokio::test]
    async fn cancel_reaches_the_python_generator() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let dir = std::env::temp_dir().join(format!("docxeditor-drip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("drip.txt");
        let token = [9u8; 32];
        let venv_python = root.join("build/sidecar-venv/bin/python3");
        let python = if venv_python.is_file() { venv_python } else { std::path::PathBuf::from("python3") };
        let mut child = Command::new(python)
            .args(["-m", "backend.desktop_runtime"])
            .current_dir(root)
            .env("DOCXEDITOR_KEYRING", "disabled")
            .env("DOCXEDITOR_CONFIG_PATH", dir.join("config.json"))
            .env("DOCXEDITOR_TEST_HOOKS", "1")
            .env("DOCXEDITOR_DRIP_MARKER", &marker)
            .env_remove("DOCXEDITOR_DEV_INSECURE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(format!("v1 {}\n", hex::encode(token)).as_bytes()).unwrap();
        stdin.flush().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            let _ = tx.send(line);
        });
        let line = rx.recv_timeout(Duration::from_secs(15)).expect("ready line");
        let port = crate::supervisor::accept_ready(&line, &token).unwrap_or_else(|| {
            let err = child.stderr.take().map(|mut stderr| {
                let mut text = String::new();
                use std::io::Read;
                let _ = stderr.read_to_string(&mut text);
                text
            });
            panic!("ready mac rejected: {line:?} stderr={err:?}");
        });
        let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
        let seen = Arc::new(Mutex::new(String::new()));
        let record = seen.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            record.lock().unwrap().push_str(&format!("{body:?}"));
            Ok(())
        });
        let response = client()
            .get(format!("http://127.0.0.1:{port}/api/test/drip"))
            .header(AUTHORIZATION, format!("Bearer {}", hex::encode(token)))
            .send()
            .await
            .expect("drip request");
        let task = tokio::spawn(async move { consume_until_cancel(response, &channel, &mut cancel_rx).await });
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline && !seen.lock().unwrap().contains("data: 0") {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(seen.lock().unwrap().contains("data: 0"), "first drip event did not arrive early");
        assert!(!seen.lock().unwrap().contains("data: 8"), "the stream was buffered");
        assert!(!marker.exists());
        cancel_tx.send(true).unwrap();
        let _ = task.await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && !marker.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(std::fs::read_to_string(&marker).unwrap_or_default(), "closed");
        drop(stdin);
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
