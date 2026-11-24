#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod bridge;
mod hub;
mod notifications;
mod overview;
mod service;
mod tray;

type Server = tauri::async_runtime::Mutex<Option<std::process::Child>>;

#[tauri::command]
async fn connect_hub(
    window: tauri::WebviewWindow,
    server: tauri::State<'_, Server>,
) -> Result<(), String> {
    let mut server = server
        .try_lock()
        .map_err(|_| "A connection attempt is already running.")?;
    let url = hub::connect(&mut server, None).await?;
    window
        .navigate(url)
        .map_err(|_| "Could not open the hub dashboard.".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            notifications::activate(app, &args);
            tray::restore(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(Server::default())
        .manage(notifications::Pending::default())
        .setup(|app| {
            notifications::activate(app.handle(), &std::env::args().collect::<Vec<_>>());
            if let Ok(port) = hub::port() {
                bridge::grant(app, port)?;
            }
            tray::install(app.handle())?;
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                notifications::deliver(webview, payload.url());
            }
        })
        .on_webview_event(bridge::on_drag_drop)
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("Could not hide the hub window: {error}");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            connect_hub,
            bridge::pick_folder,
            notifications::notify_terminal
        ])
        .run(tauri::generate_context!())
        .expect("Could not run Agent CLI Hub");
}
