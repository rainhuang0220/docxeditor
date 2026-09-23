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
    cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    safe_path(&path).map_err(|_| "The request was rejected.".to_string())?;
    if body.len() > MAX_BODY {
        return Err("The request was rejected.".to_string());
    }
    let (prefix, token, http) = endpoint(session)?;
    let response = http
        .post(format!("{prefix}{path}"))
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| "The backend is unavailable.".to_string())?;
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
    let mut incoming = response.bytes_stream();
    let mut cancel = cancel;
    let mut pending: Vec<u8> = Vec::new();
    loop {
        tokio::select! {
            _ = cancel.changed() => {
                let _ = channel.send("{\"kind\":\"error\"}".to_string());
                let _ = request_id;
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
