# Tauri Auth Wiring + Minimal GitHub PR List — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing Stage client SDK (`client/src-tauri/src/api/`) to the Tauri webview so the github device flow runs end-to-end, then add a minimal "My GitHub PRs" section in WorkspaceScaffold.

**Architecture:** SDK and backend stay unchanged. Five Tauri commands expose the SDK to the webview; `AppState` gains `api::Client` + `Mutex<Option<AuthSession>>`. React owns the device-flow poll loop via an `AbortController`. Session token lives only in Rust AppState (memory-only this PR).

**Tech Stack:** Rust + Tauri 2 + reqwest + wiremock (tests); React 19 + TypeScript + Vite; Biome (format/lint); cargo fmt + clippy + cargo test.

**Spec:** `docs/superpowers/specs/2026-05-25-tauri-auth-and-github-prs-design.md`

**Branch:** `feat/tauri-auth-and-github-prs`

---

## File structure map

| Path | Status | Responsibility |
|---|---|---|
| `client/src-tauri/src/api/types.rs` | modify | Add `GithubPrSearchItem`, `GithubUserRef` DTOs. |
| `client/src-tauri/src/api/github.rs` | create | `Client::github_prs(&token, &role) -> Vec<GithubPrSearchItem>`. |
| `client/src-tauri/src/api/mod.rs` | modify | Register `mod github;`, re-export DTOs. |
| `client/src-tauri/src/errors.rs` | modify | Add `NotAuthenticated` + `Backend(String)` variants + `From<api::Error>`. |
| `client/src-tauri/src/state.rs` | modify | Add `api: api::Client`, `auth: Mutex<Option<AuthSession>>` fields, `AuthSession` struct, `require_token` helper. |
| `client/src-tauri/src/commands.rs` | modify | Add 5 new commands + `AuthPollResult` webview-facing enum. |
| `client/src-tauri/src/lib.rs` | modify | Read backend URL from `tauri.conf.json` plugins map, construct `api::Client`, manage AppState, register `tauri-plugin-opener`, register new commands. |
| `client/src-tauri/Cargo.toml` | modify | Add `tauri-plugin-opener = "2"`. |
| `client/src-tauri/tauri.conf.json` | modify | Add `plugins.stage.backendUrl` field. |
| `client/src-tauri/examples/github_prs_smoke.rs` | create | Manual smoke binary mirroring `auth_smoke.rs`. |
| `client/package.json` | modify | Add `@tauri-apps/plugin-opener` JS dep. |
| `client/src/tauri.ts` | modify | Typed wrappers for the 5 new commands. |
| `client/src/lib/auth.ts` | create | Pure `runDeviceFlow` orchestrator (poll loop, deadline, AbortSignal). |
| `client/src/screens/onboarding/SignIn.tsx` | rewrite content | Real device-flow flow + pending/error states. |
| `client/src/screens/onboarding/OpenRepository.tsx` | modify | Drop `onBack` prop + the "Back" button. |
| `client/src/screens/workspace/WorkspaceScaffold.tsx` | modify | New `user` + `onLogout` props; header + PR section + logout button. |
| `client/src/App.tsx` | modify | Drop `onboardingFlag` gating; flow `signIn → openRepo → workspace`. |
| `client/src/lib/onboardingFlag.ts` | delete | Orphan after App.tsx change. |

`tauri-plugin-store` (Rust + JS) is **kept** even though `onboardingFlag.ts` is its only current consumer — `STACK.md` documents it for upcoming flag-store needs. Don't remove.

---

## Conventions

- Run all `cargo` commands from `client/src-tauri/`.
- Run all `bun` commands from `client/`.
- After every Rust task: `cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test`.
- After every TypeScript task: `bun run lint && bun run typecheck`.
- Commit after each task. One commit per task unless a step explicitly says otherwise.
- Commit messages: `<type>(<scope>): <subject>` — `feat`, `fix`, `test`, `refactor`, `docs`, `chore`. Same style as `git log --oneline`.
- Never use `--no-verify` or skip pre-commit hooks. If a hook fails, fix the root cause.

---

## Task 1: Add `GithubPrSearchItem` + `GithubUserRef` DTOs

**Files:**
- Modify: `client/src-tauri/src/api/types.rs`
- Modify: `client/src-tauri/src/api/mod.rs`

- [ ] **Step 1: Write the failing test**

Append to the `#[cfg(test)] mod tests` block at the bottom of `client/src-tauri/src/api/types.rs`:

```rust
#[test]
fn github_pr_search_item_deserializes_from_raw_github_shape() {
    // Mirrors the actual github search-issues response items the backend
    // forwards unchanged at GET /api/v1/github/prs/.
    let json = serde_json::json!({
        "number": 483,
        "title": "Rewrite README onboarding section",
        "html_url": "https://github.com/acme/payments/pull/483",
        "repository_url": "https://api.github.com/repos/acme/payments",
        "updated_at": "2026-05-23T07:00:00Z",
        "user": {
            "login": "octocat",
            "avatar_url": "https://avatars.example/o"
        },
        // Extra github-search keys we don't care about; the deserializer
        // must ignore them.
        "state": "open",
        "labels": []
    });
    let item: GithubPrSearchItem = serde_json::from_value(json).unwrap();
    assert_eq!(item.number, 483);
    assert_eq!(item.title, "Rewrite README onboarding section");
    assert_eq!(item.repository_url, "https://api.github.com/repos/acme/payments");
    assert_eq!(item.user.login, "octocat");
    assert_eq!(item.user.avatar_url.as_deref(), Some("https://avatars.example/o"));
}

#[test]
fn github_user_ref_deserializes_with_null_avatar() {
    let json = serde_json::json!({ "login": "ghost", "avatar_url": null });
    let u: GithubUserRef = serde_json::from_value(json).unwrap();
    assert_eq!(u.login, "ghost");
    assert!(u.avatar_url.is_none());
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd client/src-tauri
cargo test --lib api::types::tests::github_pr_search_item_deserializes_from_raw_github_shape 2>&1 | tail -5
```

Expected: build fails with `cannot find type GithubPrSearchItem` (or similar).

- [ ] **Step 3: Add struct definitions**

Insert at the bottom of `client/src-tauri/src/api/types.rs`, just above the `#[cfg(test)]` block:

```rust
/// Raw github search-issues item, forwarded unchanged by the backend's
/// thin github proxy at `GET /api/v1/github/prs/`. Only the fields the
/// client renders are deserialized; unknown keys are tolerated.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct GithubPrSearchItem {
    pub number: i64,
    pub title: String,
    pub html_url: String,
    pub repository_url: String,
    pub updated_at: String,
    pub user: GithubUserRef,
}

/// Nested github user reference (just `login` + optional `avatar_url`).
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct GithubUserRef {
    pub login: String,
    pub avatar_url: Option<String>,
}
```

- [ ] **Step 4: Re-export from `api/mod.rs`**

Edit `client/src-tauri/src/api/mod.rs` line 12 from:

```rust
pub use types::{DeviceCode, DevicePollOutcome, SessionData, User};
```

to:

```rust
pub use types::{DeviceCode, DevicePollOutcome, GithubPrSearchItem, GithubUserRef, SessionData, User};
```

- [ ] **Step 5: Run tests to verify pass**

```bash
cd client/src-tauri
cargo test --lib api::types 2>&1 | tail -10
```

Expected: all tests in `api::types` pass (including the two new ones).

- [ ] **Step 6: Format + lint**

```bash
cd client/src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5
```

Expected: no warnings.

- [ ] **Step 7: Commit**

```bash
cd /Users/ybouzonie/perso/stage
git add client/src-tauri/src/api/types.rs client/src-tauri/src/api/mod.rs
git commit -m "feat(client/api): add GithubPrSearchItem + GithubUserRef DTOs"
```

---

## Task 2: Implement `Client::github_prs` SDK method

**Files:**
- Create: `client/src-tauri/src/api/github.rs`
- Modify: `client/src-tauri/src/api/mod.rs`

- [ ] **Step 1: Register the new module**

Edit `client/src-tauri/src/api/mod.rs`, change the module list near the top to include `github`:

```rust
mod auth;
mod client;
mod error;
mod github;
mod types;
```

- [ ] **Step 2: Write the first failing test (happy path)**

Create `client/src-tauri/src/api/github.rs` with this initial content (skeleton + first test):

```rust
use super::client::Client;
use super::error::Error;
use super::types::GithubPrSearchItem;

impl Client {
    /// `GET /api/v1/github/prs/?role=<role>` — list authed user's open PRs
    /// (the backend cross-filters out PRs that already have a Stage workspace).
    /// Returns the raw github search-issue items unchanged.
    pub async fn github_prs(
        &self,
        token: &str,
        role: &str,
    ) -> Result<Vec<GithubPrSearchItem>, Error> {
        let mut url = self.base_url.join("api/v1/github/prs/").unwrap();
        url.query_pairs_mut().append_pair("role", role);
        tracing::debug!(url = %url, "GET github/prs");
        let resp = self.http.get(url).bearer_auth(token).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let err = Self::map_error(resp).await;
            tracing::warn!(err = %err, "github_prs non-2xx");
            return Err(err);
        }
        #[derive(serde::Deserialize)]
        struct Envelope {
            items: Vec<GithubPrSearchItem>,
        }
        let body: Envelope = resp.json().await.map_err(|e| Self::json_err(status, e))?;
        Ok(body.items)
    }
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{header, header_exists, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::super::client::Client;
    use super::super::error::Error;

    #[tokio::test]
    async fn github_prs_ok_returns_items() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .and(query_param("role", "author"))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [{
                    "number": 482,
                    "title": "Replace legacy checkout",
                    "html_url": "https://github.com/acme/payments/pull/482",
                    "repository_url": "https://api.github.com/repos/acme/payments",
                    "updated_at": "2026-05-23T07:00:00Z",
                    "user": { "login": "octocat", "avatar_url": null }
                }],
                "count": 1
            })))
            .mount(&server)
            .await;

        let client = Client::new(server.uri()).unwrap();
        let prs = client.github_prs("stg_abc", "author").await.unwrap();
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 482);
        assert_eq!(prs[0].title, "Replace legacy checkout");
        assert_eq!(prs[0].user.login, "octocat");
    }
}
```

- [ ] **Step 3: Run the first test**

```bash
cd client/src-tauri
cargo test --lib api::github::tests::github_prs_ok_returns_items 2>&1 | tail -10
```

Expected: PASS. The implementation is already in place to make it pass; this confirms the module compiles, the wiremock pattern works, and the happy path is covered.

- [ ] **Step 4: Add empty-list test**

Append to the `tests` block in `client/src-tauri/src/api/github.rs`:

```rust
    #[tokio::test]
    async fn github_prs_empty_list() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [],
                "count": 0
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let prs = client.github_prs("stg_abc", "author").await.unwrap();
        assert!(prs.is_empty());
    }
```

- [ ] **Step 5: Add 401 unauthenticated test**

Append:

```rust
    #[tokio::test]
    async fn github_prs_401_maps_to_unauthenticated() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "message": "unauthenticated",
                "extra": {}
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.github_prs("stg_bad", "author").await.unwrap_err();
        assert!(matches!(err, Error::Unauthenticated), "got {err:?}");
    }
```

- [ ] **Step 6: Add 500 unexpected test**

Append:

```rust
    #[tokio::test]
    async fn github_prs_500_maps_to_unexpected() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .respond_with(ResponseTemplate::new(500).set_body_string("internal"))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.github_prs("stg_abc", "author").await.unwrap_err();
        match err {
            Error::Unexpected { status, .. } => assert_eq!(status.as_u16(), 500),
            other => panic!("expected Unexpected, got {other:?}"),
        }
    }
```

- [ ] **Step 7: Add bad-body-on-200 test**

Append:

```rust
    #[tokio::test]
    async fn github_prs_200_with_bad_body_maps_to_unexpected() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json at all"))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.github_prs("stg_abc", "author").await.unwrap_err();
        assert!(
            matches!(&err, Error::Unexpected { status, .. } if status.as_u16() == 200),
            "got {err:?}"
        );
    }
```

- [ ] **Step 8: Add bearer header exactness test**

Append:

```rust
    #[tokio::test]
    async fn github_prs_bearer_header_value_exact() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .and(header("authorization", "Bearer stg_abc123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [],
                "count": 0
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        client.github_prs("stg_abc123", "author").await.unwrap();
    }
```

- [ ] **Step 9: Add role query param test**

Append:

```rust
    #[tokio::test]
    async fn github_prs_role_query_param_honored() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .and(query_param("role", "reviewer"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [],
                "count": 0
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        client.github_prs("stg_abc", "reviewer").await.unwrap();
    }
```

- [ ] **Step 10: Run the full github test module**

```bash
cd client/src-tauri
cargo test --lib api::github 2>&1 | tail -10
```

Expected: 6 tests pass.

- [ ] **Step 11: Format + lint + commit**

```bash
cd client/src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5

cd /Users/ybouzonie/perso/stage
git add client/src-tauri/src/api/github.rs client/src-tauri/src/api/mod.rs
git commit -m "feat(client/api): add Client::github_prs SDK method"
```

---

## Task 3: Smoke binary `examples/github_prs_smoke.rs`

**Files:**
- Create: `client/src-tauri/examples/github_prs_smoke.rs`

- [ ] **Step 1: Write the binary**

Create `client/src-tauri/examples/github_prs_smoke.rs`:

```rust
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
    let url = std::env::var("STAGE_BACKEND_URL")
        .unwrap_or_else(|_| "http://localhost:8000".to_string());
    let token = std::env::args().nth(1).or_else(|| std::env::var("STAGE_TOKEN").ok())
        .ok_or("pass token as arg or set STAGE_TOKEN")?;
    println!("backend: {url}");

    let client = Client::new(&url)?;
    let prs = client.github_prs(&token, "author").await?;
    println!("\n{} open PR(s) authored by you (not in Stage):\n", prs.len());
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
```

- [ ] **Step 2: Confirm it compiles**

```bash
cd client/src-tauri
cargo build --example github_prs_smoke 2>&1 | tail -5
```

Expected: clean build (no run).

- [ ] **Step 3: Lint + commit**

```bash
cd client/src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5

cd /Users/ybouzonie/perso/stage
git add client/src-tauri/examples/github_prs_smoke.rs
git commit -m "test(client/api): add github_prs smoke binary"
```

---

## Task 4: Add `AppError::NotAuthenticated` + `Backend` + `From<api::Error>`

**Files:**
- Modify: `client/src-tauri/src/errors.rs`

- [ ] **Step 1: Write the failing test**

Append a `#[cfg(test)]` block to `client/src-tauri/src/errors.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::api;

    #[test]
    fn from_api_unauthenticated_becomes_not_authenticated() {
        let e: AppError = api::Error::Unauthenticated.into();
        assert!(matches!(e, AppError::NotAuthenticated), "got {e:?}");
    }

    #[test]
    fn from_api_invalid_base_url_becomes_backend() {
        let e: AppError = api::Error::InvalidBaseUrl("nope".to_string()).into();
        match e {
            AppError::Backend(s) => assert!(s.contains("invalid base url"), "{s}"),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn from_api_unexpected_becomes_backend_with_status_message() {
        let e: AppError = api::Error::Unexpected {
            status: reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            message: "boom".to_string(),
            extra: serde_json::Value::Null,
        }
        .into();
        match e {
            AppError::Backend(s) => {
                assert!(s.contains("500"), "{s}");
                assert!(s.contains("boom"), "{s}");
            }
            other => panic!("got {other:?}"),
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd client/src-tauri
cargo test --lib errors 2>&1 | tail -10
```

Expected: build fails — `NotAuthenticated` / `Backend` / `From<api::Error>` not defined.

- [ ] **Step 3: Add the variants + From impl**

Replace the `AppError` enum definition and the `serde::Serialize` impl in `client/src-tauri/src/errors.rs` with:

```rust
use std::path::PathBuf;

use thiserror::Error;

use crate::api;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("no active repo")]
    NoActiveRepo,
    #[error("not a git repository: {}", .0.display())]
    NotARepo(PathBuf),
    #[error("git: {0}")]
    Git(#[from] git2::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("watcher: {0}")]
    Watcher(String),
    #[error("not authenticated")]
    NotAuthenticated,
    #[error("backend: {0}")]
    Backend(String),
}

impl From<api::Error> for AppError {
    fn from(e: api::Error) -> Self {
        match e {
            api::Error::Unauthenticated => AppError::NotAuthenticated,
            api::Error::Transport(re) => AppError::Backend(format!("transport: {re}")),
            api::Error::InvalidBaseUrl(s) => AppError::Backend(format!("invalid base url: {s}")),
            api::Error::Validation { extra } => AppError::Backend(format!("validation: {extra}")),
            api::Error::Github { status, extra } => {
                AppError::Backend(format!("github {status}: {extra}"))
            }
            api::Error::Unexpected { status, message, .. } => {
                AppError::Backend(format!("backend {status}: {message}"))
            }
        }
    }
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd client/src-tauri
cargo test --lib errors 2>&1 | tail -10
```

Expected: 3 tests pass.

- [ ] **Step 5: Format + lint + commit**

```bash
cd client/src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5

cd /Users/ybouzonie/perso/stage
git add client/src-tauri/src/errors.rs
git commit -m "feat(client/errors): map api::Error to AppError + NotAuthenticated"
```

---

## Task 5: Add `AuthSession` to AppState + wire backend URL from tauri.conf.json

**Files:**
- Modify: `client/src-tauri/src/state.rs`
- Modify: `client/src-tauri/tauri.conf.json`
- Modify: `client/src-tauri/src/lib.rs`

- [ ] **Step 1: Update `state.rs` with new fields + helper**

Replace `client/src-tauri/src/state.rs` content with:

```rust
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::api;
use crate::errors::AppError;
use crate::recents::RecentsStore;
use crate::watcher::WatcherHandle;

pub struct AppState {
    pub active: Mutex<Option<ActiveRepo>>,
    pub recents: Arc<RecentsStore>,
    pub api: api::Client,
    pub auth: Mutex<Option<AuthSession>>,
}

pub struct ActiveRepo {
    pub path: PathBuf,
    #[allow(dead_code)]
    pub watcher: WatcherHandle,
}

pub struct AuthSession {
    pub token: String,
    pub user: api::User,
}

impl AppState {
    /// Returns a clone of the current session token, or `NotAuthenticated`
    /// if the user is not signed in. Locks briefly, never across `.await`.
    pub fn require_token(&self) -> Result<String, AppError> {
        self.auth
            .lock()
            .as_ref()
            .map(|a| a.token.clone())
            .ok_or(AppError::NotAuthenticated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_app_state_no_auth() -> AppState {
        AppState {
            active: Mutex::new(None),
            recents: Arc::new(RecentsStore::for_testing()),
            api: api::Client::new("http://localhost:8000").unwrap(),
            auth: Mutex::new(None),
        }
    }

    #[test]
    fn require_token_none_returns_not_authenticated() {
        let s = make_app_state_no_auth();
        let err = s.require_token().unwrap_err();
        assert!(matches!(err, AppError::NotAuthenticated), "got {err:?}");
    }

    #[test]
    fn require_token_some_returns_clone() {
        let s = make_app_state_no_auth();
        *s.auth.lock() = Some(AuthSession {
            token: "stg_xyz".to_string(),
            user: api::User {
                id: 1,
                github_login: "u".to_string(),
                github_user_id: 1,
                display_name: None,
                avatar_url: None,
            },
        });
        let tok = s.require_token().unwrap();
        assert_eq!(tok, "stg_xyz");
        // Lock is released, internal state still present.
        assert!(s.auth.lock().is_some());
    }
}
```

> Note on `RecentsStore::for_testing()`: if it doesn't already exist, the test currently won't compile. Inspect `client/src-tauri/src/recents.rs` first. If there's no in-memory constructor, add one **only if it's a 2-3 line cfg(test) helper**; otherwise drop the two `state.rs` tests for this task and rely on cargo check + the integration smoke. The point of the helper here is the type — not the tests. Commit message should reflect what was actually done.

- [ ] **Step 2: Add `plugins.stage.backendUrl` to tauri.conf.json**

Edit `client/src-tauri/tauri.conf.json`. After the existing `"bundle"` block (line 33), add a comma and a new `"plugins"` block:

```json
  "bundle": {
    "active": false,
    "targets": "all"
  },
  "plugins": {
    "stage": {
      "backendUrl": "http://localhost:8000"
    }
  }
}
```

(That is: change the closing `},` after `"targets": "all"` to add the `plugins` entry before the outer `}`.)

- [ ] **Step 3: Wire AppState construction in `lib.rs`**

Edit `client/src-tauri/src/lib.rs`. In the `.setup(|app| { ... })` block, after `let recents = RecentsStore::open(&data_dir)?;`, add:

```rust
            // Read backend URL from tauri.conf.json -> plugins.stage.backendUrl.
            // PluginConfig wraps a HashMap<String, JsonValue>; access via the
            // public `.0` field. Fall back to localhost for the dev loop.
            let backend_url = app
                .config()
                .plugins
                .0
                .get("stage")
                .and_then(|v| v.get("backendUrl"))
                .and_then(|v| v.as_str())
                .unwrap_or("http://localhost:8000")
                .to_string();
            let api = api::Client::new(&backend_url)
                .map_err(|e| std::io::Error::other(format!("api client: {e}")))?;
            tracing::info!(backend_url = %backend_url, "api client initialized");

            app.manage(AppState {
                active: Mutex::new(None),
                recents: Arc::new(recents),
                api,
                auth: Mutex::new(None),
            });
            Ok(())
```

Replace the existing `app.manage(AppState { active: ..., recents: ... });` block with the new one above. Also import `crate::api;` near the existing imports.

> If the executor finds that `.plugins.0.get(...)` does not compile because `PluginConfig` doesn't expose its inner field publicly in the version pinned by `Cargo.toml`, fall back to serde:
>
> ```rust
> let plugins_json =
>     serde_json::to_value(&app.config().plugins).unwrap_or(serde_json::Value::Null);
> let backend_url = plugins_json
>     .get("stage")
>     .and_then(|v| v.get("backendUrl"))
>     .and_then(|v| v.as_str())
>     .unwrap_or("http://localhost:8000")
>     .to_string();
> ```

- [ ] **Step 4: Run cargo check + tests**

```bash
cd client/src-tauri
cargo check --all-targets 2>&1 | tail -5
cargo test --lib state 2>&1 | tail -10
```

Expected: clean check; tests pass (or are skipped per the note in Step 1).

- [ ] **Step 5: Format + lint + commit**

```bash
cd client/src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5

cd /Users/ybouzonie/perso/stage
git add client/src-tauri/src/state.rs client/src-tauri/src/lib.rs client/src-tauri/tauri.conf.json
git commit -m "feat(client/state): manage api::Client + AuthSession in AppState"
```

---

## Task 6: Add `tauri-plugin-opener` (Rust + JS)

**Files:**
- Modify: `client/src-tauri/Cargo.toml`
- Modify: `client/src-tauri/src/lib.rs`
- Modify: `client/package.json`

- [ ] **Step 1: Look up the latest tauri-plugin-opener version compatible with Tauri 2**

```bash
cd client/src-tauri
cargo search tauri-plugin-opener --limit 1
```

Note the version printed. Pin to that exact minor (e.g. `"2"` is fine since Tauri's plugin crates use loose major-only deps and follow the framework cadence).

- [ ] **Step 2: Add Rust dep**

Edit `client/src-tauri/Cargo.toml`. In the `[dependencies]` block, after `tauri-plugin-store = "2"`, add:

```toml
tauri-plugin-opener = "2"
```

- [ ] **Step 3: Register the plugin in lib.rs**

In `client/src-tauri/src/lib.rs::run`, in the `tauri::Builder::default()` chain, after `.plugin(tauri_plugin_store::Builder::new().build())`, add:

```rust
        .plugin(tauri_plugin_opener::init())
```

- [ ] **Step 4: Add JS dep**

Edit `client/package.json`. In the `dependencies` block, add (alphabetic order between `plugin-dialog` and `plugin-store`):

```json
    "@tauri-apps/plugin-opener": "^2.0.0",
```

- [ ] **Step 5: Install + cargo check**

```bash
cd client
bun install
cd src-tauri
cargo check --all-targets 2>&1 | tail -5
```

Expected: bun resolves the new dep; cargo check passes.

- [ ] **Step 6: Format + lint + commit**

```bash
cd client/src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5

cd /Users/ybouzonie/perso/stage
git add client/src-tauri/Cargo.toml client/src-tauri/Cargo.lock client/src-tauri/src/lib.rs client/package.json client/bun.lock
git commit -m "chore(client): add tauri-plugin-opener for browser auto-open"
```

---

## Task 7: Add 5 Tauri auth + PR commands

**Files:**
- Modify: `client/src-tauri/src/commands.rs`
- Modify: `client/src-tauri/src/lib.rs`

- [ ] **Step 1: Add `AuthPollResult` + commands to `commands.rs`**

Append to `client/src-tauri/src/commands.rs` (after the existing commands):

```rust
use crate::api;
use crate::state::AuthSession;

/// Webview-facing variant of `api::DevicePollOutcome`. The `session_token`
/// from `DevicePollOutcome::Authorized(SessionData)` is intentionally
/// **NOT** included — it stays Rust-side in `AppState.auth`.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthPollResult {
    Pending,
    SlowDown,
    Authorized { user: api::User },
    Expired,
    Denied,
}

#[tauri::command]
pub async fn auth_device_start(
    state: tauri::State<'_, AppState>,
) -> Result<api::DeviceCode, AppError> {
    state.api.device_start().await.map_err(Into::into)
}

#[tauri::command]
pub async fn auth_device_poll(
    state: tauri::State<'_, AppState>,
    device_code: String,
) -> Result<AuthPollResult, AppError> {
    let outcome = state.api.device_poll(&device_code).await?;
    Ok(match outcome {
        api::DevicePollOutcome::Pending => AuthPollResult::Pending,
        api::DevicePollOutcome::SlowDown => AuthPollResult::SlowDown,
        api::DevicePollOutcome::Expired => AuthPollResult::Expired,
        api::DevicePollOutcome::Denied => AuthPollResult::Denied,
        api::DevicePollOutcome::Authorized(api::SessionData { session_token, user }) => {
            let user_for_event = user.clone();
            *state.auth.lock() = Some(AuthSession {
                token: session_token,
                user,
            });
            AuthPollResult::Authorized { user: user_for_event }
        }
    })
}

#[tauri::command]
pub async fn auth_me(state: tauri::State<'_, AppState>) -> Result<api::User, AppError> {
    let token = state.require_token()?;
    state.api.auth_me(&token).await.map_err(Into::into)
}

#[tauri::command]
pub async fn auth_logout(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let token = state.require_token()?;
    state.api.logout(&token).await?;
    *state.auth.lock() = None;
    Ok(())
}

#[tauri::command]
pub async fn github_prs(
    state: tauri::State<'_, AppState>,
    role: String,
) -> Result<Vec<api::GithubPrSearchItem>, AppError> {
    let token = state.require_token()?;
    state.api.github_prs(&token, &role).await.map_err(Into::into)
}
```

Add `use tauri::State;` already in scope? The existing commands use `tauri::State`. Look at file header — if `use tauri::{AppHandle, State};` already imports `State`, use the short name. Otherwise the fully-qualified `tauri::State<'_, AppState>` works as written.

- [ ] **Step 2: Register the new commands in lib.rs**

Edit `client/src-tauri/src/lib.rs`. In the `invoke_handler` macro, add the 5 new commands to the existing list. Final block:

```rust
        .invoke_handler(tauri::generate_handler![
            commands::set_active_repo,
            commands::get_active_repo,
            commands::list_recent_repos,
            commands::forget_recent_repo,
            commands::git_current_branch,
            commands::repo_summary,
            commands::auth_device_start,
            commands::auth_device_poll,
            commands::auth_me,
            commands::auth_logout,
            commands::github_prs,
        ])
```

- [ ] **Step 3: Run cargo check + tests**

```bash
cd client/src-tauri
cargo check --all-targets 2>&1 | tail -5
cargo test --lib 2>&1 | tail -10
```

Expected: clean. All prior tests still pass.

- [ ] **Step 4: Format + lint + commit**

```bash
cd client/src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5

cd /Users/ybouzonie/perso/stage
git add client/src-tauri/src/commands.rs client/src-tauri/src/lib.rs
git commit -m "feat(client/commands): add auth + github_prs Tauri commands"
```

---

## Task 8: Typed JS wrappers in `src/tauri.ts`

**Files:**
- Modify: `client/src/tauri.ts`

- [ ] **Step 1: Append new types + invoke wrappers**

Append to `client/src/tauri.ts`:

```typescript
export type DeviceCode = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
};

export type User = {
  id: number;
  github_login: string;
  github_user_id: number;
  display_name: string | null;
  avatar_url: string | null;
};

export type AuthPollResult =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'authorized'; user: User }
  | { kind: 'expired' }
  | { kind: 'denied' };

export type GithubUserRef = {
  login: string;
  avatar_url: string | null;
};

export type GithubPrSearchItem = {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  updated_at: string;
  user: GithubUserRef;
};

export const authDeviceStart = () => invoke<DeviceCode>('auth_device_start');

export const authDevicePoll = (deviceCode: string) =>
  invoke<AuthPollResult>('auth_device_poll', { deviceCode });

export const authMe = () => invoke<User>('auth_me');

export const authLogout = () => invoke<void>('auth_logout');

export const githubPrs = (role: 'author' | 'reviewer') =>
  invoke<GithubPrSearchItem[]>('github_prs', { role });
```

- [ ] **Step 2: Typecheck + lint**

```bash
cd client
bun run typecheck 2>&1 | tail -5
bun run lint 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /Users/ybouzonie/perso/stage
git add client/src/tauri.ts
git commit -m "feat(client/tauri.ts): typed wrappers for auth + github_prs commands"
```

---

## Task 9: `src/lib/auth.ts` — `runDeviceFlow` orchestrator

**Files:**
- Create: `client/src/lib/auth.ts`

- [ ] **Step 1: Write the orchestrator**

Create `client/src/lib/auth.ts`:

```typescript
import { openUrl } from '@tauri-apps/plugin-opener';
import { authDeviceStart, authDevicePoll } from '../tauri';
import type { DeviceCode, User } from '../tauri';

export type DeviceFlowEvent =
  | { kind: 'code-issued'; device: DeviceCode }
  | { kind: 'polling' }
  | { kind: 'slow_down' };

export type DeviceFlowOutcome =
  | { ok: true; user: User }
  | { ok: false; reason: 'expired' | 'denied' | 'transport'; detail?: string };

/**
 * Run the github device flow end-to-end. JS owns the poll loop (sleep,
 * deadline, slow_down interval bump). Cancellation: pass an AbortSignal —
 * abort exits the loop on the next tick.
 *
 * The session token never crosses back into JS: the Rust side stashes it in
 * AppState during `auth_device_poll`. This function only returns the
 * resolved User (and the outcome) for UI routing.
 */
export async function runDeviceFlow(
  onEvent: (e: DeviceFlowEvent) => void,
  signal: AbortSignal,
): Promise<DeviceFlowOutcome> {
  let device: DeviceCode;
  try {
    device = await authDeviceStart();
  } catch (e) {
    return { ok: false, reason: 'transport', detail: String(e) };
  }

  onEvent({ kind: 'code-issued', device });
  // Best-effort browser auto-open; the UI still shows the URL as a fallback.
  openUrl(device.verification_uri).catch(() => {});

  const deadline = Date.now() + device.expires_in * 1000;
  let interval = device.interval * 1000;

  while (!signal.aborted) {
    if (Date.now() > deadline) return { ok: false, reason: 'expired' };

    let out: Awaited<ReturnType<typeof authDevicePoll>>;
    try {
      out = await authDevicePoll(device.device_code);
    } catch (e) {
      return { ok: false, reason: 'transport', detail: String(e) };
    }

    switch (out.kind) {
      case 'authorized':
        return { ok: true, user: out.user };
      case 'expired':
        return { ok: false, reason: 'expired' };
      case 'denied':
        return { ok: false, reason: 'denied' };
      case 'pending':
        onEvent({ kind: 'polling' });
        break;
      case 'slow_down':
        interval += 5000;
        onEvent({ kind: 'slow_down' });
        break;
    }

    await sleep(interval, signal);
  }

  return { ok: false, reason: 'transport', detail: 'cancelled' };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
```

- [ ] **Step 2: Typecheck + lint**

```bash
cd client
bun run typecheck 2>&1 | tail -5
bun run lint 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /Users/ybouzonie/perso/stage
git add client/src/lib/auth.ts
git commit -m "feat(client/lib): runDeviceFlow orchestrator with AbortSignal cancel"
```

---

## Task 10: Rewrite `SignIn.tsx` for real device flow

**Files:**
- Modify: `client/src/screens/onboarding/SignIn.tsx`

The component will swap card content based on state. The SSO button and "Skip" link stay (out of scope to remove).

- [ ] **Step 1: Replace the component**

Replace `client/src/screens/onboarding/SignIn.tsx` content with:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { StageLogo } from '../../components/StageLogo';
import { runDeviceFlow } from '../../lib/auth';
import type { DeviceCode, User } from '../../tauri';

type State =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'awaiting-user'; device: DeviceCode }
  | { kind: 'error'; reason: 'expired' | 'denied' | 'transport'; detail?: string };

const ERROR_COPY: Record<'expired' | 'denied' | 'transport', string> = {
  expired: 'GitHub code expired. Try again.',
  denied: 'Authorization denied on GitHub.',
  transport: "Couldn't reach Stage backend.",
};

export function SignIn({ onAuthenticated }: { onAuthenticated: (u: User) => void }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const startFlow = useCallback(async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ kind: 'starting' });

    const outcome = await runDeviceFlow(
      (e) => {
        if (e.kind === 'code-issued') {
          setState({ kind: 'awaiting-user', device: e.device });
        }
      },
      ac.signal,
    );

    if (outcome.ok) {
      onAuthenticated(outcome.user);
    } else {
      setState({ kind: 'error', reason: outcome.reason, detail: outcome.detail });
    }
  }, [onAuthenticated]);

  // Cancel any in-flight poll on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div
      className="flex h-full w-full items-center justify-center relative"
      style={{ background: 'linear-gradient(180deg, #fbfaf8 0%, #f0eee9 100%)' }}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(rgba(0,0,0,0.06) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          opacity: 0.5,
        }}
      />

      <div
        className="relative z-10"
        style={{
          width: 380,
          background: '#fff',
          border: '1px solid var(--hairline)',
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(0,0,0,0.10), 0 4px 16px rgba(0,0,0,0.06)',
          padding: '28px 30px',
        }}
      >
        <div className="flex items-center gap-2.5" style={{ marginBottom: 22 }}>
          <StageLogo />
          <div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: 'var(--gray-900)',
                letterSpacing: '-0.02em',
              }}
            >
              Stage
            </div>
            <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>Local pull-request review</div>
          </div>
        </div>

        {state.kind === 'idle' && <IdleCard onContinue={startFlow} />}
        {state.kind === 'starting' && <StatusCard label="Contacting GitHub…" />}
        {state.kind === 'awaiting-user' && <AwaitingCard device={state.device} />}
        {state.kind === 'error' && (
          <ErrorCard
            reason={state.reason}
            detail={state.detail}
            onRetry={() => setState({ kind: 'idle' })}
          />
        )}
      </div>

      <div
        className="absolute left-0 right-0 text-center"
        style={{ bottom: 18, fontSize: 11, color: 'var(--gray-500)' }}
      >
        By continuing you agree to the <span style={{ color: 'var(--gray-700)' }}>Terms</span> and{' '}
        <span style={{ color: 'var(--gray-700)' }}>Privacy</span>. Stage runs locally — your code
        never leaves your machine.
      </div>
    </div>
  );
}

function IdleCard({ onContinue }: { onContinue: () => void }) {
  return (
    <>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--gray-900)',
          letterSpacing: '-0.01em',
          marginBottom: 4,
        }}
      >
        Sign in to continue
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--gray-500)', lineHeight: 1.5, marginBottom: 18 }}>
        Stage syncs with your GitHub account so it can open pull requests and post review comments
        on your behalf.
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onContinue}
          className="flex items-center justify-center gap-1.5 w-full cursor-default"
          style={{
            height: 38,
            borderRadius: 'var(--r-sm)',
            background: '#1a1917',
            color: '#fff',
            border: 'none',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'inherit',
          }}
        >
          <Icon name="gh" size={14} color="#fff" />
          Continue with GitHub
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="flex items-center justify-center gap-1.5 w-full cursor-default"
          style={{
            height: 38,
            borderRadius: 'var(--r-sm)',
            background: '#ffffff',
            border: '1px solid rgba(0,0,0,0.12)',
            boxShadow: '0 1px 0 rgba(0,0,0,0.04)',
            color: 'var(--gray-800)',
            fontSize: 13,
            fontWeight: 500,
            fontFamily: 'inherit',
          }}
        >
          Continue with SSO
        </button>
      </div>
    </>
  );
}

function StatusCard({ label }: { label: string }) {
  return (
    <div style={{ fontSize: 13, color: 'var(--gray-700)', textAlign: 'center', padding: '12px 0' }}>
      {label}
    </div>
  );
}

function AwaitingCard({ device }: { device: DeviceCode }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 12.5, color: 'var(--gray-500)', marginBottom: 10 }}>
        Enter this code at{' '}
        <span className="mono" style={{ color: 'var(--gray-800)' }}>
          {device.verification_uri}
        </span>
      </div>
      <div
        className="mono"
        style={{
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: '0.18em',
          color: 'var(--gray-900)',
          padding: '14px 0',
        }}
      >
        {device.user_code}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 6 }}>
        Waiting for GitHub… browser should have opened.
      </div>
    </div>
  );
}

function ErrorCard({
  reason,
  detail,
  onRetry,
}: {
  reason: 'expired' | 'denied' | 'transport';
  detail: string | undefined;
  onRetry: () => void;
}) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-900)', marginBottom: 6 }}>
        {ERROR_COPY[reason]}
      </div>
      {detail && (
        <div style={{ fontSize: 11, color: 'var(--gray-500)', marginBottom: 12 }}>{detail}</div>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="cursor-default"
        style={{
          height: 32,
          padding: '0 14px',
          borderRadius: 'var(--r-sm)',
          background: '#1a1917',
          color: '#fff',
          border: 'none',
          fontSize: 13,
          fontWeight: 600,
          fontFamily: 'inherit',
        }}
      >
        Try again
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

```bash
cd client
bun run typecheck 2>&1 | tail -5
bun run lint 2>&1 | tail -5
```

Expected: clean. (App.tsx will still pass the old `onContinue` prop until Task 12 rewires it; expect a TS error on the prop name mismatch — proceed past lint clean for this file alone, App.tsx Task 12 will resolve it. If `bun run typecheck` errors on App.tsx, that's fine for this commit; it gets fixed in Task 12.)

> Alternative: do Task 10 + 12 in a single commit if you'd rather not have a temporarily broken typecheck. The plan separates them for clarity.

- [ ] **Step 3: Commit**

```bash
cd /Users/ybouzonie/perso/stage
git add client/src/screens/onboarding/SignIn.tsx
git commit -m "feat(client/signin): wire SignIn to real github device flow"
```

---

## Task 11: Drop `onBack` from `OpenRepository`

**Files:**
- Modify: `client/src/screens/onboarding/OpenRepository.tsx`

- [ ] **Step 1: Remove the prop + rendered button**

In `client/src/screens/onboarding/OpenRepository.tsx`:

1. Change the `Props` interface (around line 28) from:

   ```typescript
   interface Props {
     onOpened: () => void;
     onBack?: () => void;
   }
   ```

   to:

   ```typescript
   interface Props {
     onOpened: () => void;
   }
   ```

2. Change the component signature (around line 33) from:

   ```typescript
   export function OpenRepository({ onOpened, onBack }: Props) {
   ```

   to:

   ```typescript
   export function OpenRepository({ onOpened }: Props) {
   ```

3. Remove the rendered Back button (around lines 289-310). Delete the entire `{onBack && (...)}` block.

- [ ] **Step 2: Typecheck + lint**

```bash
cd client
bun run lint 2>&1 | tail -5
```

(typecheck may still complain about App.tsx — fixed in Task 12.)

- [ ] **Step 3: Commit**

```bash
cd /Users/ybouzonie/perso/stage
git add client/src/screens/onboarding/OpenRepository.tsx
git commit -m "refactor(client/openrepo): drop unused onBack prop"
```

---

## Task 12: Simplify `App.tsx` + delete `onboardingFlag.ts`

**Files:**
- Modify: `client/src/App.tsx`
- Delete: `client/src/lib/onboardingFlag.ts`

- [ ] **Step 1: Replace `App.tsx`**

Replace `client/src/App.tsx` content with:

```tsx
import { useCallback, useState } from 'react';
import { OpenRepository } from './screens/onboarding/OpenRepository';
import { SignIn } from './screens/onboarding/SignIn';
import { WorkspaceScaffold } from './screens/workspace/WorkspaceScaffold';
import type { User } from './tauri';

type View = 'signIn' | 'openRepo' | 'workspace';

export function App() {
  const [view, setView] = useState<View>('signIn');
  const [user, setUser] = useState<User | null>(null);

  const onAuthenticated = useCallback((u: User) => {
    setUser(u);
    setView('openRepo');
  }, []);

  const onRepoOpened = useCallback(() => setView('workspace'), []);

  const onLogout = useCallback(() => {
    setUser(null);
    setView('signIn');
  }, []);

  if (view === 'signIn') return <SignIn onAuthenticated={onAuthenticated} />;
  if (view === 'openRepo') return <OpenRepository onOpened={onRepoOpened} />;
  return <WorkspaceScaffold user={user!} onLogout={onLogout} />;
}
```

- [ ] **Step 2: Delete `onboardingFlag.ts`**

```bash
rm /Users/ybouzonie/perso/stage/client/src/lib/onboardingFlag.ts
```

- [ ] **Step 3: Typecheck + lint**

```bash
cd client
bun run typecheck 2>&1 | tail -5
bun run lint 2>&1 | tail -5
```

Expected: typecheck still errors on `WorkspaceScaffold` (no `user` / `onLogout` props yet) — fixed in Task 13. lint clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/ybouzonie/perso/stage
git add client/src/App.tsx
git add -u client/src/lib/onboardingFlag.ts
git commit -m "refactor(client/app): drop onboardingFlag; route on auth state"
```

---

## Task 13: WorkspaceScaffold — header + logout + PR list

**Files:**
- Modify: `client/src/screens/workspace/WorkspaceScaffold.tsx`

- [ ] **Step 1: Rewrite the component**

Replace `client/src/screens/workspace/WorkspaceScaffold.tsx` content with:

```tsx
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useState } from 'react';
import {
  type GithubPrSearchItem,
  type RecentRepo,
  type RepoInfo,
  type User,
  authLogout,
  forgetRecentRepo,
  getActiveRepo,
  githubPrs,
  gitCurrentBranch,
  listRecentRepos,
  setActiveRepo,
} from '../../tauri';

type PrsState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: GithubPrSearchItem[] }
  | { kind: 'error'; detail: string };

function parseRepo(repositoryUrl: string): { owner: string; repo: string } {
  const m = repositoryUrl.match(/\/repos\/([^/]+)\/([^/]+)$/);
  return m ? { owner: m[1], repo: m[2] } : { owner: '?', repo: '?' };
}

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function relativeTime(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  const minutes = Math.round(ms / 60_000);
  if (Math.abs(minutes) < 60) return RTF.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RTF.format(hours, 'hour');
  const days = Math.round(hours / 24);
  return RTF.format(days, 'day');
}

export function WorkspaceScaffold({
  user,
  onLogout,
}: {
  user: User;
  onLogout: () => void;
}) {
  const [activeRepo, setActiveRepoState] = useState<RepoInfo | null>(null);
  const [recents, setRecents] = useState<RecentRepo[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [prs, setPrs] = useState<PrsState>({ kind: 'loading' });

  const refreshRecents = useCallback(async () => {
    setRecents(await listRecentRepos());
  }, []);

  const refreshBranch = useCallback(async () => {
    try {
      setBranch(await gitCurrentBranch());
      setError(null);
    } catch (e) {
      setError(String(e));
      setBranch(null);
    }
  }, []);

  const selectRepo = useCallback(
    async (path: string) => {
      try {
        const info = await setActiveRepo(path);
        setActiveRepoState(info);
        setError(null);
        await refreshRecents();
        await refreshBranch();
      } catch (e) {
        setError(String(e));
      }
    },
    [refreshRecents, refreshBranch],
  );

  const pickFolder = useCallback(async () => {
    const path = await open({ directory: true, multiple: false });
    if (typeof path === 'string') await selectRepo(path);
  }, [selectRepo]);

  const forget = useCallback(
    async (path: string) => {
      await forgetRecentRepo(path);
      await refreshRecents();
    },
    [refreshRecents],
  );

  const doLogout = useCallback(async () => {
    try {
      await authLogout();
    } catch (e) {
      console.warn('authLogout failed; clearing local state anyway', e);
    }
    onLogout();
  }, [onLogout]);

  useEffect(() => {
    (async () => {
      setActiveRepoState(await getActiveRepo());
      await refreshRecents();
    })();
  }, [refreshRecents]);

  useEffect(() => {
    const unlistenPromise = listen('repo-changed', () => {
      const ts = new Date().toLocaleTimeString();
      setEvents((prev) => [`${ts} repo-changed`, ...prev].slice(0, 20));
      refreshBranch();
    });
    return () => {
      unlistenPromise.then((u) => u());
    };
  }, [refreshBranch]);

  useEffect(() => {
    if (activeRepo) refreshBranch();
  }, [activeRepo, refreshBranch]);

  useEffect(() => {
    let cancelled = false;
    githubPrs('author')
      .then((items) => {
        if (!cancelled) setPrs({ kind: 'ready', items });
      })
      .catch((e) => {
        if (!cancelled) setPrs({ kind: 'error', detail: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main style={{ padding: '3rem 1.5rem 1.5rem', maxWidth: 720, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Stage</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: '#555' }}>@{user.github_login}</span>
          <button type="button" onClick={doLogout}>
            Logout
          </button>
        </div>
      </header>
      <p style={{ color: '#888', marginTop: '0.25rem' }}>
        Smoke scaffold. Pick a git repo and see your open GitHub PRs below.
      </p>

      <section>
        {activeRepo ? (
          <>
            <p>
              Active repo: <code>{activeRepo.path}</code>
            </p>
            <p>Branch: {branch ?? '...'}</p>
          </>
        ) : (
          <p>No repo selected.</p>
        )}
        {error && <p style={{ color: '#b00020' }}>Error: {error}</p>}
        <button type="button" onClick={pickFolder}>
          Pick repo...
        </button>
      </section>

      <section>
        <h2>Recent</h2>
        {recents.length === 0 ? (
          <p>No recents.</p>
        ) : (
          <ul>
            {recents.map((r) => (
              <li key={r.path}>
                <button type="button" onClick={() => selectRepo(r.path)}>
                  {r.path}
                </button>
                <button type="button" onClick={() => forget(r.path)}>
                  forget
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Watcher events</h2>
        {events.length === 0 ? (
          <p>(none yet — try touching a file in the repo)</p>
        ) : (
          <ul>
            {events.map((e) => (
              <li key={e}>
                <code>{e}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>My GitHub PRs (author)</h2>
        {prs.kind === 'loading' && <p>Loading…</p>}
        {prs.kind === 'error' && <p style={{ color: '#b00020' }}>Failed to load PRs: {prs.detail}</p>}
        {prs.kind === 'ready' && prs.items.length === 0 && <p>No open PRs found.</p>}
        {prs.kind === 'ready' && prs.items.length > 0 && (
          <ul>
            {prs.items.map((pr) => {
              const { owner, repo } = parseRepo(pr.repository_url);
              return (
                <li key={`${owner}/${repo}#${pr.number}`} style={{ marginBottom: 6 }}>
                  <button
                    type="button"
                    onClick={() => openUrl(pr.html_url)}
                    style={{ textAlign: 'left', cursor: 'pointer' }}
                  >
                    {owner}/{repo} #{pr.number} · {pr.title}
                  </button>
                  <div style={{ fontSize: 11, color: '#777' }}>
                    by @{pr.user.login} · updated {relativeTime(pr.updated_at)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

```bash
cd client
bun run typecheck 2>&1 | tail -5
bun run lint 2>&1 | tail -5
```

Expected: clean. All earlier TS errors resolved.

- [ ] **Step 3: Commit**

```bash
cd /Users/ybouzonie/perso/stage
git add client/src/screens/workspace/WorkspaceScaffold.tsx
git commit -m "feat(client/workspace): header + logout + 'My GitHub PRs' section"
```

---

## Task 14: End-to-end manual verification

**Files:** none modified — verification only.

Pre-reqs:
- `backend/.env` has real `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` (OAuth App with Device Flow enabled), and `GITHUB_ADMIN_PAT` (repo + read:user).
- Postgres running, backend migrations applied. From `/Users/ybouzonie/perso/stage/backend`: `just bootstrap` (once), then `just dev`.

- [ ] **Step 1: Start backend (separate terminal)**

```bash
cd /Users/ybouzonie/perso/stage/backend
just dev
```

Expected: Django dev server listens on `http://localhost:8000`.

- [ ] **Step 2: Start client**

```bash
cd /Users/ybouzonie/perso/stage
just dev
```

Expected: Tauri window opens showing SignIn.

- [ ] **Step 3: Walk the flow**

Confirm each gate end-to-end. Report PASS / FAIL for each step:

1. SignIn renders with "Continue with GitHub" button.
2. Click → card swaps to "Contacting GitHub…", then to a big user code + verification URL.
3. System browser opens to `github.com/login/device`.
4. Paste code, authorize on github.com.
5. Within `interval` seconds (default 5), webview transitions to OpenRepository.
6. Open a local git repo (drag/drop or picker).
7. WorkspaceScaffold renders: header shows `@<github_login>` + Logout button; PR section shows "Loading…" then a list of your open PRs.
8. Click a PR → opens github.com PR page in browser.
9. Click Logout → returns to SignIn.
10. Restart the app (kill + `just dev` again) → starts at SignIn (memory-only token confirmed).

- [ ] **Step 4: Document the result**

Append a verification report to the design doc:

```bash
cd /Users/ybouzonie/perso/stage
cat >> docs/superpowers/specs/2026-05-25-tauri-auth-and-github-prs-design.md <<'EOF'

## Verification (executed 2026-MM-DD)

| Step | Result | Notes |
|---|---|---|
| 1 — SignIn renders | PASS / FAIL | |
| 2 — Click → user code shown | PASS / FAIL | |
| 3 — Browser auto-opens | PASS / FAIL | |
| 4 — github.com authorize succeeds | PASS / FAIL | |
| 5 — Transition to OpenRepository | PASS / FAIL | |
| 6 — Open local repo | PASS / FAIL | |
| 7 — PR list populates | PASS / FAIL | |
| 8 — PR click opens browser | PASS / FAIL | |
| 9 — Logout → SignIn | PASS / FAIL | |
| 10 — Restart starts at SignIn | PASS / FAIL | |
EOF
```

Fill in the table. Commit:

```bash
git add docs/superpowers/specs/2026-05-25-tauri-auth-and-github-prs-design.md
git commit -m "docs(spec): record e2e verification result"
```

- [ ] **Step 5: Push the branch**

```bash
git push -u origin feat/tauri-auth-and-github-prs
```

---

## Self-review summary (already performed during plan authoring)

- **Spec coverage:** all sections of `2026-05-25-tauri-auth-and-github-prs-design.md` map to tasks (1-2: SDK; 3: smoke; 4: errors; 5: state + URL config; 6: opener plugin; 7: commands; 8-13: JS layers; 14: e2e). The "Failure-mode UX matrix" and "Testing strategy" sections informed Task 4 tests + Task 14 verification.
- **Placeholders:** no "TBD" / "implement later" / "add appropriate error handling" remain. All code blocks are concrete.
- **Type consistency:** `User`, `AuthSession`, `AuthPollResult`, `GithubPrSearchItem`, `GithubUserRef`, `DeviceCode` shapes are consistent across Rust + TS halves and across tasks.
- **Known mid-plan TS breakage:** App.tsx typechecks fail between Tasks 10 and 12 because the prop names change. The plan flags this and offers a combined Task 10+12 commit as an alternative.

---

## Execution

Hand off to either `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
