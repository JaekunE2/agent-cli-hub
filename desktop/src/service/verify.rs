use std::{io::ErrorKind, path::Path, time::Duration};

#[cfg(windows)]
pub fn process(script: &Path, port: u16, expected: Option<u32>) -> Result<u32, String> {
    use std::{os::windows::process::CommandExt, process::Command};
    let system = std::env::var_os("SystemRoot").ok_or("Windows SystemRoot is unavailable.")?;
    let output =
        Command::new(Path::new(&system).join("System32/WindowsPowerShell/v1.0/powershell.exe"))
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                include_str!("../verify-process.ps1"),
            ])
            .env("CCD_VERIFY_SCRIPT", script)
            .env("CCD_VERIFY_PORT", port.to_string())
            .env("CCD_VERIFY_PID", expected.unwrap_or_default().to_string())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output()
            .map_err(|e| format!("Could not inspect port {port} ({e})."))?;
    if output.status.success() {
        if let Ok(pid) = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u32>()
        {
            if pid > 0 && expected.is_none_or(|expected| expected == pid) {
                return Ok(pid);
            }
        }
    }
    eprintln!(
        "Hub process inspection for port {port}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Err(format!(
        "Could not verify {} on port {port}.",
        script.file_name().unwrap_or_default().to_string_lossy()
    ))
}

#[cfg(not(windows))]
pub fn process(_: &Path, _: u16, _: Option<u32>) -> Result<u32, String> {
    Err("Hub process inspection requires Windows.".into())
}

pub async fn wait_closed(port: u16) -> Result<(), String> {
    let check = async {
        loop {
            match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
                Err(e) if e.kind() == ErrorKind::ConnectionRefused => return Ok(()),
                Err(e) => return Err(format!("Could not check port {port} ({e}).")),
                Ok(_) => tokio::time::sleep(Duration::from_millis(150)).await,
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(8), check)
        .await
        .map_err(|_| format!("Port {port} is still listening after shutdown."))?
}
