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
#[allow(dead_code)]
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

/// Returned by `device_start`. Carries the device code, the user-facing code,
/// the URL where the user types it, and the polling/expiry hints (seconds).
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(dead_code)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

/// Stage user identity returned by `device_poll` (on success) and `auth_me`.
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(dead_code)]
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
#[allow(dead_code)]
pub struct SessionData {
    pub session_token: String,
    pub user: User,
}

/// Caller-facing outcome of one `device_poll` call. The caller's loop picks
/// the next action based on which variant matches.
#[derive(Clone)]
#[allow(dead_code)]
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
#[allow(dead_code)]
enum DevicePollSuccess {
    Pending,
    Ok {
        session_token: String,
        user: User,
    },
}

/// SDK handle for the Stage backend. Cheap to clone.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct BackendClient {
    base_url: String, // validated + trailing-slash-trimmed via `reqwest::Url::parse`
    http: reqwest::Client,
}

#[allow(dead_code)]
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

    /// `POST /api/v1/auth/device/start/` — kicks off the device flow.
    pub async fn device_start(&self) -> Result<DeviceCode, BackendError> {
        let url = format!("{}/api/v1/auth/device/start/", self.base_url);
        let resp = self.http.post(&url).send().await?;
        if !resp.status().is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json::<DeviceCode>().await.map_err(BackendError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
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
}
