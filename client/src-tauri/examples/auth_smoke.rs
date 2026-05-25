//! Manual smoke binary for the api::Client device-flow.
//!
//! Run with the Stage backend up locally:
//!     cd backend && just dev      # in another terminal
//!     cd client/src-tauri && cargo run --example auth_smoke
//!
//! Override the URL via env var:
//!     STAGE_BACKEND_URL=http://other:9000 cargo run --example auth_smoke
//!
//! Walks: device_start → poll loop → auth_me → logout.

use std::time::{Duration, Instant};

use stage_client_lib::api::{Client, DevicePollOutcome};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("STAGE_BACKEND_URL")
        .unwrap_or_else(|_| "http://localhost:8000".to_string());
    println!("backend: {url}");

    let client = Client::new(&url)?;
    let device = client.device_start().await?;
    println!(
        "\nOpen: {}\nEnter code: {}\n(interval={}s, expires_in={}s)\n",
        device.verification_uri, device.user_code, device.interval, device.expires_in
    );

    let deadline = Instant::now() + Duration::from_secs(device.expires_in);
    let mut interval = Duration::from_secs(device.interval);

    let session = loop {
        if Instant::now() > deadline {
            return Err("client deadline exceeded".into());
        }
        match client.device_poll(&device.device_code).await? {
            DevicePollOutcome::Pending => {
                print!(".");
            }
            DevicePollOutcome::SlowDown => {
                println!("(slow_down — bumping interval)");
                interval += Duration::from_secs(5);
            }
            DevicePollOutcome::Authorized(s) => break s,
            DevicePollOutcome::Expired => return Err("device_code expired".into()),
            DevicePollOutcome::Denied => return Err("user denied".into()),
            _ => {}
        }
        tokio::time::sleep(interval).await;
        if Instant::now() > deadline {
            return Err("client deadline exceeded".into());
        }
    };

    println!(
        "\nAuthorized! user={} (token len={})",
        session.user.github_login,
        session.session_token.len()
    );

    let me = client.auth_me(&session.session_token).await?;
    println!("auth_me: id={}, login={}", me.id, me.github_login);

    client.logout(&session.session_token).await?;
    println!("logout: ok");

    Ok(())
}
