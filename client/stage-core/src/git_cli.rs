//! The one place `stage-core` spawns the system `git`.
//!
//! Every git shell-out in the crate used to hand-roll the same three lines —
//! `Command::new("git")`, a `status.success()` test, and a stderr string — and
//! they had drifted apart in exactly the ways that matter:
//!
//! - **the binary.** [`crate::tool_path`] exists because a Dock-launched macOS
//!   bundle inherits launchd's bare `PATH`, so `Command::new("git")` finds
//!   `/usr/bin/git` or nothing at all — never a version manager's. Only
//!   [`crate::github::GitHub`] was resolving it; `switch`, `review_folder` and
//!   the app's `fetch`/`push` were not.
//! - **the failure.** Some call sites surfaced git's stderr verbatim, one
//!   dropped it for a `{args:?} failed` debug string, and one mapped the spawn
//!   error to a bare `io` variant — so "git isn't installed" reached the user
//!   as `io: No such file or directory (os error 2)`.
//!
//! Both are the fail-loud rule (CLAUDE.md) in practice: a git failure must
//! reach the user carrying git's own words. So this module owns the spawn and
//! the classification, and the callers own only the *what* — the short verb
//! phrase that prefixes an otherwise-empty failure ("git push").
//!
//! Nothing here decides git policy. Which commands run, in what order, and
//! whether a state forbids them is the calling module's business ([`crate::switch`],
//! [`crate::push`]); this is the pipe they all run through.

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::OnceLock;

use crate::error::StageError;
use crate::tool_path::{resolve_tool, GIT_BIN_ENV};

/// The `git` binary to spawn, resolved once per process.
///
/// Resolution walks [`crate::tool_path`]'s ladder (`STAGE_GIT_BIN`, `PATH`,
/// the well-known install dirs, the login shell's `PATH`) and is cached: the
/// login-shell probe spawns a shell, and no git call should pay for that twice.
/// An unresolvable name comes back as the bare `"git"` so the spawn is what
/// fails, loudly, rather than resolution inventing a fallback.
pub fn git_bin() -> &'static OsString {
    static BIN: OnceLock<OsString> = OnceLock::new();
    BIN.get_or_init(|| resolve_tool("git", GIT_BIN_ENV))
}

/// Spawn `git` with its working directory at `dir` and capture the output.
///
/// A spawn failure — git missing, `dir` gone — is loud and names the binary we
/// actually tried, which is the only way to tell "no git installed" apart from
/// "git is installed somewhere this process can't see" (the launchd-`PATH`
/// case this module exists for).
///
/// A non-zero exit is **not** an error here: the caller passes the output to
/// [`check_git`] (or uses [`git_stdout`]) so it can branch on an expected
/// failure first. Nothing else in the crate should call `Command::new("git")`.
pub fn run_git(dir: &Path, args: &[&str]) -> Result<Output, StageError> {
    let bin = git_bin();
    Command::new(bin)
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|e| {
            tracing::error!(
                err = %e,
                bin = ?bin,
                dir = %dir.display(),
                args = ?args,
                "git_spawn_failed"
            );
            StageError::GitCli(format!(
                "Couldn't run `git` ({}): {e}. Install git, or point Stage at it with {GIT_BIN_ENV}.",
                bin.to_string_lossy()
            ))
        })
}

/// Classify a finished `git` invocation: success, or git's stderr surfaced
/// **verbatim** as [`StageError::GitCli`].
///
/// `what` is the command as a human would name it ("git push") and is used
/// only when git said nothing on stderr — git's own message always wins, since
/// it is the one that tells the user what to do about it (fail loud, CLAUDE.md).
pub fn check_git(out: &Output, what: &str) -> Result<(), StageError> {
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg = match stderr.trim() {
        "" => format!("{what} failed with {}", describe_status(out)),
        s => s.to_string(),
    };
    tracing::error!(what = %what, status = ?out.status.code(), stderr = %msg, "git_cli_failed");
    Err(StageError::GitCli(msg))
}

/// Run `git` and return its trimmed stdout, failing loud on a non-zero exit.
///
/// The shape almost every read wants — `rev-parse`, `rev-list --count`,
/// `stash list`. Callers that must inspect a non-zero exit before deciding it
/// is a failure use [`run_git`] + [`check_git`] instead.
pub fn git_stdout(dir: &Path, args: &[&str], what: &str) -> Result<String, StageError> {
    let out = run_git(dir, args)?;
    check_git(&out, what)?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Run `git` for its effect, discarding stdout and failing loud on a non-zero exit.
pub fn git_run(dir: &Path, args: &[&str], what: &str) -> Result<(), StageError> {
    let out = run_git(dir, args)?;
    check_git(&out, what)
}

/// How a process ended, for the rare failure with an empty stderr.
fn describe_status(out: &Output) -> String {
    match out.status.code() {
        Some(code) => format!("status {code}"),
        None => "a signal".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// `run_git` + `check_git` surface git's own stderr, not a paraphrase.
    #[test]
    fn non_zero_exit_carries_gits_stderr() {
        let dir = std::env::temp_dir().join(format!("stage-git-cli-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        // Not a repo → git complains, and the complaint is what the user sees.
        let out = run_git(&dir, &["rev-parse", "--verify", "HEAD"]).expect("spawn git");
        let err = check_git(&out, "git rev-parse").expect_err("not a repo");
        let msg = err.to_string();
        assert!(
            msg.contains("not a git repository"),
            "expected git's own words, got: {msg}"
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// `git_stdout` trims and returns what git printed.
    #[test]
    fn git_stdout_returns_trimmed_output() {
        let dir = std::env::temp_dir();
        let out = git_stdout(&dir, &["--version"], "git --version").expect("git --version");
        assert!(out.starts_with("git version"), "got: {out}");
        assert_eq!(out, out.trim(), "stdout must come back trimmed");
    }
}
