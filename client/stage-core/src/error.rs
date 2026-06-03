use std::path::PathBuf;

use thiserror::Error;

/// Every fallible `stage-core` operation returns this. Per CLAUDE.md's
/// fail-loud rule the variants carry the real cause so the CLI can print a
/// complete, actionable message — never a swallowed error or a default value.
#[derive(Debug, Error)]
pub enum StageError {
    /// `cwd` is not inside a git working tree.
    #[error("not inside a git repository (looked from {0})")]
    NotARepo(PathBuf),
    /// The platform has no resolvable data directory for the store.
    #[error("could not determine a data directory for the Stage store")]
    NoDataDir,
    /// A domain rule was violated (e.g. a bare repo, an empty payload).
    #[error("{0}")]
    Invalid(String),
    /// A diff computation failed with extra context beyond the raw git2 error.
    #[error("{0}")]
    Diff(String),
    #[error("git: {0}")]
    Git(#[from] git2::Error),
    #[error("store: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}
