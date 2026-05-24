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

/// SDK handle for the Stage backend. Cheap to clone.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct BackendClient {
    base_url: String, // validated + trailing-slash-trimmed via `reqwest::Url::parse`
    #[allow(dead_code)]
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
