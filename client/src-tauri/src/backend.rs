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
/// `SessionData` is intentionally move-only (no `Clone`): callers destructure once
/// into `session_token: String` + `user: User` and own each piece — one heap copy
/// of the token at a time.
/// Per `docs/design.md` § 7 the token is long-lived until user-initiated logout.
#[derive(serde::Deserialize)]
pub struct SessionData {
    pub session_token: String,
    pub user: User,
}

/// Caller-facing outcome of one `device_poll` call. The caller's loop picks
/// the next action based on which variant matches.
pub enum DevicePollOutcome {
    /// GitHub returned `authorization_pending` — keep polling at the same cadence.
    Pending,
    /// GitHub returned `slow_down` — caller must add 5 s to its polling interval (RFC 8628 § 3.5).
    SlowDown,
    /// User completed the device-flow — caller persists the session_token.
    Authorized(SessionData),
    /// `device_code` expired (>15 min since `device_start`).
    Expired,
    /// User clicked deny on the GitHub authorize page.
    Denied,
}

// Manual Debug: redact the Authorized payload so session_token never appears in logs.
impl std::fmt::Debug for DevicePollOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "Pending"),
            Self::SlowDown => write!(f, "SlowDown"),
            Self::Authorized(_) => write!(f, "Authorized(<redacted>)"),
            Self::Expired => write!(f, "Expired"),
            Self::Denied => write!(f, "Denied"),
        }
    }
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

/// SDK handle for the Stage backend. Cheap to clone.
#[derive(Clone, Debug)]
pub struct BackendClient {
    base_url: String, // validated + trailing-slash-trimmed via `reqwest::Url::parse`
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
        let parsed = reqwest::Url::parse(raw)
            .map_err(|e| BackendError::InvalidBaseUrl(e.to_string()))?;
        let trimmed = parsed.as_str().trim_end_matches('/').to_string();
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

    fn json_err(status: u16, e: reqwest::Error) -> BackendError {
        if e.is_decode() {
            BackendError::Unexpected {
                status,
                message: format!("body decode failed: {e}"),
                extra: serde_json::Value::Null,
            }
        } else {
            BackendError::Transport(e)
        }
    }

    // Intentionally silent: `device_poll`'s 4xx slug fall-through (authorization_pending,
    // slow_down, access_denied, expired_token) is the polling hot path; emitting tracing
    // here would spam the log on every tick. Callers — device_start, device_poll's
    // unknown-slug branch, auth_me, logout — emit `tracing::warn!` themselves after this returns.
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
        let (message, extra) = parsed.unwrap_or_else(|| (body.clone(), serde_json::Value::Null));
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

    /// `POST /api/v1/auth/device/start/` — kicks off the device flow.
    pub async fn device_start(&self) -> Result<DeviceCode, BackendError> {
        let url = format!("{}/api/v1/auth/device/start/", self.base_url);
        tracing::debug!(url = %url, "POST device/start");
        let resp = self.http.post(&url).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let err = Self::map_error(resp).await;
            tracing::warn!(err = %err, "device_start non-2xx");
            return Err(err);
        }
        let status_code = status.as_u16();
        resp.json::<DeviceCode>().await.map_err(|e| Self::json_err(status_code, e))
    }


    /// `POST /api/v1/auth/device/poll/` — one poll attempt.
    ///
    /// The caller drives the loop. Returns a `DevicePollOutcome` describing
    /// the terminal-or-non-terminal state of the device flow.
    pub async fn device_poll(
        &self,
        device_code: &str,
    ) -> Result<DevicePollOutcome, BackendError> {
        let url = format!("{}/api/v1/auth/device/poll/", self.base_url);
        tracing::debug!(url = %url, "POST device/poll");
        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({ "device_code": device_code }))
            .send()
            .await?;
        let status = resp.status();
        if status.is_success() {
            let status_code = status.as_u16();
            let parsed: DevicePollSuccess = resp.json().await.map_err(|e| Self::json_err(status_code, e))?;
            let outcome = match parsed {
                DevicePollSuccess::Pending => DevicePollOutcome::Pending,
                DevicePollSuccess::Ok {
                    session_token,
                    user,
                } => {
                    tracing::info!(github_login = %user.github_login, "device-flow authorized");
                    DevicePollOutcome::Authorized(SessionData {
                        session_token,
                        user,
                    })
                }
            };
            return Ok(outcome);
        }
        // Non-2xx. Interpret the envelope. github_error with a known device-flow
        // slug maps to its DevicePollOutcome variant; otherwise propagate as
        // BackendError.
        let err = Self::map_error(resp).await;
        if let BackendError::Github { ref extra, .. } = err {
            if let Some(slug) = extra.get("error").and_then(|v| v.as_str()) {
                match slug {
                    "authorization_pending" => return Ok(DevicePollOutcome::Pending),
                    "slow_down" => return Ok(DevicePollOutcome::SlowDown),
                    "access_denied" => {
                        tracing::info!("device-flow denied");
                        return Ok(DevicePollOutcome::Denied);
                    }
                    "expired_token" => {
                        tracing::info!("device-flow expired");
                        return Ok(DevicePollOutcome::Expired);
                    }
                    _ => {}
                }
            }
        }
        tracing::warn!(err = %err, "device_poll non-2xx (no known slug)");
        Err(err)
    }

    /// `GET /api/v1/auth/me/` — returns the user currently bound to `token`.
    pub async fn auth_me(&self, token: &str) -> Result<User, BackendError> {
        let url = format!("{}/api/v1/auth/me/", self.base_url);
        tracing::debug!(url = %url, "GET auth/me");
        let resp = self.http.get(&url).bearer_auth(token).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let err = Self::map_error(resp).await;
            tracing::warn!(err = %err, "auth_me non-2xx");
            return Err(err);
        }
        let status_code = status.as_u16();
        resp.json::<User>().await.map_err(|e| Self::json_err(status_code, e))
    }

    /// `POST /api/v1/auth/logout/` — revokes the session server-side.
    ///
    /// **Caller responsibility:** clear the local copy of `token` (memory,
    /// keychain) after this returns `Ok(())`. The SDK is stateless and has
    /// no local copy to clear; the server sets `revoked_at` on the session
    /// but the raw token string still lives in caller memory.
    pub async fn logout(&self, token: &str) -> Result<(), BackendError> {
        let url = format!("{}/api/v1/auth/logout/", self.base_url);
        tracing::debug!(url = %url, "POST auth/logout");
        let resp = self.http.post(&url).bearer_auth(token).send().await?;
        if !resp.status().is_success() {
            let err = Self::map_error(resp).await;
            tracing::warn!(err = %err, "logout non-2xx");
            return Err(err);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, header_exists, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn new_rejects_malformed_url() {
        let err = BackendClient::new("not a url").unwrap_err();
        assert!(matches!(err, BackendError::InvalidBaseUrl(_)));
    }

    #[test]
    fn new_accepts_str_and_string() {
        let from_str = BackendClient::new("http://localhost:8000").unwrap();
        let from_string = BackendClient::new(String::from("http://localhost:8000")).unwrap();
        assert_eq!(from_str.base_url, "http://localhost:8000");
        assert_eq!(from_string.base_url, from_str.base_url);
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
        assert_eq!(dc.device_code, "abc123");
        assert_eq!(dc.user_code, "ABCD-1234");
        assert_eq!(dc.verification_uri, "https://github.com/login/device");
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
        assert_eq!(s.user.id, 42);
    }

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
                assert_eq!(user.github_login, "u");
            }
            _ => panic!("expected Ok variant"),
        }
    }

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
        match &err {
            BackendError::Unexpected { status: 500, message, .. } => {
                assert_eq!(message, "internal err");
            }
            _ => panic!("got {err:?}"),
        }
    }

    #[tokio::test]
    async fn device_start_200_with_bad_body_maps_to_unexpected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/start/"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json at all"))
            .mount(&server)
            .await;
        let client = BackendClient::new(server.uri()).unwrap();
        let err = client.device_start().await.unwrap_err();
        assert!(
            matches!(&err, BackendError::Unexpected { status: 200, .. }),
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

    async fn arrange_poll_github_error(server: &MockServer, slug: &str) {
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
        arrange_poll_github_error(&server, "authorization_pending").await;
        let client = BackendClient::new(server.uri()).unwrap();
        assert!(matches!(client.device_poll("dc").await.unwrap(), DevicePollOutcome::Pending));
    }

    #[tokio::test]
    async fn device_poll_slow_down() {
        let server = MockServer::start().await;
        arrange_poll_github_error(&server, "slow_down").await;
        let client = BackendClient::new(server.uri()).unwrap();
        assert!(matches!(client.device_poll("dc").await.unwrap(), DevicePollOutcome::SlowDown));
    }

    #[tokio::test]
    async fn device_poll_expired() {
        let server = MockServer::start().await;
        arrange_poll_github_error(&server, "expired_token").await;
        let client = BackendClient::new(server.uri()).unwrap();
        assert!(matches!(client.device_poll("dc").await.unwrap(), DevicePollOutcome::Expired));
    }

    #[tokio::test]
    async fn device_poll_denied() {
        let server = MockServer::start().await;
        arrange_poll_github_error(&server, "access_denied").await;
        let client = BackendClient::new(server.uri()).unwrap();
        assert!(matches!(client.device_poll("dc").await.unwrap(), DevicePollOutcome::Denied));
    }

    #[tokio::test]
    async fn device_poll_unknown_slug_propagates_as_backend_error() {
        let server = MockServer::start().await;
        arrange_poll_github_error(&server, "nonsense_error").await;
        let client = BackendClient::new(server.uri()).unwrap();
        let err = client.device_poll("dc").await.unwrap_err();
        assert!(
            matches!(err, BackendError::Github { .. }),
            "expected Github error, got {err:?}"
        );
    }

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

    #[tokio::test]
    async fn auth_me_401_bare_no_envelope() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/me/"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let client = BackendClient::new(server.uri()).unwrap();
        let err = client.auth_me("stg_bad").await.unwrap_err();
        assert!(matches!(err, BackendError::Unauthenticated), "got {err:?}");
    }

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

    #[tokio::test]
    async fn logout_bearer_header_value_exact() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/logout/"))
            .and(header("authorization", "Bearer stg_abc123"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let client = BackendClient::new(server.uri()).unwrap();
        client.logout("stg_abc123").await.unwrap();
    }

    #[tokio::test]
    async fn logout_401_bare_no_envelope() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/logout/"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let client = BackendClient::new(server.uri()).unwrap();
        let err = client.logout("stg_bad").await.unwrap_err();
        assert!(matches!(err, BackendError::Unauthenticated), "got {err:?}");
    }

    #[tokio::test]
    async fn with_timeout_honored_on_slow_server() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/start/"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(2_000)),
            )
            .mount(&server)
            .await;

        let client =
            BackendClient::with_timeout(server.uri(), Duration::from_millis(50)).unwrap();
        // Timeout fires before any response byte arrives; reqwest propagates it
        // via `?` → `BackendError::Transport`. Neither map_error nor json_err runs.
        let err = client.device_start().await.unwrap_err();
        assert!(matches!(err, BackendError::Transport(_)), "got {err:?}");
    }
}
