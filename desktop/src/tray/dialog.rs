use tauri::WebviewWindow;

#[cfg(windows)]
fn show(window: &WebviewWindow, message: &str, flags: u32) -> i32 {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            window: *mut std::ffi::c_void,
            text: *const u16,
            title: *const u16,
            flags: u32,
        ) -> i32;
    }
    let Ok(handle) = window.hwnd() else {
        eprintln!("Could not obtain the Hub window for a message box.");
        return 0;
    };
    let text: Vec<u16> = message.encode_utf16().chain([0]).collect();
    let title: Vec<u16> = "Agent CLI Hub".encode_utf16().chain([0]).collect();
    // The WebView window and both NUL-terminated buffers live through the call.
    unsafe { MessageBoxW(handle.0, text.as_ptr(), title.as_ptr(), flags) }
}

pub fn confirm(window: &WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        const YES_NO_WARNING_DEFAULT_NO: u32 = 0x134;
        const ID_YES: i32 = 6;
        show(window, "런처, 허브 서버, PTY 호스트를 종료할까요? 웹 접속이 끊깁니다. 실행 중인 허브 터미널이 있으면 종료를 중단합니다.", YES_NO_WARNING_DEFAULT_NO) == ID_YES
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        false
    }
}

pub fn error(window: &WebviewWindow, message: &str) {
    eprintln!("{message}");
    #[cfg(windows)]
    show(window, message, 0x10);
    #[cfg(not(windows))]
    let _ = window;
}
