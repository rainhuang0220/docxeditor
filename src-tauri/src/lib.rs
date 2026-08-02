use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

/// The backend may already be running (e.g. started via start-backend.sh
/// or by another instance). Don't spawn a duplicate in that case.
fn backend_already_running() -> bool {
  use std::net::{SocketAddr, TcpStream};
  use std::time::Duration;
  let addr: SocketAddr = ([127, 0, 0, 1], 8000).into();
  TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// A root is runnable if it contains the backend package.
fn is_backend_root(root: &PathBuf) -> bool {
  root.join("backend").join("main.py").exists()
}

fn venv_python(root: &PathBuf) -> Option<PathBuf> {
  let p = root.join("backend").join(".venv").join("bin").join("python");
  if p.exists() { Some(p) } else { None }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      if !backend_already_running() {
        // Candidate project roots containing backend/, in priority order:
        // dev project root, bundled resources, well-known dev checkout.
        let mut roots: Vec<PathBuf> = Vec::new();
        if cfg!(debug_assertions) {
          if let Ok(cwd) = std::env::current_dir() {
            if let Some(parent) = cwd.parent() {
              roots.push(parent.to_path_buf());
            }
          }
        }
        if let Ok(res) = app.path().resource_dir() {
          roots.push(res);
        }
        if let Ok(home) = std::env::var("HOME") {
          roots.push(PathBuf::from(home).join("Desktop").join("docxeditor"));
        }
        let roots: Vec<PathBuf> = roots.into_iter().filter(is_backend_root).collect();

        // Prefer a root with a project venv (guaranteed to have all Python
        // deps); fall back to system python3 for a bare backend copy.
        let chosen = roots
          .iter()
          .find(|r| venv_python(r).is_some())
          .or_else(|| roots.first());

        if let Some(root) = chosen {
          let python = venv_python(root)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "python3".to_string());
          let shell = app.shell();
          let _ = shell
            .command(python)
            .args(["-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "8000"])
            .current_dir(root)
            .spawn();
        }
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
