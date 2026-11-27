use serde_json::json;
use std::path::PathBuf;
use tauri::{ipc::CapabilityBuilder, DragDropEvent, Manager, WebviewEvent};
use tauri_plugin_dialog::DialogExt;

pub fn grant(app: &tauri::App, port: u16) -> tauri::Result<()> {
    app.add_capability(
        CapabilityBuilder::new("hub-folder")
            .webview("main")
            .local(false)
            .remote(format!("http://127.0.0.1:{port}/"))
            .permission("allow-pick-folder")
            .permission("allow-notify-terminal")
            .permission("allow-window-action"),
    )
}

#[tauri::command]
pub async fn window_action(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "drag" => window.start_dragging().map_err(|e| e.to_string()),
        "minimize" => window.minimize().map_err(|e| e.to_string()),
        "toggle-maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize().map_err(|e| e.to_string())
            } else {
                window.maximize().map_err(|e| e.to_string())
            }
        }
        "close" => window.hide().map_err(|e| e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn pick_folder(
    window: tauri::WebviewWindow,
    initial_path: Option<PathBuf>,
) -> Result<Option<PathBuf>, String> {
    let mut picker = window.dialog().file().set_parent(&window);
    if let Some(path) = initial_path
        .as_deref()
        .filter(|path| path.is_absolute())
        .and_then(|path| path.ancestors().find(|parent| parent.is_dir()))
    {
        picker = picker.set_directory(path);
    }
    tauri::async_runtime::spawn_blocking(|| {
        picker
            .blocking_pick_folder()
            .map(|path| path.into_path().map_err(|error| error.to_string()))
            .transpose()
    })
    .await
    .map_err(|error| format!("Could not open the folder picker: {error}"))?
}

pub fn on_drag_drop(webview: &tauri::Webview, event: &WebviewEvent) {
    let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, position }) = event else {
        return;
    };
    let (Ok(url), Ok(port)) = (webview.url(), crate::hub::port()) else {
        return;
    };
    let origin = format!("http://127.0.0.1:{port}");
    let origin = origin.trim_end_matches(":80");
    if webview.label() != "main"
        || url.origin().ascii_serialization() != origin
        || url.path() != "/"
    {
        return;
    }

    let entries: Vec<_> = paths
        .iter()
        .filter(|path| path.is_absolute() && (path.is_file() || path.is_dir()))
        .filter_map(|path| {
            path.to_str()
                .map(|s| json!({ "path": s, "isDir": path.is_dir() }))
        })
        .collect();
    if entries.is_empty() {
        return;
    }
    let raw_paths: Vec<_> = entries
        .iter()
        .filter_map(|entry| entry.get("path").and_then(|v| v.as_str()))
        .collect();
    let drop = json!({ "paths": raw_paths, "entries": entries, "x": position.x, "y": position.y });
    // The document can navigate before WebView2 executes this script.
    let script = format!(
        "if (location.origin === {} && location.pathname === '/') window.dispatchEvent(new CustomEvent('hub-native-drop', {{ detail: {drop} }}));",
        json!(origin)
    );
    if let Err(error) = webview.eval(script) {
        eprintln!("Could not deliver the native file drop: {error}");
    }
}
