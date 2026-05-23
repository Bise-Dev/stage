use std::path::PathBuf;

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
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}
