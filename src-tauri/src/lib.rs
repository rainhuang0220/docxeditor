mod proxy;
mod supervisor;

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;
use tauri::{Manager, RunEvent, State};
use tokio::sync::watch;

struct AppState {
    session: supervisor::SharedSession,
    inflight: Mutex<HashMap<String, watch::Sender<bool>>>,
}

fn state_json(session: &supervisor::Session) -> serde_json::Value {
    serde_json::json!({
        "phase": session.phase.as_str(),
        "detail": session.detail,
    })
}

#[tauri::command]
fn backend_status(state: State<AppState>) -> serde_json::Value {
    match state.session.lock() {
        Ok(guard) => state_json(&guard),
        Err(_) => serde_json::json!({"phase": "failed", "detail": "The backend is unavailable."}),
    }
}

#[tauri::command]
fn backend_retry(state: State<AppState>) -> Result<serde_json::Value, String> {
    let mut guard = state.session.lock().map_err(|_| "The backend is unavailable.".to_string())?;
    supervisor::stop(&mut guard);
    let result = supervisor::start(&mut guard);
    let body = state_json(&guard);
    result?;
    Ok(body)
}

#[tauri::command]
async fn api_request(
    state: State<'_, AppState>,
    method: String,
    path: String,
    body: Option<String>,
    content_type: Option<String>,
    file_name: Option<String>,
    file_base64: Option<String>,
) -> Result<serde_json::Value, String> {
    let file_bytes = match file_base64 {
        Some(text) if !text.is_empty() => Some(
            base64::engine::general_purpose::STANDARD
                .decode(text)
                .map_err(|_| "The request was rejected.".to_string())?,
        ),
        _ => None,
    };
    let bytes = body.map(|text| text.into_bytes());
    let result = proxy::request(
        &state.session,
        &method,
        &path,
        bytes,
        content_type,
        file_name,
        file_bytes,
    )
    .await?;
    Ok(serde_json::json!({
        "status": result.status,
        "contentType": result.content_type,
        "bodyBase64": base64::engine::general_purpose::STANDARD.encode(result.body),
    }))
}

#[tauri::command]
async fn api_stream(
    state: State<'_, AppState>,
    request_id: String,
    path: String,
    body: String,
    channel: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    let (sender, receiver) = watch::channel(false);
    state
        .inflight
        .lock()
        .map_err(|_| "The backend is unavailable.".to_string())?
        .insert(request_id.clone(), sender);
    let result = proxy::stream(&state.session, request_id.clone(), path, body, channel, receiver).await;
    if let Ok(mut inflight) = state.inflight.lock() {
        inflight.remove(&request_id);
    }
    result
}

#[tauri::command]
fn api_cancel(state: State<AppState>, request_id: String) {
    if let Ok(inflight) = state.inflight.lock() {
        if let Some(sender) = inflight.get(&request_id) {
            let _ = sender.send(true);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            session: Mutex::new(supervisor::Session::new()),
            inflight: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let watch = handle.clone();
            std::thread::spawn(move || {
                if let Some(state) = handle.try_state::<AppState>() {
                    if let Ok(mut guard) = state.session.lock() {
                        let _ = supervisor::start(&mut guard);
                    }
                }
            });
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let Some(state) = watch.try_state::<AppState>() else { break };
                let Ok(mut guard) = state.session.lock() else { break };
                supervisor::note_if_exited(&mut guard);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_status,
            backend_retry,
            api_request,
            api_stream,
            api_cancel
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut guard) = state.session.lock() {
                        supervisor::stop(&mut guard);
                    }
                }
            }
        });
}
