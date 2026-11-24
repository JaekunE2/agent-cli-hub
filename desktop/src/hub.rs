use crate::{backend, overview};
use reqwest::Client;
use std::{
    env,
    io::ErrorKind,
    net::{Ipv4Addr, SocketAddr},
    process::Child,
    time::{Duration, Instant},
};
use tauri::Url;
use tokio::{net::TcpStream, time::timeout};

pub fn base_url() -> Result<Url, String> {
    let port = env::var("CCD_PORT")
        .unwrap_or_else(|_| "7777".into())
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or("CCD_PORT must be between 1 and 65535.")?;
    Ok(Url::parse(&format!("http://127.0.0.1:{port}/")).expect("valid loopback URL"))
}

pub fn client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|_| "Could not configure the loopback connection.".into())
}

pub async fn connect(server: &mut Option<Child>, pty_port: Option<u16>) -> Result<Url, String> {
    let dir = backend::directory()?;
    let mut page = base_url()?;
    let port = page.port_or_known_default().expect("HTTP port");
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let endpoint = page.join("api/overview").expect("valid overview URL");
    let client = client()?;
    let collision = format!("Port {port} is in use but did not respond as Agent CLI Hub.");
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut pending = "The hub HTTP server did not become ready.".to_owned();

    while Instant::now() < deadline {
        // Windows can report a closed loopback port just after two seconds.
        let connection = timeout(Duration::from_secs(4), TcpStream::connect(address))
            .await
            .map_err(|_| format!("Connection to {address} timed out."))?;
        match connection {
            Err(error) if error.kind() == ErrorKind::ConnectionRefused => {
                if let Some(child) = server {
                    if let Some(status) = child
                        .try_wait()
                        .map_err(|e| format!("Could not check Node.js ({e})."))?
                    {
                        *server = None;
                        return Err(format!("Node.js exited before the hub was ready ({status}). Check that Node supports --use-system-ca and hub dependencies are installed."));
                    }
                } else {
                    *server = Some(backend::start(&dir, port, pty_port)?);
                }
            }
            Err(error) => return Err(format!("Could not connect to {address} ({error}).")),
            Ok(_) => {
                let token = backend::token(&dir, &page);
                match overview::probe(&client, &endpoint, token, port).await {
                    overview::Readiness::Ready(token) => {
                        page.query_pairs_mut().append_pair("t", &token);
                        return Ok(page);
                    }
                    overview::Readiness::Waiting(reason) => pending = reason,
                    overview::Readiness::DifferentService => return Err(collision),
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(pending)
}
