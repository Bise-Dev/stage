use std::path::PathBuf;

use stage_core::StageError;
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
    /// Stage's GitHub App can't reach the repo (backend 403, code
    /// `github_app_no_access`). Carries the install URL so the webview can
    /// render an "Install the Stage App" CTA. A targeted variant, kept
    /// distinct from `Backend` so `extra` survives the flatten (see
    /// `From<api::Error>`).
    #[error("{message}")]
    RepoAccess {
        message: String,
        install_url: Option<String>,
    },
    #[error("user denied authorization")]
    AuthDenied,
    #[error("sign-in cancelled")]
    Cancelled,
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        match self {
            // The one structured variant: emit a tagged object the webview
            // matches on (`e.kind === 'github_app_no_access'`) to render the
            // Install CTA.
            AppError::RepoAccess {
                message,
                install_url,
            } => {
                use serde::ser::SerializeStruct;
                let mut st = ser.serialize_struct("AppError", 3)?;
                st.serialize_field("kind", "github_app_no_access")?;
                st.serialize_field("message", message)?;
                st.serialize_field("install_url", install_url)?;
                st.end()
            }
            // Every other variant keeps its historical wire shape — the bare
            // Display string the webview reads as `e.message`/`String(e)`.
            other => ser.serialize_str(&other.to_string()),
        }
    }
}

impl From<StageError> for AppError {
    fn from(err: StageError) -> Self {
        match err {
            StageError::Git(e) => AppError::Git(e),
            StageError::Io(e) => AppError::Io(e),
            // Diff/Invalid/etc. carry a complete, user-facing message; preserve
            // it verbatim — the client renders AppError's Display in a banner.
            other => AppError::Backend(other.to_string()),
        }
    }
}

impl From<api::Error> for AppError {
    fn from(err: api::Error) -> Self {
        match err {
            api::Error::Unauthenticated => AppError::NotAuthenticated,
            // Our 403 repo-access gate lands as `Unexpected` (its human message
            // isn't the "github_error" sentinel). Detect the machine code in
            // `extra` and lift it to the structured variant; without this the
            // catch-all below would flatten it to `Backend(String)`, dropping
            // `install_url`.
            api::Error::Unexpected {
                ref message,
                ref extra,
                ..
            } if extra.get("code").and_then(|c| c.as_str()) == Some("github_app_no_access") => {
                let install_url = extra
                    .get("install_url")
                    .and_then(|u| u.as_str())
                    .map(str::to_owned);
                AppError::RepoAccess {
                    message: message.clone(),
                    install_url,
                }
            }
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
