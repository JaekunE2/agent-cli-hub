use crate::{backend, hub};
use reqwest::Client;
use serde_json::Value;
use std::{path::Path, process::Child};
use tauri::Url;

mod verify;

async fn request(builder: reqwest::RequestBuilder, token: &str) -> Result<Value, String> {
    let response = builder
        .header("x-token", token)
        .send()
        .await
        .map_err(|_| "The local Hub did not respond.")?;
    if !response.status().is_success() {
        return Err(format!("Hub returned HTTP {}.", response.status().as_u16()));
    }
    response
        .json()
        .await
        .map_err(|_| "Invalid Hub response.".into())
}

async fn identity(client: &Client, base: &Url, token: &str) -> Result<Value, String> {
    request(
        client.get(base.join("api/desktop/identity").unwrap()),
        token,
    )
    .await
}

pub async fn change(server: &mut Option<Child>, restart: bool) -> Result<Option<Url>, String> {
    let dir = backend::directory()?;
    let base = hub::base_url()?;
    let port = base.port_or_known_default().unwrap();
    let server_pid = check(&dir.join("server.js"), port, None).await?;
    let token = backend::token(&dir, &base).ok_or("Could not read the local Hub token.")?;
    let client = hub::client()?;
    let info = identity(&client, &base, &token).await?;
    if pid(&info["pid"])? != server_pid {
        return Err("The verified Hub process changed.".into());
    }
    let pty_pid = pid(&info["ptyPid"])?;
    let pty_port = info["ptyPort"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p > 0)
        .ok_or("Invalid PTY port.")?;
    check(&dir.join("ptyhost.js"), pty_port, Some(pty_pid)).await?;
    let result = request(
        client
            .post(base.join("api/desktop/shutdown").unwrap())
            .header("x-ccd-desktop-pid", server_pid)
            .json(&serde_json::json!({ "ptyPid": pty_pid, "stopPty": !restart })),
        &token,
    )
    .await?;
    if result["ok"].as_bool() != Some(true) {
        return Err(result["error"]
            .as_str()
            .unwrap_or("Hub refused to shut down.")
            .to_owned());
    }
    verify::wait_closed(port).await?;
    if server
        .as_ref()
        .is_some_and(|child| child.id() == server_pid)
    {
        *server = None;
    }
    if !restart {
        verify::wait_closed(pty_port).await?;
        return Ok(None);
    }
    let page = hub::connect(server, Some(pty_port)).await?;
    let new = identity(&client, &base, &token).await?;
    if pid(&new["pid"])? == server_pid || pid(&new["ptyPid"])? != pty_pid {
        return Err("The restarted Hub did not reconnect to the original PTY host.".into());
    }
    Ok(Some(page))
}

fn pid(value: &Value) -> Result<u32, String> {
    value
        .as_u64()
        .and_then(|p| u32::try_from(p).ok())
        .filter(|p| *p > 0)
        .ok_or_else(|| "The Hub process or PTY host is unavailable.".into())
}

async fn check(script: &Path, port: u16, expected: Option<u32>) -> Result<u32, String> {
    let script = script.to_owned();
    tauri::async_runtime::spawn_blocking(move || verify::process(&script, port, expected))
        .await
        .map_err(|e| format!("Could not run Windows process inspection ({e})."))?
}
