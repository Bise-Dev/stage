use std::path::PathBuf;

use thiserror::Error;

use crate::api;
use crate::oauth::OauthError;

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
    #[error("user denied authorization")]
    AuthDenied,
    #[error("sign-in cancelled")]
    Cancelled,
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

impl From<api::Error> for AppError {
    fn from(err: api::Error) -> Self {
        match err {
            api::Error::Unauthenticated => AppError::NotAuthenticated,
            other => AppError::Backend(format!("{other}")),
        }
    }
}

impl From<OauthError> for AppError {
    fn from(err: OauthError) -> Self {
        match err {
            OauthError::UserDenied => AppError::AuthDenied,
            OauthError::Cancelled => AppError::Cancelled,
            OauthError::StateMismatch => AppError::Backend("oauth_state_mismatch".into()),
            OauthError::Timeout => AppError::Backend("oauth_timeout".into()),
            OauthError::BindFailed(e) => AppError::Backend(format!("oauth_bind_failed: {e}")),
            OauthError::GithubError(s) => AppError::Backend(format!("oauth_github_error: {s}")),
            OauthError::Io(e) => AppError::Backend(format!("oauth_io_error: {e}")),
        }
    }
}
