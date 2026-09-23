fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "api_request",
                "api_stream",
                "api_cancel",
                "backend_status",
                "backend_retry",
            ]),
        ),
    )
    .expect("failed to build tauri application");
}
