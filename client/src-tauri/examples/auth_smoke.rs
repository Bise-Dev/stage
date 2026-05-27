//! Manual smoke binary for the full web-exchange ceremony.
//!
//! Spins up a real LoopbackListener, prints the authorize URL for the developer
//! to open in their browser, then completes the code → token exchange against the
//! Stage backend.
//!
//! Run:
//!     cd backend && just dev    # in another terminal
//!     STAGE_GITHUB_APP_CLIENT_ID=Iv1.xxx cargo run --example auth_smoke
//!
//! Walks: PKCE → bind listener → print authorize URL → recv callback → web_exchange → auth_me → logout.
use std::time::Duration;

use stage_client_lib::api::Client;
use stage_client_lib::oauth::{authorize_url, gen_state, pkce_pair, LoopbackListener};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let backend_url =
        std::env::var("STAGE_BACKEND_URL").unwrap_or_else(|_| "http://localhost:8000".to_string());
    let client_id = std::env::var("STAGE_GITHUB_APP_CLIENT_ID")
        .expect("set STAGE_GITHUB_APP_CLIENT_ID to the dev GitHub App's Client ID");

    let api_client = Client::new(&backend_url)?;
    let (verifier, challenge) = pkce_pair();
    let state = gen_state();
    let listener = LoopbackListener::bind().await?;
    let redirect = listener.redirect_uri().to_string();
    let url = authorize_url(&client_id, &redirect, &state, &challenge);

    println!("Backend: {backend_url}");
    println!();
    println!("Open this URL in your browser to authorize Stage:");
    println!("  {url}");
    println!();
    println!("Waiting for callback on {redirect} (timeout: 5 min)…");

    let params = listener.recv(Duration::from_secs(300), &state).await?;
    println!("Received code (len={})", params.code.len());

    let session = api_client
        .web_exchange(&params.code, &verifier, &redirect)
        .await?;
    println!(
        "Signed in as @{} (Stage session: stg_…{})",
        session.user.github_login,
        &session.session_token[session.session_token.len().saturating_sub(8)..],
    );

    let me = api_client.auth_me(&session.session_token).await?;
    println!("auth_me ok: id={}, login={}", me.id, me.github_login);

    api_client.logout(&session.session_token).await?;
    println!("logout: ok");

    Ok(())
}
