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
            api::Error::Unexpected {
                status, message, ..
            } => AppError::Backend(format!("backend {status}: {message}")),
        }
    }
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

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
