# BackendClient seam (auth slice) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a pure-Rust `BackendClient` SDK in `client/src-tauri/src/backend.rs` that covers the four `/api/v1/auth/*` endpoints, with full unit-test coverage via `wiremock` and a manual smoke-test binary.

**Architecture:** Single-file module inside the existing Tauri crate. Async I/O via `reqwest` + `tokio`. Stateless token handling (caller passes `&str` per call). Hand-rolled `DevicePollOutcome` enum maps the RFC 8628 device-flow vocabulary into typed outcomes — see ADR-0005.

**Tech Stack:** Rust async (`tokio`, `reqwest`), `serde` for JSON, `thiserror` for the error enum, `wiremock` for HTTP mocks, `tracing` for logs.

**Spec:** `docs/superpowers/specs/2026-05-24-backend-client-seam-design.md` (post-grill)

**Related:**
- `docs/adr/0005-local-client-sdk-hand-rolls-device-flow.md` — why no oauth2-rs.
- `docs/design.md` § 7 — backend-side auth implementation (what we call into).
- `docs/api.md` § Authentication — the wire contract.

---

## Pedagogical orientation (read before Task 1)

If you've never written async Rust before, skim these one-liners before starting. Each is also linked inline at first use.

| Concept | One-line model |
|---|---|
| `Result<T, E>` | Either a value or an error — caller must handle both. |
| `?` operator | If `Err`, propagate; else unwrap and continue. |
| `async fn` + `.await` | Function returns a `Future`; `.await` runs it on the runtime. |
| `#[tokio::test]` | Test version of `#[test]` that runs in an async runtime. |
| `#[derive(Deserialize)]` | Compiler generates JSON converters for this struct. |
| enum with data | Tagged union — each variant can carry its own payload. |
| `thiserror::Error` derive | Macro generates the `Display` + `std::error::Error` impls. |
| `reqwest::Client` | HTTP client; cheap to `.clone()` (internally `Arc`-wrapped). |
| pattern matching | `match outcome { Pending => ..., Authorized(s) => ... }`. |

Useful commands you'll run repeatedly from `client/src-tauri/`:

- `cargo check --all-targets` — fast type-check, no binary
- `cargo test --lib backend::` — run only this module's tests
- `cargo clippy --all-targets -- -D warnings` — lint with warnings-as-errors
- `cargo fmt` — auto-format

---

## File structure (locked before Task 1)

**Created in this plan:**
- `client/src-tauri/src/backend.rs` — public surface + tests (~400-500 LOC including tests).
- `client/src-tauri/examples/auth_smoke.rs` — manual smoke binary, runs the full device-flow loop against a local Stage backend.

**Modified in this plan:**
- `client/src-tauri/Cargo.toml` — bumped `thiserror`, added `reqwest`, `tokio`, `wiremock`.

**Already in place (no change):**
- `client/src-tauri/src/lib.rs` — already declares `mod backend;`. No re-export needed for this slice; the module compiles but is not consumed by other modules yet.
- `client/src-tauri/src/errors.rs` — uses `thiserror` basics; must keep compiling on `thiserror` 2.

---

## Task 1: Bump dependencies + verify nothing else breaks

**Files:**
- Modify: `client/src-tauri/Cargo.toml`

**Why this task is first:** every subsequent test/build assumes the right crates are present. Doing this first means later tasks fail with type errors instead of confusing "crate not found" errors.

**Why `thiserror` 1 → 2:** ergonomic improvements (better `#[error("...")]` interpolation). The breaking-change surface is small. `errors.rs` uses only basic patterns; we verify it still compiles.

- [ ] **Step 1: Read the current `Cargo.toml`**

```bash
cat client/src-tauri/Cargo.toml
```

You should see existing deps including `thiserror = "1"`, `serde`, `serde_json`, `tracing`. No `reqwest`, no `tokio`, no `wiremock`.

- [ ] **Step 2: Modify `[dependencies]` and add `[dev-dependencies]`**

Open `client/src-tauri/Cargo.toml`. Replace the line `thiserror = "1"` with `thiserror = "2.0.18"`. Add the new dependency lines for `reqwest` and `tokio`. Add a new `[dev-dependencies]` section at the bottom with `wiremock`.

Final state — show the `[dependencies]` block plus the new `[dev-dependencies]` block:

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-store = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
git2 = { version = "0.19", default-features = false }
notify = "6"
notify-debouncer-mini = "0.4"
thiserror = "2.0.18"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
parking_lot = "0.12"
reqwest = { version = "0.13.3", default-features = false, features = ["json", "rustls-tls"] }
tokio = { version = "1.52.3", features = ["macros", "rt", "rt-multi-thread", "time"] }

[dev-dependencies]
wiremock = "0.6.5"
```

- [ ] **Step 3: Run `cargo check` to verify the existing code still compiles**

```bash
cd client/src-tauri && cargo check --all-targets
```

Expected: PASS. New crates download (~30-60s first run). If `errors.rs` fails to compile on `thiserror` 2, the most likely cause is the positional `.0.display()` syntax in `NotARepo`; the v2 macros still accept that pattern, so it should be clean. If it fails: capture the exact error and stop — don't proceed.

- [ ] **Step 4: Run `cargo clippy` to verify no new warnings**

```bash
cd client/src-tauri && cargo clippy --all-targets -- -D warnings
```

Expected: PASS, no warnings.

- [ ] **Step 5: Commit**

```bash
git add client/src-tauri/Cargo.toml client/src-tauri/Cargo.lock
git commit -m "build(client): add reqwest/tokio/wiremock; bump thiserror to 2"
```

---

## Task 2: Skeleton module + `BackendError` enum + `InvalidBaseUrl` test

**Files:**
- Modify: `client/src-tauri/src/backend.rs` (replace placeholder doc-comment)

**Why:** establishes the module shape and the error enum that every method will return. `InvalidBaseUrl` is the simplest variant — testable without any HTTP.

- [ ] **Step 1: Replace the placeholder with the module skeleton + `BackendError`**

Open `client/src-tauri/src/backend.rs`. Currently it contains only a doc-comment. Replace the entire file with:

```rust
//! SDK for talking to the Stage backend from the Local Client.
//!
//! Disambiguation: the type `BackendClient` in this module is an **SDK** —
//! a handle through which the Local Client (the Tauri desktop app) calls the
//! Stage backend's HTTP endpoints. It is NOT to be confused with "Local Client"
//! in `CONTEXT.md` / ADR-0001, which refers to the desktop app itself.
//!
//! Scope of this slice: the four `/api/v1/auth/*` endpoints (device flow +
//! `auth_me` + `logout`). No Tauri commands wired yet; no keychain integration.
//! See `docs/superpowers/specs/2026-05-24-backend-client-seam-design.md`.

use std::time::Duration;

/// Errors returned by `BackendClient` methods.
#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("invalid base url: {0}")]
    InvalidBaseUrl(String),

    #[error("transport failure: {0}")]
    Transport(#[from] reqwest::Error),

    #[error("response decode failed: {0}")]
    Decode(serde_json::Error),

    #[error("unauthenticated (401)")]
    Unauthenticated,

    #[error("validation error: {extra}")]
    Validation { extra: serde_json::Value },

    #[error("github error (status {status}): {extra}")]
    Github {
        status: u16,
        extra: serde_json::Value,
    },

    #[error("unexpected response (status {status}): {message}")]
    Unexpected {
        status: u16,
        message: String,
        extra: serde_json::Value,
    },
}

/// SDK handle for the Stage backend. Cheap to clone.
#[derive(Clone)]
pub struct BackendClient {
    base_url: String, // validated + trailing-slash-trimmed in `new`
    http: reqwest::Client,
}

impl BackendClient {
    /// Construct with default 30s HTTP timeout.
    pub fn new(base_url: impl AsRef<str>) -> Result<Self, BackendError> {
        Self::with_timeout(base_url, Duration::from_secs(30))
    }

    /// Construct with explicit HTTP timeout.
    pub fn with_timeout(
        base_url: impl AsRef<str>,
        timeout: Duration,
    ) -> Result<Self, BackendError> {
        let raw = base_url.as_ref();
        // Validate by parsing through reqwest's URL type.
        reqwest::Url::parse(raw)
            .map_err(|e| BackendError::InvalidBaseUrl(e.to_string()))?;
        let trimmed = raw.trim_end_matches('/').to_string();
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .user_agent(concat!("stage-client/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(BackendError::Transport)?;
        Ok(Self {
            base_url: trimmed,
            http,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_rejects_malformed_url() {
        let err = BackendClient::new("not a url").unwrap_err();
        assert!(matches!(err, BackendError::InvalidBaseUrl(_)));
    }
}
```

What's happening here:
- `#[derive(thiserror::Error)]` + `#[error("...")]` — `thiserror` generates `Display` + `Error` trait impls. Without it we'd hand-write ~50 lines.
- `#[from] reqwest::Error` — also generates `From<reqwest::Error> for BackendError`. Lets us use `?` after a `reqwest` call.
- `impl AsRef<str>` — accepts `&str`, `String`, `&String` without forcing the caller to pick.
- `#[cfg(test)] mod tests` — tests live inside the file. Compiled only with `cargo test`.
- `matches!(err, BackendError::InvalidBaseUrl(_))` — pattern-match without writing a full `match`.

- [ ] **Step 2: Run the test to verify it passes**

```bash
cd client/src-tauri && cargo test --lib backend::tests::new_rejects_malformed_url
```

Expected: PASS.

- [ ] **Step 3: Run `cargo clippy` for the module**

```bash
cd client/src-tauri && cargo clippy --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/backend.rs
git commit -m "feat(client): scaffold BackendClient module + BackendError enum"
```

---

## Task 3: `new` / `with_timeout` constructors — accept `&str`, `String`, trailing-slash, timeout

**Files:**
- Modify: `client/src-tauri/src/backend.rs` (extend `tests` mod)

**Why:** lock down construction behavior with unit tests before we add HTTP methods.

- [ ] **Step 1: Write failing tests for construction behavior**

Append to the `mod tests` block at the bottom of `client/src-tauri/src/backend.rs` (above the closing `}` of `mod tests`):

```rust
    #[test]
    fn new_accepts_str_and_string() {
        BackendClient::new("http://localhost:8000").unwrap();
        BackendClient::new(String::from("http://localhost:8000")).unwrap();
    }

    #[test]
    fn new_trims_trailing_slash() {
        let c1 = BackendClient::new("http://localhost:8000").unwrap();
        let c2 = BackendClient::new("http://localhost:8000/").unwrap();
        assert_eq!(c1.base_url, c2.base_url);
        assert_eq!(c1.base_url, "http://localhost:8000");
    }

    #[test]
    fn with_timeout_constructs() {
        let _ = BackendClient::with_timeout("http://localhost:8000", Duration::from_millis(500))
            .unwrap();
    }
```

Notes:
- The `assert_eq!(c1.base_url, c2.base_url)` works because we're testing from inside the same module — `base_url` is private but visible to `mod tests`.

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd client/src-tauri && cargo test --lib backend::tests
```

Expected: PASS (all 4 tests including the prior `new_rejects_malformed_url`).

- [ ] **Step 3: Commit**

```bash
git add client/src-tauri/src/backend.rs
git commit -m "test(client): cover new/with_timeout construction behavior"
```

---

## Task 4: Wire types — `DeviceCode`, `User`, `SessionData` + roundtrip tests

**Files:**
- Modify: `client/src-tauri/src/backend.rs`

**Why:** typed JSON shapes. Each one is verified by deserializing a representative payload from `docs/api.md` — catches drift between doc and code.

- [ ] **Step 1: Add the public structs and roundtrip tests**

Just below `pub struct BackendClient { ... }` and **above** the `impl BackendClient { ... }` block, insert:

```rust
/// Returned by `device_start`. Carries the device code, the user-facing code,
/// the URL where the user types it, and the polling/expiry hints (seconds).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

/// Stage user identity returned by `device_poll` (on success) and `auth_me`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct User {
    pub id: i64,
    pub github_login: String,
    pub github_user_id: i64,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

/// Returned inside `DevicePollOutcome::Authorized` on successful login.
///
/// `session_token` is the raw `stg_…` opaque Bearer string. **Do not log it.**
/// `SessionData` deliberately does NOT derive `Debug` to block `{:?}` formatting.
/// Per `docs/design.md` § 7 the token is long-lived until user-initiated logout.
#[derive(Clone, serde::Deserialize)]
pub struct SessionData {
    pub session_token: String,
    pub user: User,
}
```

Now extend `mod tests`:

```rust
    #[test]
    fn devicecode_deserializes_from_api_md_shape() {
        let json = serde_json::json!({
            "device_code": "abc123",
            "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "interval": 5,
            "expires_in": 900
        });
        let dc: DeviceCode = serde_json::from_value(json).unwrap();
        assert_eq!(dc.user_code, "ABCD-1234");
        assert_eq!(dc.interval, 5);
        assert_eq!(dc.expires_in, 900);
    }

    #[test]
    fn user_deserializes_with_optional_fields_present() {
        let json = serde_json::json!({
            "id": 42,
            "github_login": "octocat",
            "github_user_id": 583231,
            "display_name": "The Octocat",
            "avatar_url": "https://avatars.example/o"
        });
        let u: User = serde_json::from_value(json).unwrap();
        assert_eq!(u.github_login, "octocat");
        assert_eq!(u.display_name.as_deref(), Some("The Octocat"));
    }

    #[test]
    fn user_deserializes_with_optional_fields_null() {
        let json = serde_json::json!({
            "id": 42,
            "github_login": "octocat",
            "github_user_id": 583231,
            "display_name": null,
            "avatar_url": null
        });
        let u: User = serde_json::from_value(json).unwrap();
        assert!(u.display_name.is_none());
        assert!(u.avatar_url.is_none());
    }

    #[test]
    fn session_data_deserializes() {
        let json = serde_json::json!({
            "session_token": "stg_eyJhbG_opaque",
            "user": {
                "id": 42,
                "github_login": "octocat",
                "github_user_id": 583231,
                "display_name": null,
                "avatar_url": null
            }
        });
        let s: SessionData = serde_json::from_value(json).unwrap();
        assert_eq!(s.session_token, "stg_eyJhbG_opaque");
        assert_eq!(s.user.github_login, "octocat");
    }
```

`#[derive(serde::Deserialize)]` generates JSON converters automatically — serde reads each `pub field` and matches it to the corresponding JSON key by name.

- [ ] **Step 2: Run the new tests**

```bash
cd client/src-tauri && cargo test --lib backend::tests
```

Expected: PASS (now ~8 tests).

- [ ] **Step 3: Commit**

```bash
git add client/src-tauri/src/backend.rs
git commit -m "feat(client): add DeviceCode, User, SessionData with roundtrip tests"
```

---

## Task 5: `DevicePollOutcome` enum + internal serde shape for `device_poll` 200 response

**Files:**
- Modify: `client/src-tauri/src/backend.rs`

**Why:** the public `DevicePollOutcome` is the caller's pattern-match target. Its derivation from the wire shape uses serde's tagged-enum pattern.

- [ ] **Step 1: Add `DevicePollOutcome` and the internal `DevicePollSuccess` wire type**

Just below the `SessionData` struct, add:

```rust
/// Caller-facing outcome of one `device_poll` call. The caller's loop picks
/// the next action based on which variant matches.
#[derive(Debug, Clone)]
pub enum DevicePollOutcome {
    /// GitHub returned `authorization_pending` — keep polling at the same cadence.
    Pending,
    /// GitHub returned `slow_down` — caller should add ~5s to its polling interval.
    SlowDown,
    /// User completed the device-flow — caller persists the session_token.
    Authorized(SessionData),
    /// `device_code` expired (>15 min since `device_start`).
    Expired,
    /// User clicked deny on the GitHub authorize page.
    Denied,
}

// Internal wire shape: backend returns `{"status": "pending"}` or
// `{"status": "ok", "session_token": ..., "user": ...}` on 200.
#[derive(serde::Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum DevicePollSuccess {
    Pending,
    Ok {
        session_token: String,
        user: User,
    },
}
```

- [ ] **Step 2: Write tests for the wire deserializer**

In `mod tests`, append:

```rust
    #[test]
    fn devicepollsuccess_pending() {
        let json = serde_json::json!({"status": "pending"});
        let s: DevicePollSuccess = serde_json::from_value(json).unwrap();
        assert!(matches!(s, DevicePollSuccess::Pending));
    }

    #[test]
    fn devicepollsuccess_ok() {
        let json = serde_json::json!({
            "status": "ok",
            "session_token": "stg_abc",
            "user": {
                "id": 1, "github_login": "u", "github_user_id": 1,
                "display_name": null, "avatar_url": null
            }
        });
        let s: DevicePollSuccess = serde_json::from_value(json).unwrap();
        match s {
            DevicePollSuccess::Ok { session_token, user } => {
                assert_eq!(session_token, "stg_abc");
                assert_eq!(user.id, 1);
            }
            _ => panic!("expected Ok variant"),
        }
    }
```

`#[serde(tag = "status", rename_all = "snake_case")]` tells serde: discriminate variants by the `"status"` JSON field; lowercase-snake-case the variant names. Variant `Pending` matches `"pending"`; variant `Ok` matches `"ok"`.

- [ ] **Step 3: Run tests**

```bash
cd client/src-tauri && cargo test --lib backend::tests
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/backend.rs
git commit -m "feat(client): add DevicePollOutcome + tagged-enum wire deserializer"
```

---

## Task 6: `device_start` — happy path + Github 500 + transport failure

**Files:**
- Modify: `client/src-tauri/src/backend.rs`

**Why:** first real HTTP method. Establishes the pattern (build URL, POST, handle response, parse envelope) that all subsequent methods reuse.

- [ ] **Step 1: Add a private helper that maps a non-2xx response to `BackendError`**

Inside `impl BackendClient` (just below the `with_timeout` constructor), add:

```rust
    async fn map_error(resp: reqwest::Response) -> BackendError {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        // Try parse `{"message": "...", "extra": {...}}`.
        let parsed: Option<(String, serde_json::Value)> = serde_json::from_str::<
            serde_json::Value,
        >(&body)
        .ok()
        .and_then(|v| {
            let m = v.get("message")?.as_str()?.to_string();
            let e = v.get("extra").cloned().unwrap_or(serde_json::Value::Null);
            Some((m, e))
        });
        let (message, extra) = parsed.unwrap_or((String::new(), serde_json::Value::Null));
        match (status, message.as_str()) {
            (401, _) => BackendError::Unauthenticated,
            (400, "validation_error") => BackendError::Validation { extra },
            (_, "github_error") => BackendError::Github { status, extra },
            _ => BackendError::Unexpected {
                status,
                message,
                extra,
            },
        }
    }
```

What this does:
- Reads the response body.
- Tries to parse the standard `{"message": ..., "extra": ...}` envelope.
- If status is 401 → `Unauthenticated`. If 400 + slug `validation_error` → `Validation`. Any slug `github_error` → `Github`. Otherwise → `Unexpected`.
- If the envelope is missing or malformed, falls back to `Unexpected` with empty message + null extra.

- [ ] **Step 2: Add the `device_start` method**

Inside `impl BackendClient`, below `map_error`, add:

```rust
    /// `POST /api/v1/auth/device/start/` — kicks off the device flow.
    pub async fn device_start(&self) -> Result<DeviceCode, BackendError> {
        let url = format!("{}/api/v1/auth/device/start/", self.base_url);
        let resp = self.http.post(&url).send().await?;
        if !resp.status().is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json::<DeviceCode>().await.map_err(BackendError::from)
    }
```

`self.http.post(&url).send().await?` — `await` runs the future; `?` propagates a `reqwest::Error` into `BackendError::Transport` (via the `#[from]` derive on the enum).

`resp.json::<DeviceCode>()` — `reqwest` decodes the body into our struct using serde.

- [ ] **Step 3: Write the happy-path test**

In `mod tests`, append:

```rust
    use wiremock::matchers::{header_exists, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn device_start_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/start/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "device_code": "abc",
                "user_code": "ABCD-1234",
                "verification_uri": "https://github.com/login/device",
                "interval": 5,
                "expires_in": 900,
            })))
            .mount(&server)
            .await;

        let client = BackendClient::new(server.uri()).unwrap();
        let dc = client.device_start().await.unwrap();
        assert_eq!(dc.user_code, "ABCD-1234");
        assert_eq!(dc.expires_in, 900);
    }
```

What's happening:
- `MockServer::start().await` spins up a real HTTP server on a random port for the duration of this test.
- `Mock::given(method("POST")).and(path(...))` says "match POST requests on this path."
- `ResponseTemplate::new(200).set_body_json(...)` says "respond with status 200 and this JSON body."
- `.mount(&server).await` registers the mock.
- `server.uri()` returns something like `http://127.0.0.1:54321`.

`#[tokio::test]` (instead of `#[test]`) runs this in an async runtime so `.await` works.

- [ ] **Step 4: Run the test**

```bash
cd client/src-tauri && cargo test --lib backend::tests::device_start_ok
```

Expected: PASS.

- [ ] **Step 5: Add the failure-path tests**

In `mod tests`, append:

```rust
    #[tokio::test]
    async fn device_start_500_maps_to_unexpected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/start/"))
            .respond_with(ResponseTemplate::new(500).set_body_string("internal err"))
            .mount(&server)
            .await;

        let client = BackendClient::new(server.uri()).unwrap();
        let err = client.device_start().await.unwrap_err();
        assert!(
            matches!(&err, BackendError::Unexpected { status: 500, .. }),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn device_start_transport_error_when_server_down() {
        // Bind a port and immediately drop it — the backend client will get
        // connection refused.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let url = format!("http://127.0.0.1:{port}");
        let client = BackendClient::with_timeout(&url, Duration::from_millis(500)).unwrap();
        let err = client.device_start().await.unwrap_err();
        assert!(matches!(err, BackendError::Transport(_)), "got {err:?}");
    }
```

- [ ] **Step 6: Run tests**

```bash
cd client/src-tauri && cargo test --lib backend::tests
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src-tauri/src/backend.rs
git commit -m "feat(client): implement device_start + envelope error mapper"
```

---

## Task 7: `device_poll` — Pending + Authorized + Expired + SlowDown + Denied + authorization_pending

**Files:**
- Modify: `client/src-tauri/src/backend.rs`

**Why:** the load-bearing method. Six outcomes to cover.

- [ ] **Step 1: Implement `device_poll`**

Inside `impl BackendClient`, below `device_start`, add:

```rust
    /// `POST /api/v1/auth/device/poll/` — one poll attempt.
    ///
    /// The caller drives the loop. Returns a `DevicePollOutcome` describing
    /// the terminal-or-non-terminal state of the device flow.
    pub async fn device_poll(
        &self,
        device_code: &str,
    ) -> Result<DevicePollOutcome, BackendError> {
        let url = format!("{}/api/v1/auth/device/poll/", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({ "device_code": device_code }))
            .send()
            .await?;
        let status = resp.status();
        if status.is_success() {
            let parsed: DevicePollSuccess = resp.json().await.map_err(BackendError::from)?;
            return Ok(match parsed {
                DevicePollSuccess::Pending => DevicePollOutcome::Pending,
                DevicePollSuccess::Ok {
                    session_token,
                    user,
                } => DevicePollOutcome::Authorized(SessionData {
                    session_token,
                    user,
                }),
            });
        }
        // Non-2xx — interpret the envelope. github_error with a known device-flow
        // slug maps to its DevicePollOutcome variant.
        let err = Self::map_error(resp).await;
        if let BackendError::Github { ref extra, .. } = err {
            if let Some(slug) = extra.get("error").and_then(|v| v.as_str()) {
                match slug {
                    "authorization_pending" => return Ok(DevicePollOutcome::Pending),
                    "slow_down" => return Ok(DevicePollOutcome::SlowDown),
                    "access_denied" => return Ok(DevicePollOutcome::Denied),
                    "expired_token" => return Ok(DevicePollOutcome::Expired),
                    _ => {}
                }
            }
        }
        Err(err)
    }
```

What's happening: a 4xx with `github_error` slug + `extra.error` matches one of the RFC 8628 device-flow keywords. Other 4xx/5xx + unknown github error slugs fall through to a real error.

- [ ] **Step 2: Write tests for each outcome**

In `mod tests`, append:

```rust
    async fn arrange_poll_pending(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/poll/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "pending"
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn device_poll_pending() {
        let server = MockServer::start().await;
        arrange_poll_pending(&server).await;
        let client = BackendClient::new(server.uri()).unwrap();
        let out = client.device_poll("dc").await.unwrap();
        assert!(matches!(out, DevicePollOutcome::Pending));
    }

    #[tokio::test]
    async fn device_poll_authorized() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/poll/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "ok",
                "session_token": "stg_abc",
                "user": {
                    "id": 42,
                    "github_login": "octocat",
                    "github_user_id": 583231,
                    "display_name": null,
                    "avatar_url": null
                }
            })))
            .mount(&server)
            .await;
        let client = BackendClient::new(server.uri()).unwrap();
        let out = client.device_poll("dc").await.unwrap();
        match out {
            DevicePollOutcome::Authorized(s) => {
                assert_eq!(s.session_token, "stg_abc");
                assert_eq!(s.user.github_login, "octocat");
            }
            other => panic!("expected Authorized, got {other:?}"),
        }
    }

    async fn github_error_response(server: &MockServer, slug: &str) {
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/poll/"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "message": "github_error",
                "extra": {"error": slug}
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn device_poll_authorization_pending_maps_to_pending() {
        let server = MockServer::start().await;
        github_error_response(&server, "authorization_pending").await;
        let client = BackendClient::new(server.uri()).unwrap();
        assert!(matches!(client.device_poll("dc").await.unwrap(), DevicePollOutcome::Pending));
    }

    #[tokio::test]
    async fn device_poll_slow_down() {
        let server = MockServer::start().await;
        github_error_response(&server, "slow_down").await;
        let client = BackendClient::new(server.uri()).unwrap();
        assert!(matches!(client.device_poll("dc").await.unwrap(), DevicePollOutcome::SlowDown));
    }

    #[tokio::test]
    async fn device_poll_expired() {
        let server = MockServer::start().await;
        github_error_response(&server, "expired_token").await;
        let client = BackendClient::new(server.uri()).unwrap();
        assert!(matches!(client.device_poll("dc").await.unwrap(), DevicePollOutcome::Expired));
    }

    #[tokio::test]
    async fn device_poll_denied() {
        let server = MockServer::start().await;
        github_error_response(&server, "access_denied").await;
        let client = BackendClient::new(server.uri()).unwrap();
        assert!(matches!(client.device_poll("dc").await.unwrap(), DevicePollOutcome::Denied));
    }
```

- [ ] **Step 3: Run tests**

```bash
cd client/src-tauri && cargo test --lib backend::tests
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/backend.rs
git commit -m "feat(client): implement device_poll with 6 outcomes"
```

---

## Task 8: `auth_me` — happy + 401 + Bearer header asserted on wire

**Files:**
- Modify: `client/src-tauri/src/backend.rs`

**Why:** confirms our auth header construction works. The `header` matcher in wiremock asserts the literal header value reaches the wire.

- [ ] **Step 1: Implement `auth_me`**

Inside `impl BackendClient`, below `device_poll`, add:

```rust
    /// `GET /api/v1/auth/me/` — returns the user currently bound to `token`.
    pub async fn auth_me(&self, token: &str) -> Result<User, BackendError> {
        let url = format!("{}/api/v1/auth/me/", self.base_url);
        let resp = self.http.get(&url).bearer_auth(token).send().await?;
        if !resp.status().is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json::<User>().await.map_err(BackendError::from)
    }
```

`.bearer_auth(token)` — reqwest helper that sets `Authorization: Bearer <token>`.

- [ ] **Step 2: Write the tests**

In `mod tests`, append:

```rust
    #[tokio::test]
    async fn auth_me_ok() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/me/"))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "github_login": "octocat",
                "github_user_id": 583231,
                "display_name": "Octo",
                "avatar_url": null
            })))
            .mount(&server)
            .await;
        let client = BackendClient::new(server.uri()).unwrap();
        let u = client.auth_me("stg_abc").await.unwrap();
        assert_eq!(u.github_login, "octocat");
    }

    #[tokio::test]
    async fn auth_me_401_unauthenticated() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/me/"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "message": "unauthenticated",
                "extra": {}
            })))
            .mount(&server)
            .await;
        let client = BackendClient::new(server.uri()).unwrap();
        let err = client.auth_me("stg_bad").await.unwrap_err();
        assert!(matches!(err, BackendError::Unauthenticated));
    }

    #[tokio::test]
    async fn auth_me_bearer_header_value_exact() {
        use wiremock::matchers::header;
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/me/"))
            .and(header("authorization", "Bearer stg_abc123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 1,
                "github_login": "u",
                "github_user_id": 1,
                "display_name": null,
                "avatar_url": null
            })))
            .mount(&server)
            .await;
        let client = BackendClient::new(server.uri()).unwrap();
        client.auth_me("stg_abc123").await.unwrap();
    }
```

The third test fails if the Bearer prefix isn't exact — protects against silent auth-header bugs.

- [ ] **Step 3: Run tests**

```bash
cd client/src-tauri && cargo test --lib backend::tests
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/backend.rs
git commit -m "feat(client): implement auth_me with Bearer header assertion"
```

---

## Task 9: `logout` — happy 204 + 401 + Bearer header asserted

**Files:**
- Modify: `client/src-tauri/src/backend.rs`

**Why:** rounds out the auth surface. Server-side action; SDK has no local state to clear (stateless).

- [ ] **Step 1: Implement `logout`**

Inside `impl BackendClient`, below `auth_me`, add:

```rust
    /// `POST /api/v1/auth/logout/` — revokes the session server-side.
    ///
    /// **Caller responsibility:** clear the local copy of `token` (memory,
    /// keychain) after this returns `Ok(())`. The SDK is stateless and has
    /// no local copy to clear; the server sets `revoked_at` on the session
    /// but the raw token string still lives in caller memory.
    pub async fn logout(&self, token: &str) -> Result<(), BackendError> {
        let url = format!("{}/api/v1/auth/logout/", self.base_url);
        let resp = self.http.post(&url).bearer_auth(token).send().await?;
        if !resp.status().is_success() {
            return Err(Self::map_error(resp).await);
        }
        Ok(())
    }
```

- [ ] **Step 2: Write tests**

In `mod tests`, append:

```rust
    #[tokio::test]
    async fn logout_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/logout/"))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let client = BackendClient::new(server.uri()).unwrap();
        client.logout("stg_abc").await.unwrap();
    }

    #[tokio::test]
    async fn logout_401_unauthenticated() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/logout/"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "message": "unauthenticated",
                "extra": {}
            })))
            .mount(&server)
            .await;
        let client = BackendClient::new(server.uri()).unwrap();
        let err = client.logout("stg_bad").await.unwrap_err();
        assert!(matches!(err, BackendError::Unauthenticated));
    }
```

- [ ] **Step 3: Run tests**

```bash
cd client/src-tauri && cargo test --lib backend::tests
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/backend.rs
git commit -m "feat(client): implement logout"
```

---

## Task 10: `with_timeout` actually honored — slow-server test

**Files:**
- Modify: `client/src-tauri/src/backend.rs`

**Why:** ensures the timeout setting reaches the wire. Without this test, a future refactor could drop the `.timeout(...)` line and we wouldn't notice.

- [ ] **Step 1: Add a slow-server test that proves the timeout fires**

In `mod tests`, append:

```rust
    #[tokio::test]
    async fn with_timeout_honored_on_slow_server() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/start/"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({
                        "device_code": "x", "user_code": "x",
                        "verification_uri": "x", "interval": 5, "expires_in": 900
                    }))
                    .set_delay(Duration::from_millis(500)),
            )
            .mount(&server)
            .await;

        let client =
            BackendClient::with_timeout(server.uri(), Duration::from_millis(50)).unwrap();
        let err = client.device_start().await.unwrap_err();
        assert!(matches!(err, BackendError::Transport(_)), "got {err:?}");
    }
```

`set_delay` makes wiremock wait before responding. Our 50ms client timeout fires before the 500ms server-side delay completes → `reqwest::Error::is_timeout()` → `BackendError::Transport`.

- [ ] **Step 2: Run the test**

```bash
cd client/src-tauri && cargo test --lib backend::tests::with_timeout_honored_on_slow_server
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src-tauri/src/backend.rs
git commit -m "test(client): verify with_timeout reaches the wire"
```

---

## Task 11: Manual smoke binary `examples/auth_smoke.rs`

**Files:**
- Create: `client/src-tauri/examples/auth_smoke.rs`

**Why:** acceptance criterion #6. Runs the actual device flow against a local Stage backend so you can eyeball the full loop end-to-end.

- [ ] **Step 1: Create the examples directory + file**

Create `client/src-tauri/examples/auth_smoke.rs` with:

```rust
//! Manual smoke binary for the BackendClient device-flow.
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

use stage_client_lib::backend::{BackendClient, DevicePollOutcome};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("STAGE_BACKEND_URL")
        .unwrap_or_else(|_| "http://localhost:8000".to_string());
    println!("backend: {url}");

    let client = BackendClient::new(&url)?;
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
        tokio::time::sleep(interval).await;
        match client.device_poll(&device.device_code).await? {
            DevicePollOutcome::Pending => {
                print!(".");
                continue;
            }
            DevicePollOutcome::SlowDown => {
                println!("(slow_down — bumping interval)");
                interval += Duration::from_secs(5);
            }
            DevicePollOutcome::Authorized(s) => break s,
            DevicePollOutcome::Expired => return Err("device_code expired".into()),
            DevicePollOutcome::Denied => return Err("user denied".into()),
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
```

Two notes:
- `use stage_client_lib::backend::{...}` — `stage_client_lib` is the crate's `lib` name from `Cargo.toml`. Examples can `use` items from the crate's library target.
- `Box<dyn std::error::Error>` — boilerplate for `main`-level error type that accepts any error. Fine for a binary; never use in library code.

For the example to compile, the `BackendClient`, `DeviceCode`, `User`, `SessionData`, `DevicePollOutcome` items must be publicly reachable. They are — they're `pub` in `backend.rs`, and `lib.rs` already declares `mod backend;`. But the module itself must be `pub` for cross-crate access. Step 2 fixes this.

- [ ] **Step 2: Make `mod backend;` public in `lib.rs`**

Open `client/src-tauri/src/lib.rs` and change line 1 from:

```rust
mod backend;
```

to:

```rust
pub mod backend;
```

Leave all other lines untouched. This is the minimal exposure needed for the example binary; nothing inside Tauri's command surface depends on this module yet.

- [ ] **Step 3: Verify the example compiles**

```bash
cd client/src-tauri && cargo check --example auth_smoke
```

Expected: PASS.

- [ ] **Step 4: (Optional) Run the example end-to-end**

This requires a working Stage backend with a real GitHub OAuth app + admin PAT. In a second terminal:

```bash
cd backend && just dev    # spins up Django on :8000
```

In the original terminal:

```bash
cd client/src-tauri && cargo run --example auth_smoke
```

Expected: prints `verification_uri` + `user_code`. Open the URL in a browser, paste the code, authorize. The example then prints `Authorized!`, the `auth_me` result, and `logout: ok`.

**If you cannot run a real backend right now, skip this step.** The example must at minimum compile (step 3). The compile success is the binary acceptance criterion.

- [ ] **Step 5: Commit**

```bash
git add client/src-tauri/examples/auth_smoke.rs client/src-tauri/src/lib.rs
git commit -m "feat(client): add auth_smoke example binary; expose backend module"
```

---

## Task 12: Final verify pipeline + acceptance checklist

**Files:**
- No code changes. Verification only.

**Why:** confirms the entire slice meets the acceptance criteria from the spec (§ 7).

- [ ] **Step 1: Run cargo check across all targets**

```bash
cd client/src-tauri && cargo check --all-targets
```

Expected: PASS.

- [ ] **Step 2: Run cargo clippy with warnings-as-errors**

```bash
cd client/src-tauri && cargo clippy --all-targets -- -D warnings
```

Expected: PASS with zero warnings.

- [ ] **Step 3: Run the full test suite**

```bash
cd client/src-tauri && cargo test --lib backend::
```

Expected: PASS. Count the tests printed — should be roughly:
- 4 construction tests (new_rejects_malformed_url, new_accepts_str_and_string, new_trims_trailing_slash, with_timeout_constructs)
- 4 type roundtrip tests (DeviceCode, User present, User null, SessionData)
- 2 DevicePollSuccess wire tests (pending, ok)
- 3 device_start tests (ok, 500, transport)
- 6 device_poll tests (pending, authorized, auth_pending→pending, slow_down, expired, denied)
- 3 auth_me tests (ok, 401, header-value-exact)
- 2 logout tests (ok, 401)
- 1 with_timeout-honored test

Total: 25 tests.

- [ ] **Step 4: Confirm cargo build has no new warnings**

```bash
cd client/src-tauri && cargo build --all-targets 2>&1 | grep -i warning || echo "no warnings"
```

Expected: prints "no warnings". If any warnings appear, address them before commit.

- [ ] **Step 5: Confirm the example binary compiles (acceptance #6)**

```bash
cd client/src-tauri && cargo check --example auth_smoke
```

Expected: PASS.

- [ ] **Step 6: Confirm no TODO / FIXME in merged code (acceptance #7)**

```bash
git diff main -- client/src-tauri/src/backend.rs client/src-tauri/examples/auth_smoke.rs | grep -iE '^\+.*(TODO|FIXME)' || echo "clean"
```

Expected: prints "clean".

- [ ] **Step 7: Cross-check the public-symbol acceptance (#1)**

```bash
grep -E '^pub (struct|enum|fn)' client/src-tauri/src/backend.rs
```

Expected output includes:
- `pub struct BackendClient`
- `pub struct DeviceCode`
- `pub struct User`
- `pub struct SessionData`
- `pub enum BackendError`
- `pub enum DevicePollOutcome`

Six public symbols present.

- [ ] **Step 8: Final summary commit (squash markers if any local fix-ups landed)**

If everything passes, the work is done. No additional commit needed unless step 4 or 6 surfaced something. If they did:

```bash
git add -p   # selectively stage the cleanups
git commit -m "chore(client): final verify pass cleanups"
```

---

## Done condition

All 8 acceptance criteria from spec § 7 are met:

1. ✅ `backend.rs` exports `BackendClient`, `DeviceCode`, `User`, `SessionData`, `DevicePollOutcome`, `BackendError`.
2. ✅ `cargo check --all-targets` passes.
3. ✅ `cargo clippy --all-targets -- -D warnings` passes.
4. ✅ All ~25 test cases pass via `cargo test --lib backend::`.
5. ✅ `cargo build` produces no new warnings.
6. ✅ `examples/auth_smoke.rs` exists and compiles (runs end-to-end if a backend is available).
7. ✅ No TODO / FIXME in the merged code.
8. ✅ `lib.rs` changed only to make `mod backend` public for the example binary — no Tauri commands wired.

Branch ready to PR. Next slice (Tauri commands + keychain integration) is its own plan.
