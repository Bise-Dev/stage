//! Manual smoke binary for the api::Client web-exchange flow.
//!
//! Run with the Stage backend up locally:
//!     cd backend && just dev      # in another terminal
//!     cd client/src-tauri && cargo run --example auth_smoke
//!
//! Override the URL via env var:
//!     STAGE_BACKEND_URL=http://other:9000 cargo run --example auth_smoke
//!
//! Walks: web_exchange → auth_me → logout.
//! Provide CODE, CODE_VERIFIER, and REDIRECT_URI via env vars.

use stage_client_lib::api::Client;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("STAGE_BACKEND_URL")
        .unwrap_or_else(|_| "http://localhost:8000".to_string());
    let code = std::env::var("CODE").expect("CODE env var required");
    let code_verifier = std::env::var("CODE_VERIFIER").expect("CODE_VERIFIER env var required");
    let redirect_uri =
        std::env::var("REDIRECT_URI").unwrap_or_else(|_| "http://127.0.0.1:1234/cb".to_string());
    println!("backend: {url}");

    let client = Client::new(&url)?;
    let session = client.web_exchange(&code, &code_verifier, &redirect_uri).await?;
    println!(
        "Authorized! user={} (token len={})",
        session.user.github_login,
        session.session_token.len()
    );

    let me = client.auth_me(&session.session_token).await?;
    println!("auth_me: id={}, login={}", me.id, me.github_login);

    client.logout(&session.session_token).await?;
    println!("logout: ok");

    Ok(())
}
