# Design — Backend client seam (Rust SDK, auth slice)

**Status:** Draft for grill-with-docs review
**Date:** 2026-05-24
**Slice scope:** Pure-Rust `BackendClient` SDK covering the four `/api/v1/auth/*` endpoints. No Tauri commands, no keychain, no SignIn UI changes.
**See also:** `docs/design.md` § 7 (auth), `docs/api.md` § Authentication, `CONTEXT.md` (Topology + Language)

> Disclaimer: design intent. Double-check with a qualified reviewer before any production use.

---

## 1 — Architecture overview

The new module is `client/src-tauri/src/backend.rs` — replacing the current placeholder doc-comment that reserves the slot. It lives **inside the existing Tauri crate**, consistent with `client/STACK.md`: "Single Cargo crate under src-tauri/. Not a Cargo workspace."

The module is **pure-library Rust**. Nothing in this slice depends on Tauri APIs. A future slice will add `#[tauri::command]` thin wrappers around it.

### Scope

In:

- `BackendClient` struct + four async methods covering `/api/v1/auth/device/start/`, `/api/v1/auth/device/poll/`, `/api/v1/auth/me/`, `/api/v1/auth/logout/`.
- Typed request/response structs via `serde`.
- `BackendError` enum via `thiserror`.
- Unit tests against an in-process `wiremock` HTTP mock.

Out (deferred to later slices):

- Tauri commands.
- Keychain integration.
- Workspace / storyline / intro-comment / open-pr / github-proxy endpoints.
- Retry / backoff at the HTTP layer.
- SignIn.tsx changes.

### Dependencies

```toml
[dependencies]
reqwest = { version = "0.13.3", default-features = false, features = ["json", "rustls"] }
tokio    = { version = "1.52.3", features = ["macros", "rt", "rt-multi-thread", "time"] }
thiserror = "2.0.18"   # bumped from "1" — minor breaking, affects existing errors.rs
# unchanged: serde, serde_json, tracing, tracing-subscriber, parking_lot

[dev-dependencies]
wiremock = "0.6.5"
```

Rationale:

- `reqwest` with `rustls` + no default features avoids OpenSSL pain across macOS / CI. (Feature name is `rustls` in reqwest 0.13+; was `rustls-tls` in 0.11/0.12.) **Caveat:** reqwest 0.13 + `rustls` selects rustls 0.23, whose default crypto provider is `aws-lc-rs`. `aws-lc-sys` ships pre-built binaries for macOS (arm64 + x86_64) so no native-toolchain step is needed there, but other targets (Linux musl, BSD) may require `cmake` + a C compiler at build time. Accepted trade-off — we get out-of-the-box rustls without OpenSSL on the desktop client's primary target (macOS), at the cost of a `cmake` requirement on tier-2 CI runners. Switching to the `ring` provider requires `features = ["json", "rustls-no-provider"]` + a manual `rustls::crypto::ring::default_provider().install_default()` call at startup — heavier; not worth it for the slice scope.
- `tokio` features narrowed to what's actually used; Tauri pulls in tokio with broader features and Cargo will unify.
- `thiserror` 2 is mostly compatible with the basic `#[derive]` + `#[error("...")]` usage in `errors.rs`. Verified at implementation time.
- `wiremock` is dev-only.

Explicitly NOT bumped in this slice: `git2`, `notify`, `notify-debouncer-mini`, `tauri`. Those involve breaking API changes that don't touch our module. A separate "modernize transitive deps" pass owns them.

---

## 2 — Public API surface

```rust
pub struct BackendClient {
    base_url: String,   // validated + trailing-slash-trimmed in `new`
    http: reqwest::Client,
}

pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

pub struct User {
    pub id: i64,
    pub github_login: String,
    pub github_user_id: i64,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

pub struct SessionData {
    pub session_token: String,  // raw "stg_..." — returned exactly once
    pub user: User,
}

pub enum DevicePollOutcome {
    Pending,                    // GitHub returned authorization_pending
    SlowDown,                   // GitHub returned slow_down — caller should bump interval
    Authorized(SessionData),
    Expired,                    // device_code expired (>15min)
    Denied,                     // user clicked deny
}

impl BackendClient {
    /// Construct with default 30s HTTP timeout.
    pub fn new(base_url: impl AsRef<str>) -> Result<Self, BackendError>;

    /// Construct with explicit HTTP timeout.
    pub fn with_timeout(
        base_url: impl AsRef<str>,
        timeout: std::time::Duration,
    ) -> Result<Self, BackendError>;

    pub async fn device_start(&self) -> Result<DeviceCode, BackendError>;
    pub async fn device_poll(&self, device_code: &str)
        -> Result<DevicePollOutcome, BackendError>;
    pub async fn auth_me(&self, token: &str) -> Result<User, BackendError>;
    pub async fn logout(&self, token: &str) -> Result<(), BackendError>;
}
```

Five public types + `BackendError`. Methods are `&self` — caller can keep using the client across calls; `reqwest::Client` is `Arc`-wrapped internally so clones are cheap.

`base_url` is stored as a trailing-slash-trimmed `String` after parse-validation through `reqwest::Url::parse` in `new`. Final endpoint URLs are built via `format!("{}/api/v1/auth/device/start/", self.base_url)` — dodges `Url::join`'s "replace-last-segment" surprise when a base has no trailing slash.

The internal `reqwest::Client` is built with:
- `.timeout(Duration::from_secs(30))` (or the explicit timeout from `with_timeout`)
- `.user_agent(concat!("stage-client/", env!("CARGO_PKG_VERSION")))`

`SessionData` deliberately does **not** derive `Debug` — the raw token must not leak into logs. The `session_token: String` field carries a doc-comment forbidding logging; no `secrecy` wrapper at this slice (see § 9 open-question 4 for the resolution + future revisit trigger).

`SessionData` and `DevicePollOutcome` are also intentionally move-only — **no `Clone` derive** on either. Calling `.clone()` on a token-carrying value would duplicate the heap-allocated `session_token` into a second buffer, and the no-`Debug` discipline only protects the original variable name, not its copies. Callers destructure `Authorized(SessionData { session_token, user })` once at the matchsite and own each piece separately — one heap copy of the token at a time. `User` and `DeviceCode` keep `Clone` because they carry no secret. Resolved post-impl grill 2026-05-25.

`logout(token)` returns `Ok(())` on success. **Caller is responsible for clearing its own local copy of the token after `logout` returns** — the SDK is stateless, so it has no copy to clear; the server-side `revoked_at` flag is set, but the raw string still lives in caller memory / keychain until the caller zeros / removes it. Doc-comment on `logout` makes this explicit.

### Stateless token handling

The SDK never stores the session token. Every authed method takes `token: &str`. The caller owns token lifecycle (e.g., the future Tauri layer reads from keychain, passes into BackendClient calls). Rationale: no interior mutability needed in the SDK; library stays a thin shim; topology stays honest about who owns auth state.

---

## 3 — Data flow

### Device flow walkthrough

```
Caller                            BackendClient                   Stage backend             GitHub
  │                                    │                                │                      │
  │── device_start() ─────────────────▶│                                │                      │
  │                                    │── POST /api/v1/auth/device/start/  (empty body) ─────▶│
  │                                    │                                │── POST /login/device/code ───▶│
  │                                    │                                │◀────  device_code ─────────────│
  │                                    │◀── 200 {device_code, user_code, verification_uri, interval, expires_in}
  │◀── Ok(DeviceCode) ─────────────────│
  │
  │  [caller displays user_code + verification_uri,
  │   loops on device_poll with `interval` cadence]
  │
  │── device_poll(device_code) ───────▶│
  │                                    │── POST /api/v1/auth/device/poll/  {"device_code": "..."} ─────▶
  │                                    │                                │── poll github for token ───────▶
  │                                    │◀── 200 {"status": "pending"} (or "ok" w/ session_token + user)
  │◀── Ok(Pending) ────────────────────│   (loop continues until terminal)
  │
  │── [eventually] device_poll(...) ──▶│
  │                                    │── ... ─────────────────────────▶│── ... ──────────────────────▶│
  │                                    │◀── 200 {"status": "ok", "session_token": "stg_...", "user": {...}}
  │◀── Ok(Authorized(SessionData)) ────│   ← caller persists session_token now
```

### Caller-owned polling loop

The SDK does not loop. Caller writes:

```rust
let device = client.device_start().await?;
println!("Open {} and enter {}", device.verification_uri, device.user_code);

let deadline = std::time::Instant::now() + std::time::Duration::from_secs(device.expires_in);
let mut interval = std::time::Duration::from_secs(device.interval);

let session = loop {
    if std::time::Instant::now() > deadline { break Err("client_deadline_exceeded"); }
    tokio::time::sleep(interval).await;
    match client.device_poll(&device.device_code).await? {
        DevicePollOutcome::Pending       => continue,
        DevicePollOutcome::SlowDown      => { interval += std::time::Duration::from_secs(5); continue; }
        DevicePollOutcome::Authorized(s) => break Ok(s),
        DevicePollOutcome::Expired       => break Err("expired"),
        DevicePollOutcome::Denied        => break Err("denied"),
    }
};
```

Reasons not to loop inside the SDK: (a) cancellation is trivial — caller stops calling; (b) caller owns UX (countdown, retry indicators); (c) test boundaries are crisper — one poll per call.

### Backend response → `DevicePollOutcome` mapping

| Backend response | Outcome |
|---|---|
| `200 {"status": "pending"}` | `Pending` |
| `200 {"status": "ok", "session_token": "stg_...", "user": {...}}` | `Authorized(SessionData)` |
| `4xx {"message": "github_error", "extra": {"error": "expired_token"}}` | `Expired` |
| `4xx {"message": "github_error", "extra": {"error": "access_denied"}}` | `Denied` |
| `4xx {"message": "github_error", "extra": {"error": "slow_down"}}` | `SlowDown` |
| `4xx {"message": "github_error", "extra": {"error": "authorization_pending"}}` | `Pending` |
| Anything else | `Err(BackendError::...)` |

The SDK encodes the RFC 8628 device-flow error vocabulary (`authorization_pending`, `slow_down`, `access_denied`, `expired_token`). This vocabulary is stable since 2019 and worth absorbing locally — see "Existing crates surveyed" below for why we don't import an external enum.

### `auth_me(token)` and `logout(token)`

```
auth_me:   GET  /api/v1/auth/me/        Authorization: Bearer <token>   → User
logout:    POST /api/v1/auth/logout/    Authorization: Bearer <token>   → ()  (204)
```

---

## 4 — Error model

```rust
#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("invalid base url: {0}")]
    InvalidBaseUrl(String),

    #[error("transport failure: {0}")]
    Transport(#[from] reqwest::Error),

    #[error("unauthenticated (401)")]
    Unauthenticated,

    #[error("validation error: {extra}")]
    Validation { extra: serde_json::Value },

    #[error("github error (status {status}): {extra}")]
    Github { status: u16, extra: serde_json::Value },

    #[error("unexpected response (status {status}): {message}")]
    Unexpected { status: u16, message: String, extra: serde_json::Value },
}
```

### Mapping rules

Every non-2xx response goes through one matcher reading the `{"message": "<slug>", "extra": {...}}` envelope:

| Status | `message` slug | Variant |
|---|---|---|
| any 2xx | n/a (success path) | — |
| 401 | `unauthenticated` | `Unauthenticated` |
| 400 | `validation_error` | `Validation { extra }` |
| any 4xx/5xx | `github_error` | `Github { status, extra }` |
| 4xx/5xx | any other slug | `Unexpected { status, message, extra }` |
| 4xx/5xx | envelope missing or unparseable | `Unexpected { status, message: "", extra: Null }` |

`Transport(reqwest::Error)` catches: DNS failure, connect refused, TLS handshake fail, body read timeout, etc. JSON decode failures on a 2xx response surface as `Unexpected { status: 200, message: "body decode failed: ...", extra: Null }` — reqwest doesn't expose its inner `serde_json::Error` directly, so we route through `Unexpected` rather than introduce a separate `Decode` variant we can't populate cleanly. (Earlier draft had a `Decode(serde_json::Error)` variant; dropped during T8 review when the implementation reality became clear.)

### Deliberately NOT split

No variant for `pr_already_open`, `workspace_frozen`, `etag_mismatch`, `forbidden`, `not_found` — not relevant to the auth slice. When workspace endpoints land later, we extend the enum then.

---

## 5 — Testing strategy

### Two layers

**Layer A — type roundtrip tests.** Pure-Rust, no I/O. Each `serde` struct deserialized from a canonical JSON payload taken from `docs/api.md`. Catches drift between doc contract and types.

**Layer B — HTTP integration tests.** `wiremock` spins up an in-process HTTP server on a random port. Each test arranges a mock response, instantiates `BackendClient` pointed at the mock server's URL, calls one method, asserts on the typed result and on the wire headers.

### Test matrix

| Method | Cases |
|---|---|
| `BackendClient::new` | accepts `&str`; accepts `String`; rejects malformed URL → `InvalidBaseUrl`; trailing slash tolerated (`http://x:8000` and `http://x:8000/` produce identical wire calls); default timeout = 30s observable via slow-server scenario |
| `BackendClient::with_timeout` | custom timeout honored: tight timeout (50ms) against slow mock (200ms delay) → `Transport` w/ timeout error |
| `device_start` | 200 happy path; 500 → `Github`; transport error (server down) → `Transport` |
| `device_poll` | 200 pending → `Pending`; 200 ok → `Authorized(_)`; 4xx `expired_token` → `Expired`; 4xx `slow_down` → `SlowDown`; 4xx `access_denied` → `Denied`; 4xx `authorization_pending` → `Pending` |
| `auth_me` | 200 → populated `User`; 401 → `Unauthenticated`; Bearer header asserted on wire |
| `logout` | 204 → `Ok(())`; 401 → `Unauthenticated`; Bearer header asserted |

Authenticated calls (auth_me, logout) **assert that the Bearer header was actually sent** — protects against silent-failure where auth is forgotten.

**Coverage gaps acknowledged.** The matrix above is the required baseline. Variants `Decode`, `Validation`, and `Unexpected` are reachable but not exercised in the baseline — flagged for grill review whether worth additional cases. Cheap to add later as regression tests if a real bug surfaces.

### Wiremock example

```rust
#[tokio::test]
async fn device_start_ok() {
    use wiremock::{Mock, MockServer, ResponseTemplate};
    use wiremock::matchers::{method, path};

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
    let result = client.device_start().await.unwrap();

    assert_eq!(result.user_code, "ABCD-1234");
    assert_eq!(result.interval, 5);
}
```

### Out of scope

- Real backend calls in CI. Manual smoke recipe is part of acceptance (see § 7).
- Real GitHub. Stays mocked end-to-end via wiremock.
- Performance / load. Not relevant at SDK layer.
- Concurrency / race conditions. `reqwest::Client` is `Arc`-safe internally; we add no shared mutable state.

---

## 6 — Existing crates surveyed (why we hand-roll)

| Crate | Library-usable? | Targets our backend? | Has typed device-flow error enum? | Verdict |
|---|---|---|---|---|
| **`oauth2-rs`** v5 | yes, mature | **no** — talks RFC 8628 form-encoded to provider directly | yes — `DeviceCodeErrorResponseType { AuthorizationPending, SlowDown, AccessDenied, ExpiredToken, Basic }` | Wire shape mismatch |
| **`gh-device-flow`** | yes, active | **no** — talks directly to `github.com` | **no** — only `GitHubError(String)` opaque wrapper | Wrong topology + no typed enum |
| `oauth-device-flows` | yes | no — generic OAuth provider | unclear | Same topology problem |
| `yup-oauth2` | yes | no — Google-shaped | n/a | Out |

**Topology blocker.** Every Rust device-flow crate talks directly to the OAuth provider. Stage's wire surface is the Stage backend, not GitHub. Request body is JSON (`{"device_code": "..."}`), not form-encoded; response is `{"status": "ok", "session_token": "stg_..."}`, not OAuth tokens. A crate can't be redirected to our URL — the wire shape itself differs. Confirmed via `docs/design.md` § 7: "the github access token is then discarded" — only Stage session tokens cross our wire.

**Why not import `oauth2-rs::DeviceCodeErrorResponseType` alone.** Pulling oauth2 in for ~10 lines of enum = transitive dep weight + lock-in to a crate we're not using for anything else. RFC 8628 error vocabulary is stable since 2019. Hand-rolled 5-line `DevicePollOutcome` is the right cost.

**`gh-device-flow` as inspiration.** Worth reading for Rust idioms (struct shape, polling ergonomics) but not for import — its `DeviceFlowError(String)` is less typed than our `DevicePollOutcome` anyway.

---

## 7 — Acceptance criteria

Slice is done when **all** hold:

1. `client/src-tauri/src/backend.rs` contains `BackendClient`, `DeviceCode`, `User`, `SessionData`, `DevicePollOutcome`, `BackendError` — exported public.
2. `cargo check` passes from `client/src-tauri/`.
3. `cargo clippy --all-targets -- -D warnings` passes.
4. `cargo test --lib backend::` passes with the test cases from § 5 (~13 cases).
5. `cargo build` produces no new warnings.
6. Manual smoke recipe documented in `client/src-tauri/examples/auth_smoke.rs`: assumes `backend/` running on `http://localhost:8000`, runs the full device-flow loop end-to-end. Invoked via `cargo run --example auth_smoke`. Not in CI.
7. No TODO / FIXME left in merged code.
8. `lib.rs` declares the module as `pub mod backend;` (one-character change from the original `mod backend;`) so the `examples/auth_smoke.rs` binary can reach it via `stage_client_lib::backend::*`. No Tauri commands wired — that scope criterion holds. (Resolved during T11: the example binary needs cross-crate visibility; `pub(crate)` doesn't reach `examples/`.)

---

## 8 — Rust-junior pedagogy notes

Concepts you'll touch, in dependency order, with one-line model + lookup hint:

| Concept | One-line model | Lookup |
|---|---|---|
| `Result<T, E>` | "either a value or an error — caller must handle both" | [Rust Book §9.2](https://doc.rust-lang.org/book/ch09-02-recoverable-errors-with-result.html) |
| `?` operator | "if Err, propagate; else unwrap and continue" | Rust Book §9.2 |
| `async fn` + `.await` | "function returns a Future; .await runs it on the runtime" | [Async Book](https://rust-lang.github.io/async-book/) ch.1-3 |
| `#[tokio::test]` | "test version of `#[test]` that runs in an async runtime" | tokio docs |
| `#[derive(Serialize, Deserialize)]` | "compiler generates JSON converters for this struct" | serde docs |
| enum with data | "tagged union — variant + payload per case" | Rust Book §6 |
| `thiserror::Error` derive | "macro that writes Display + Error trait impls for you" | thiserror README |
| `reqwest::Client` | "HTTP client, cheap to clone (internally Arc-wrapped)" | reqwest docs |
| pattern matching | "`match outcome { Pending => ..., Authorized(s) => ... }`" | Rust Book §6.2 |

Each one is introduced inline at first appearance during implementation.

---

## 9 — Open questions to grill against existing docs

To be resolved by the grill-with-docs session that follows this design:

1. **Backend URL configuration at runtime.** ~~Resolved in grill 2026-05-24~~. The SDK stays URL-agnostic — constructor takes `&str`. **This slice:** `examples/auth_smoke.rs` reads env var `STAGE_BACKEND_URL`, defaults to `http://localhost:8000`. **Future Tauri-commands slice:** read from `tauri.conf.json` extras section; plumb through `AppState`. **Future CLI use:** read from env / CLI arg same as smoke. The SDK does not pick a config story; each caller does. **Action:** add a roadmap note so future Tauri slice doesn't drop the runtime-config path.
2. **`SessionData.session_token` lifetime contract.** Doc says "returned exactly once at issue time." The BackendClient returns it once via `DevicePollOutcome::Authorized(SessionData)`. Does this need a stronger type signal (e.g., a `MustPersist<T>` wrapper)? Probably YAGNI but worth flagging.
3. **Naming.** ~~Resolved in grill 2026-05-24~~: keep `BackendClient`. The name overloads with "Local Client" from `CONTEXT.md` / ADR-0001 (which means the desktop app). Module-level doc comment pins the SDK meaning: "SDK that talks to the Stage backend; do not confuse with the Local Client from the topology."
4. **Token in logs.** ~~Resolved in grill 2026-05-24~~: discipline + no `Debug` derive on `SessionData`. No `secrecy` crate. Rationale: client runs locally, threat surface is narrow, and the wrapper would add boilerplate at every header-construction site. Doc-comment on `SessionData.session_token` explicitly forbids logging. Per `docs/design.md` § 7 the token is long-lived (no auto-expiry) until user-initiated logout, so the discipline must hold across the whole session lifetime — worth revisiting if the threat model shifts (e.g., a CLI binary that ships logs).
5. **Doc fidelity.** All 4 auth endpoint shapes must match `docs/api.md` word-for-word. Cross-check during grill.
6. **Observability inside the SDK.** ~~Resolved post-impl grill 2026-05-25~~: SDK emits `tracing` events at three levels. `debug!` per method entry carries the URL only — never the token. `info!` on terminal device-flow outcomes (`Authorized` carries `github_login`; `Expired` / `Denied` carry no payload). `warn!` at each call site after `map_error` on non-2xx — NOT inside `map_error` itself, because `device_poll`'s 4xx fall-through (slug-driven outcomes) is the hot path and emitting there would spam the log every interval-tick. The `BackendError::Display` impl is used (`err = %err`), which prints the slug + status but never reaches inside a `SessionData`. Tokens stay redacted via the chain: `SessionData` has no `Debug` → `DevicePollOutcome::Authorized` Debug-redacts → no tracing call-site ever names `session_token`.

---

## 10 — Out of scope (deliberate)

Same list as § 1 "Out", restated for emphasis. Each is its own slice on the MVP path:

- Tauri commands wrapping the BackendClient.
- Keychain integration (`keyring-rs` / `tauri-plugin-keyring`).
- SignIn.tsx wiring (drop SSO per grill C1; render device-flow UI).
- Workspaces endpoints (workspaces, storyline, intro-comments, open-pr, reopen-pr, lookup).
- Github-proxy endpoints (PR-anchored read + write-through).
- Github search (`/github/prs/`).
- Retry / backoff at HTTP layer.
- Connection pooling / timeout tuning.

---

## 11 — See also

- `CONTEXT.md` — Topology + glossary.
- `docs/design.md` § 7 — Authentication as-built on the backend side.
- `docs/api.md` § Authentication — REST contract for the four endpoints.
- `docs/adr/0001-three-tier-topology.md` — rationale for client ⇆ backend ⇆ github invariant.
- `client/STACK.md` — client stack choices (single Cargo crate, no workspace).
- `docs/ROADMAP.md` — phase 2a/2b OAuth migration path (later slices).
- `docs/adr/0005-local-client-sdk-hand-rolls-device-flow.md` — captures the survey + topology rationale for not importing `oauth2-rs` (or any OAuth crate). Created during the grill-with-docs session that produced this spec.
- `docs/adr/0006-local-client-sdk-stateless-caller-owned-loop.md` — canonicalises the stateless-token + caller-owned-poll-loop choices that this spec describes inline in § 2 / § 3. Created during the post-implementation grill 2026-05-25.
