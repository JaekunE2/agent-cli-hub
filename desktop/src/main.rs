#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

mod backend;
mod bridge;
mod hub;
mod overview;

#[tauri::command]
async fn connect_hub(
    window: tauri::WebviewWindow,
    server: tauri::State<'_, tauri::async_runtime::Mutex<Option<std::process::Child>>>,
) -> Result<(), String> {
    let mut server = server
        .try_lock()
        .map_err(|_| "A connection attempt is already running.")?;
    let url = hub::connect(&mut server).await?;
    window
        .navigate(url)
        .map_err(|_| "Could not open the hub dashboard.".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let Some(window) = app.get_webview_window("main") else {
                eprintln!("Could not focus Agent CLI Hub: main window was not found");
                return;
            };

            for result in [window.show(), window.unminimize(), window.set_focus()] {
                if let Err(error) = result {
                    eprintln!("Could not restore Agent CLI Hub: {error}");
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Ok(port) = hub::port() {
                bridge::grant(app, port)?;
            }
            Ok(())
        })
        .on_webview_event(bridge::on_drag_drop)
        .manage(tauri::async_runtime::Mutex::new(
            None::<std::process::Child>,
        ))
        .invoke_handler(tauri::generate_handler![connect_hub, bridge::pick_folder])
        .run(tauri::generate_context!())
        .expect("Could not run Agent CLI Hub");
}
