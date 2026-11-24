use crate::{hub, service, Server};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow,
};

mod dialog;

pub fn restore(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        for result in [window.show(), window.unminimize(), window.set_focus()] {
            if let Err(error) = result {
                eprintln!("Could not restore Agent CLI Hub: {error}");
            }
        }
    }
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "허브 열기", true, None::<&str>)?;
    let terminal = MenuItem::with_id(app, "terminal", "새 터미널", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "허브 서버 재시작", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "런처만 종료 (세션 유지)", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "전체 종료…", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &terminal, &restart, &exit, &stop])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Agent CLI Hub")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                restore(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => restore(app),
            "terminal" => new_terminal(app),
            "restart" => change(app, true),
            "exit" => {
                if app.state::<Server>().try_lock().is_ok() {
                    app.exit(0);
                }
            }
            "stop" => {
                restore(app);
                if let Some(window) = app.get_webview_window("main") {
                    if dialog::confirm(&window) {
                        change(app, false);
                    }
                }
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn is_dashboard(window: &WebviewWindow) -> bool {
    window
        .url()
        .ok()
        .zip(hub::base_url().ok())
        .is_some_and(|(page, base)| page.origin() == base.origin() && page.path() == "/")
}

fn new_terminal(app: &AppHandle) {
    restore(app);
    if let Some(window) = app.get_webview_window("main") {
        if !is_dashboard(&window) {
            dialog::error(
                &window,
                "허브 연결이 완료된 뒤 새 터미널을 다시 선택하세요.",
            );
        } else if let Err(error) = window.eval("document.getElementById('btnSideNew')?.click()") {
            dialog::error(
                &window,
                &format!("새 터미널 화면을 열 수 없습니다. {error}"),
            );
        }
    }
}

fn change(app: &AppHandle, restart: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Server>();
        let result = match state.try_lock() {
            Ok(mut server) => service::change(&mut server, restart).await,
            Err(_) => Err("이미 허브 연결 또는 종료 작업이 진행 중입니다.".into()),
        };
        if matches!(result, Ok(None)) {
            app.exit(0);
            return;
        }
        let ui = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if let Some(window) = ui.get_webview_window("main") {
                match result {
                    Ok(Some(page)) if !is_dashboard(&window) => {
                        if let Err(error) = window.navigate(page) {
                            dialog::error(&window, &format!("허브 화면을 열 수 없습니다. {error}"));
                        }
                    }
                    Err(error) => {
                        restore(&ui);
                        dialog::error(&window, &error);
                    }
                    _ => {}
                }
            }
        }) {
            eprintln!("Could not report the Hub action: {error}");
        }
    });
}
