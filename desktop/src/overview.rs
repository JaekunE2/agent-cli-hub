use reqwest::{Client, StatusCode};
use serde_json::Value;
use tauri::Url;

pub enum Readiness {
    Ready(String),
    Waiting(String),
    DifferentService,
}

pub async fn probe(client: &Client, endpoint: &Url, token: Option<String>, port: u16) -> Readiness {
    use Readiness::{DifferentService, Ready, Waiting};
    let response = match client.get(endpoint.clone()).send().await {
        Ok(response) => response,
        Err(error) if error.is_connect() => {
            return Waiting("Waiting for the hub HTTP server.".into())
        }
        Err(_) => return DifferentService,
    };
    if response.status() != StatusCode::UNAUTHORIZED
        || !response
            .json::<Value>()
            .await
            .is_ok_and(|body| body["error"].as_str() == Some("bad token"))
    {
        return DifferentService;
    }

    let Some(token) = token else {
        return Waiting("Could not read the hub token from .token or url.txt.".into());
    };
    let Ok(response) = client
        .get(endpoint.clone())
        .header("x-token", &token)
        .send()
        .await
    else {
        return Waiting("The hub overview did not respond in time.".into());
    };
    match response.status() {
        StatusCode::OK => {
            let Ok(body) = response.json::<Value>().await else {
                return Waiting("Invalid overview response from the hub.".into());
            };
            if body["services"]["hub"]["port"].as_u64() != Some(u64::from(port)) {
                return DifferentService;
            }
            if body["services"]["ptyHost"]["ok"].as_bool() == Some(true) {
                Ready(token)
            } else {
                Waiting("The PTY host did not become ready. Check hub/ptyhost.log.".into())
            }
        }
        StatusCode::UNAUTHORIZED => Waiting(
            "The running hub rejected the local token. Check CCD_HUB_DIR and the hub token files."
                .into(),
        ),
        status => Waiting(format!(
            "The hub overview returned HTTP {}.",
            status.as_u16()
        )),
    }
}
