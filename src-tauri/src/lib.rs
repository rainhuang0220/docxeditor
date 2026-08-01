use tauri::Manager;
use tauri_plugin_shell::ShellExt;

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

      // Spawn the Python backend as a sidecar process
      // In dev mode, the project root is two levels up from src-tauri/
      // In production, backend is bundled alongside the app resource directory
      let project_root = if cfg!(debug_assertions) {
        std::env::current_dir()
          .unwrap_or_default()
          .parent()
          .unwrap_or(std::path::Path::new("."))
          .to_path_buf()
      } else {
        app.path().resource_dir().unwrap_or_default()
      };

      let shell = app.shell();
      let _ = shell.command("python3")
        .args(["-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "8000"])
        .current_dir(project_root)
        .spawn();

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
