fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&[
        "connect_hub",
        "pick_folder",
        "window_action",
        "notify_terminal",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("Could not build Agent CLI Hub");
}
