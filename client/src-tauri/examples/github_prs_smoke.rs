//! Manual smoke binary for the api::Client::github_prs method.
//!
//! Run with the Stage backend up locally and after walking the device flow
//! via the auth_smoke binary (or by capturing a stg_… token however you
//! like). Pass the token as the first argument or via STAGE_TOKEN.
//!
//!     cd backend && just dev    # in another terminal
//!     cd client/src-tauri
//!     STAGE_TOKEN=stg_... cargo run --example github_prs_smoke
//!     # or
//!     cargo run --example github_prs_smoke -- stg_...
//!
//! Override the URL via env var:
//!     STAGE_BACKEND_URL=http://other:9000 cargo run --example github_prs_smoke

use stage_client_lib::api::Client;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url =
        std::env::var("STAGE_BACKEND_URL").unwrap_or_else(|_| "http://localhost:8000".to_string());
    let token = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("STAGE_TOKEN").ok())
        .ok_or("pass token as arg or set STAGE_TOKEN")?;
    println!("backend: {url}");

    let client = Client::new(&url)?;
    let prs = client.github_prs(&token, "author").await?;
    println!(
        "\n{} open PR(s) authored by you (not in Stage):\n",
        prs.len()
    );
    for pr in &prs {
        let repo = pr
            .repository_url
            .rsplit_once("/repos/")
            .map(|(_, r)| r)
            .unwrap_or("?");
        println!(
            "  {repo} #{n} · {title}  (updated {ts}, by @{login})",
            n = pr.number,
            title = pr.title,
            ts = pr.updated_at,
            login = pr.user.login
        );
    }
    Ok(())
}
