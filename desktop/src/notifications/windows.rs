#[cfg(windows)]
pub fn show(app_id: &str, id: &str, body: &str) -> Result<bool, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows::{
        core::{HSTRING, PCWSTR, PWSTR},
        Data::Xml::Dom::XmlDocument,
        Win32::UI::Shell::{AssocQueryStringW, ASSOCF_IS_PROTOCOL, ASSOCSTR_EXECUTABLE},
        UI::Notifications::{ToastNotification, ToastNotificationManager},
    };

    let app_id = HSTRING::from(app_id);
    let mut command = [0u16; 32768];
    let mut len = command.len() as u32;
    // Only use protocol activation when Windows would launch this installed executable.
    let found = unsafe {
        AssocQueryStringW(
            ASSOCF_IS_PROTOCOL,
            ASSOCSTR_EXECUTABLE,
            &app_id,
            PCWSTR::null(),
            Some(PWSTR(command.as_mut_ptr())),
            &mut len,
        )
    };
    if found.is_err() || len <= 1 || len as usize > command.len() {
        return Ok(false);
    }
    let handler = std::ffi::OsString::from_wide(&command[..len as usize - 1]);
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    if !std::fs::canonicalize(handler)
        .is_ok_and(|path| path == current.canonicalize().unwrap_or(current))
    {
        return Ok(false);
    }

    let result = (|| {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(format!(
            r#"<toast activationType="protocol" launch="{app_id}://term/{id}"><visual><binding template="ToastGeneric"><text>Agent CLI Hub</text><text/></binding></visual></toast>"#
        )))?;
        xml.GetElementsByTagName(&HSTRING::from("text"))?
            .Item(1)?
            .SetInnerText(&HSTRING::from(body))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        ToastNotificationManager::CreateToastNotifierWithId(&app_id)?.Show(&toast)
    })();
    result
        .map(|()| true)
        .map_err(|error| format!("Could not show the Windows notification: {error}"))
}

#[cfg(not(windows))]
pub fn show(_app_id: &str, _id: &str, _body: &str) -> Result<bool, String> {
    Ok(false)
}
