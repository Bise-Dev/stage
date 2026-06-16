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
    /// Enumerating worktrees via the system `git` failed; carries git's stderr.
    #[error("git worktree: {0}")]
    Worktree(String),
    /// A `git` CLI shell-out exited non-zero — the scoped `.stage` commit, or a
    /// `push`/`fetch` transport op (ADR-0022 §5). Carries git's stderr so the
    /// failure surfaces with its real cause.
    #[error("git: {0}")]
    GitCli(String),
    /// `gh` is missing or unauthenticated — a hard requirement (ADR-0022 §5).
    /// Carries a loud, one-time, actionable message ("install `gh` / run
    /// `gh auth login`"); there is no broker fallback. The `{0}` Display is the
    /// complete message the UI banner shows verbatim.
    #[error("{0}")]
    GhUnavailable(String),
    /// A `gh` command exited non-zero. Carries GitHub's own message (gh's
    /// stderr) verbatim so the banner shows the real cause — never swallowed,
    /// never defaulted (CLAUDE.md fail-loud).
    #[error("{0}")]
    GhFailed(String),
    #[error("git: {0}")]
    Git(#[from] git2::Error),
    #[error("store: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}
