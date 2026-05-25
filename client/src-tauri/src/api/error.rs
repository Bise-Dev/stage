/// Errors returned by `Client` methods.
#[derive(Debug, thiserror::Error)]
pub enum Error {
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
