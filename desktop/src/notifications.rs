use std::sync::Mutex;
use tauri::{AppHandle, Manager, Url, Webview};

mod windows;

pub type Pending = Mutex<Option<String>>;

fn terminal_id(id: &str) -> bool {
    id.len() <= 16
        && id
            .parse::<u64>()
            .is_ok_and(|n| n > 0 && n.to_string() == id)
}

fn activation_id<'a>(scheme: &str, args: &'a [String]) -> Option<&'a str> {
    let [_, uri] = args else { return None };
    uri.strip_prefix(scheme)?
        .strip_prefix("://term/")
        .filter(|id| terminal_id(id))
}

pub fn activate(app: &AppHandle, args: &[String]) {
    if let Some(id) = activation_id(&app.config().identifier, args) {
        *app.state::<Pending>().lock().expect("notification lock") = Some(id.into());
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(url) = window.url() {
                deliver(window.as_ref(), &url);
            }
        }
    }
}

pub fn deliver(webview: &Webview, page: &Url) {
    let Ok(base) = crate::hub::base_url() else {
        return;
    };
    if webview.label() != "main" || page.origin() != base.origin() || page.path() != "/" {
        return;
    }
    let pending = webview.state::<Pending>();
    let mut pending = pending.lock().expect("notification lock");
    if let Some(id) = pending.as_deref() {
        let origin = serde_json::json!(base.origin().ascii_serialization());
        let script = format!(
            "if (location.origin === {origin} && location.pathname === '/') location.hash = '#term:{id}';"
        );
        match webview.eval(script) {
            Ok(()) => *pending = None,
            Err(error) => eprintln!("Could not route the notification: {error}"),
        }
    }
}

#[tauri::command]
pub fn notify_terminal(
    window: tauri::WebviewWindow,
    id: String,
    body: String,
    viewing: bool,
) -> Result<bool, String> {
    if !terminal_id(&id) || body.trim().is_empty() || body.chars().count() > 512 {
        return Err("Invalid terminal notification.".into());
    }
    // WebView2 can report a visible document while the native window is hidden.
    if viewing && window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        return Ok(true);
    }
    windows::show(&window.config().identifier, &id, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_accepts_a_single_terminal_destination() {
        let parse =
            |uri: &str| activation_id("ach-test", &["exe".into(), uri.into()]).map(str::to_owned);
        assert_eq!(parse("ach-test://term/27").as_deref(), Some("27"));
        for uri in [
            "other://term/27",
            "ach-test://projects/27",
            "ach-test://term/0",
            "ach-test://term/027",
            "ach-test://term/+27",
            "ach-test://term/27?x",
            "ach-test://term/27#home",
            "ach-test://term/27/28",
            "ach-test://term/%32",
        ] {
            assert_eq!(parse(uri), None, "{uri}");
        }
        assert_eq!(
            activation_id(
                "ach-test",
                &["exe", "ach-test://term/27", "--extra"].map(str::to_owned)
            ),
            None
        );
    }
}
