mod inflight;
mod proxy;
mod supervisor;

use std::sync::Mutex;

use base64::Engine;
use tauri::{Manager, RunEvent, State};

struct AppState {
    session: supervisor::SharedSession,
    inflight: Mutex<inflight::Inflight>,
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
    supervisor::stop(&state.session);
    supervisor::start(&state.session)?;
    let guard = state.session.lock().map_err(|_| "The backend is unavailable.".to_string())?;
    Ok(state_json(&guard))
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

struct FinishStream<'a> {
    inflight: &'a Mutex<inflight::Inflight>,
    id: String,
    owner: String,
}

impl Drop for FinishStream<'_> {
    fn drop(&mut self) {
        if let Ok(mut inflight) = self.inflight.lock() {
            inflight.finish(&self.id, &self.owner);
        }
    }
}

#[tauri::command]
fn api_stream_reserve(state: State<AppState>, request_id: String, owner: String) -> Result<(), String> {
    let mut inflight = state.inflight.lock().map_err(|_| "The backend is unavailable.".to_string())?;
    match inflight.reserve(&request_id, &owner) {
        inflight::Reserve::Reserved => Ok(()),
        inflight::Reserve::Duplicate => Err("The request is already active.".to_string()),
    }
}

#[tauri::command]
fn api_stream_release(state: State<AppState>, request_id: String, owner: String) -> Result<(), String> {
    let mut inflight = state.inflight.lock().map_err(|_| "The backend is unavailable.".to_string())?;
    inflight.release(&request_id, &owner);
    Ok(())
}

#[tauri::command]
async fn api_stream(
    state: State<'_, AppState>,
    request_id: String,
    owner: String,
    path: String,
    body: String,
    channel: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    let receiver = {
        let mut inflight = state.inflight.lock().map_err(|_| "The backend is unavailable.".to_string())?;
        match inflight.start(&request_id, &owner) {
            inflight::Start::Ready(receiver) => receiver,
            inflight::Start::Cancelled => return Err("The request was cancelled.".to_string()),
            inflight::Start::Duplicate => return Err("The request is already active.".to_string()),
            inflight::Start::NotReserved => return Err("The request was not reserved.".to_string()),
        }
    };
    let _finish = FinishStream {
        inflight: &state.inflight,
        id: request_id.clone(),
        owner,
    };
    proxy::stream(&state.session, request_id, path, body, channel, receiver).await
}

#[tauri::command]
fn api_cancel(state: State<AppState>, request_id: String, owner: String) {
    if let Ok(mut inflight) = state.inflight.lock() {
        inflight.cancel(&request_id, &owner);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            session: Mutex::new(supervisor::Session::new()),
            inflight: Mutex::new(inflight::Inflight::new()),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let watch = handle.clone();
            std::thread::spawn(move || {
                if let Some(state) = handle.try_state::<AppState>() {
                    let _ = supervisor::start(&state.session);
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
            api_stream_reserve,
            api_stream,
            api_stream_release,
            api_cancel
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                if let Some(state) = app.try_state::<AppState>() {
                    supervisor::stop(&state.session);
                }
            }
        });
}
