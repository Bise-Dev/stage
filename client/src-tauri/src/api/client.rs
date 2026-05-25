use std::time::Duration;

use crate::api::error::Error;

/// SDK handle for the Stage backend. Cheap to clone.
#[derive(Clone)]
pub struct Client {
    pub(super) base_url: String, // validated + trailing-slash-trimmed via `reqwest::Url::parse`
    pub(super) http: reqwest::Client,
}

impl Client {
    /// Construct with default 30s HTTP timeout.
    pub fn new(base_url: impl AsRef<str>) -> Result<Self, Error> {
        Self::with_timeout(base_url, Duration::from_secs(30))
    }

    /// Construct with explicit HTTP timeout.
    pub fn with_timeout(
        base_url: impl AsRef<str>,
        timeout: Duration,
    ) -> Result<Self, Error> {
        let raw = base_url.as_ref();
        // Validate by parsing through reqwest's URL type.
        let parsed = reqwest::Url::parse(raw)
            .map_err(|e| Error::InvalidBaseUrl(e.to_string()))?;
        let trimmed = parsed.as_str().trim_end_matches('/').to_string();
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .user_agent(concat!("stage-client/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(Error::Transport)?;
        Ok(Self {
            base_url: trimmed,
            http,
        })
    }

    pub(super) fn json_err(status: u16, e: reqwest::Error) -> Error {
        if e.is_decode() {
            Error::Unexpected {
                status,
                message: format!("body decode failed: {e}"),
                extra: serde_json::Value::Null,
            }
        } else {
            Error::Transport(e)
        }
    }

    // Intentionally silent: `device_poll`'s 4xx slug fall-through (authorization_pending,
    // slow_down, access_denied, expired_token) is the polling hot path; emitting tracing
    // here would spam the log on every tick. Callers — device_start, device_poll's
    // unknown-slug branch, auth_me, logout — emit `tracing::warn!` themselves after this returns.
    pub(super) async fn map_error(resp: reqwest::Response) -> Error {
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
            (401, _) => Error::Unauthenticated,
            (400, "validation_error") => Error::Validation { extra },
            (_, "github_error") => Error::Github { status, extra },
            _ => Error::Unexpected {
                status,
                message,
                extra,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_rejects_malformed_url() {
        let Err(err) = Client::new("not a url") else {
            panic!("expected Err but got Ok");
        };
        assert!(matches!(err, Error::InvalidBaseUrl(_)));
    }

    #[test]
    fn new_accepts_str_and_string() {
        let from_str = Client::new("http://localhost:8000").unwrap();
        let from_string = Client::new(String::from("http://localhost:8000")).unwrap();
        assert_eq!(from_str.base_url, "http://localhost:8000");
        assert_eq!(from_string.base_url, from_str.base_url);
    }

    #[test]
    fn new_trims_trailing_slash() {
        let c1 = Client::new("http://localhost:8000").unwrap();
        let c2 = Client::new("http://localhost:8000/").unwrap();
        assert_eq!(c1.base_url, c2.base_url);
        assert_eq!(c1.base_url, "http://localhost:8000");
    }

    #[test]
    fn with_timeout_constructs() {
        let _ = Client::with_timeout("http://localhost:8000", Duration::from_millis(500))
            .unwrap();
    }

}
