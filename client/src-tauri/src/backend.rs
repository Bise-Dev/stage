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

/// SDK handle for the Stage backend. Cheap to clone.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct BackendClient {
    base_url: String, // validated + trailing-slash-trimmed in `new`
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
