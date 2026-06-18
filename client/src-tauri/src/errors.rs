use std::path::PathBuf;

use stage_core::StageError;
use thiserror::Error;

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
    /// A general, user-facing failure carrying a complete message the client
    /// renders verbatim in its error banner (fail-loud, CLAUDE.md). Most
    /// failures from `stage-core` (`gh`/`git`/`.stage`) land here.
    #[error("{0}")]
    Backend(String),
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        // Every variant crosses the IPC boundary as its Display string — the
        // webview reads it as `e.message`/`String(e)` and shows it in a red banner.
        ser.serialize_str(&self.to_string())
    }
}

impl From<StageError> for AppError {
    fn from(err: StageError) -> Self {
        match err {
            StageError::Git(e) => AppError::Git(e),
            StageError::Io(e) => AppError::Io(e),
            // Diff/Invalid/GhFailed/etc. carry a complete, user-facing message;
            // preserve it verbatim — the client renders AppError's Display.
            other => AppError::Backend(other.to_string()),
        }
    }
}
