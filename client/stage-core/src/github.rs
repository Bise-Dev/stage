//! `github.rs` — the credential-free GitHub adapter (ADR-0022 §5).
//!
//! Stage holds **no** credential of its own. Every GitHub touchpoint shells out
//! to the user's local CLIs:
//!
//! - **GitHub API** (read/open PRs, verdicts, comments, checks, search, PR
//!   actions, the auto-comment) goes through **`gh`**, which owns its own token.
//! - **git transport** (push, fetch) goes through the system **`git`**, which
//!   uses the user's existing git credentials (ssh-agent, credential helpers).
//!
//! This module is the *layer* the networked milestones (publish, review,
//! reviewer-entry, dashboard) compose on — it provides the runners
//! ([`GitHub::run_gh`], [`GitHub::run_gh_json`]), the hard-requirement gate
//! ([`GitHub::ensure_ready`]), identity ([`GitHub::current_user`]), and git
//! transport ([`GitHub::git_push`], [`GitHub::git_fetch`]). The specific
//! feature commands (e.g. `gh pr create`, verdict submission, `gh search`)
//! belong to those milestones and are built on these primitives.
//!
//! **Fail loud (CLAUDE.md):** every failure both logs (`tracing::error!`) and
//! surfaces a complete, user-facing message. There is no broker fallback and no
//! default-on-error:
//!
//! - `gh` missing or unauthenticated → [`StageError::GhUnavailable`] carrying a
//!   one-time, actionable "install `gh` / run `gh auth login`" message.
//! - a `gh` command exiting non-zero → [`StageError::GhFailed`] carrying
//!   GitHub's own stderr **verbatim** (a 404, a 403, a validation error) so the
//!   UI banner shows the real cause.
//! - a `git` push/fetch failing → [`StageError::GitCli`] carrying git's
//!   stderr verbatim.
//!
//! **Identity (ADR-0022 §5, #53/#55):** committed artifacts are attributed by
//! their git commit author; GitHub actions by the `gh` token owner.
//! [`GitHub::current_user`] answers "who am I" via `gh api user`, cached for the
//! lifetime of the adapter. There is no Stage account and no reconciliation
//! between the git commit identity and the `gh` identity (assumed the same
//! human — an accepted simplification).
//!
//! **Auth only at action time (ADR-0022 §5, #56):** the adapter never runs `gh`
//! eagerly. The gate runs lazily on the first GitHub-needing call and is then
//! cached, so local features (Self-Review, storyline authoring) never invoke
//! `gh`. The adapter is meant to be constructed once and held (e.g. in app
//! state) so the gate and the identity resolve a single time per process.

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::OnceLock;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::StageError;
use crate::tool_path::{resolve_tool, GH_BIN_ENV, GIT_BIN_ENV};

/// The GitHub identity reported by `gh api user` — the `gh` token owner.
///
/// Unknown fields in the API payload are ignored; only what Stage needs to
/// answer "who am I" and attribute actions is kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitHubUser {
    /// The GitHub handle (e.g. `"octocat"`) — how actions are attributed.
    pub login: String,
    /// GitHub's stable numeric user id. Crosses the JSON IPC boundary as a JS
    /// `number` (ts-rs would otherwise emit `bigint` for a 64-bit int).
    #[ts(type = "number")]
    pub id: u64,
    /// The user's display name, if set on their GitHub profile.
    pub name: Option<String>,
}

/// Whose PRs to list for the dashboard (DB-1 #84 / DB-3 #86). Two separate `gh`
/// queries the caller merges, so each surfaced row knows whether it is mine or
/// waiting on my review.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrFilter {
    /// PRs I opened — `gh pr list --author @me`.
    Authored,
    /// PRs awaiting my review — `gh pr list --search "review-requested:@me"`.
    /// Surfaces a PR even when the author skipped Stage entirely (DB-3).
    ReviewRequested,
}

/// The PR author from `gh pr list --json author`. Only the login is kept; gh's
/// other fields (GraphQL node id, `is_bot`, display name) are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct GhAuthor {
    pub login: String,
}

/// One pull request from `gh pr list --json …` — exactly the fields the
/// dashboard needs to derive a row's status + signal (ADR-0022 §6, DB-2 #85).
/// Unknown fields in gh's payload are ignored (serde default).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhPullRequest {
    pub number: u32,
    pub title: String,
    /// gh's uppercase PR state: `"OPEN"`, `"CLOSED"`, or `"MERGED"`.
    pub state: String,
    pub url: String,
    /// The PR's head branch — the dashboard's join key against local drafts and
    /// committed `.stage/<branch>/` folders.
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub is_draft: bool,
    pub additions: u32,
    pub deletions: u32,
    /// gh's review decision: `""` (none yet), `"APPROVED"`, `"CHANGES_REQUESTED"`,
    /// or `"REVIEW_REQUIRED"`. Defaulted so a payload without the key still parses.
    #[serde(default)]
    pub review_decision: String,
    pub author: GhAuthor,
    /// Issue-comment count for the dashboard signal. `gh` returns the full
    /// `comments` array; only its length is kept (see [`count_json_array`]).
    #[serde(rename = "comments", deserialize_with = "count_json_array")]
    pub comments: u32,
    /// ISO-8601 last-update time (`updatedAt`) — the overview row's right-edge
    /// relative timestamp. Defaulted (empty) so an older payload still parses.
    #[serde(default)]
    pub updated_at: String,
}

/// Deserialize a JSON array as just its length, discarding the elements — the
/// dashboard signal needs the `comments` *count*, not the bodies gh streams.
fn count_json_array<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let items = Vec::<serde::de::IgnoredAny>::deserialize(deserializer)?;
    Ok(items.len() as u32)
}

/// Page size for [`GitHub::list_repo_prs`]. gh defaults to 30; we raise it so a
/// busy repo's dashboard is complete, and warn loudly if even this is hit
/// (CLAUDE.md: no silent caps — never imply completeness we can't promise).
const PR_LIST_LIMIT: usize = 200;

/// The actionable hint appended to every "`gh` unavailable" message. Naming the
/// exact remedy is the whole point — there is no broker fallback.
const GH_INSTALL_HINT: &str = "Install it from https://cli.github.com, then run `gh auth login`.";

/// The credential-free GitHub adapter. Shells out to the user's `gh` and `git`.
///
/// Construct once and share (`&self` everywhere): the auth gate and the identity
/// are cached on the instance, so a long-lived adapter checks `gh auth status`
/// and `gh api user` at most once each.
pub struct GitHub {
    /// The `gh` binary to invoke (`"gh"` in production; overridden in tests).
    gh_bin: OsString,
    /// The `git` binary to invoke (`"git"` in production; overridden in tests).
    git_bin: OsString,
    /// Set once `gh` is confirmed installed **and** authenticated. Only a
    /// success is cached — a failure re-checks next time so the user can run
    /// `gh auth login` and retry without restarting.
    ready: OnceLock<()>,
    /// The resolved `gh` token owner, cached for the adapter's lifetime.
    user: OnceLock<GitHubUser>,
}

impl Default for GitHub {
    fn default() -> Self {
        Self::new()
    }
}

impl GitHub {
    /// The production adapter: the user's `gh` and `git`, each resolved to an
    /// absolute path by [`crate::tool_path`] rather than left to the inherited
    /// `PATH` — which, for a Dock/Finder-launched macOS bundle, is launchd's
    /// minimal one and contains no Homebrew.
    pub fn new() -> Self {
        Self::with_bins(
            resolve_tool("gh", GH_BIN_ENV),
            resolve_tool("git", GIT_BIN_ENV),
        )
    }

    /// Construct with explicit binaries. Production uses [`GitHub::new`]; tests
    /// point this at a fake `gh`/`git` script to exercise every path offline.
    pub fn with_bins(gh: impl Into<OsString>, git: impl Into<OsString>) -> Self {
        Self {
            gh_bin: gh.into(),
            git_bin: git.into(),
            ready: OnceLock::new(),
            user: OnceLock::new(),
        }
    }

    /// Build a `gh` invocation with deterministic, color-free output so any
    /// message we surface verbatim is clean.
    fn gh_command(&self, args: &[&str], cwd: Option<&Path>) -> Command {
        let mut cmd = Command::new(&self.gh_bin);
        cmd.args(args);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        // No ANSI in captured output, and no "a new release of gh" noise on
        // stderr that could pollute a surfaced error message.
        cmd.env("NO_COLOR", "1");
        cmd.env("GH_NO_UPDATE_NOTIFIER", "1");
        cmd
    }

    /// A spawn failure means `gh` itself is unavailable — the hard-requirement
    /// violation — so it maps to a loud, actionable [`StageError::GhUnavailable`]
    /// naming the remedy. Shared by the plain and stdin-piped runners.
    fn gh_spawn_error(&self, e: &std::io::Error) -> StageError {
        let msg = if e.kind() == std::io::ErrorKind::NotFound {
            tracing::error!(err = %e, bin = ?self.gh_bin, "gh_not_found");
            format!(
                "GitHub CLI (`gh`) was not found. Stage uses your local `gh` for every \
                 GitHub action and stores no credentials of its own. {GH_INSTALL_HINT} \
                 If it is already installed, Stage couldn't see it: set {GH_BIN_ENV} to \
                 its full path (`which gh` in a terminal)."
            )
        } else {
            tracing::error!(err = %e, bin = ?self.gh_bin, "gh_spawn_failed");
            format!("Couldn't run GitHub CLI (`gh`): {e}. {GH_INSTALL_HINT}")
        };
        StageError::GhUnavailable(msg)
    }

    /// Spawn `gh` and capture its output. A spawn failure maps to
    /// [`StageError::GhUnavailable`]; a non-zero *exit* is left for the caller to
    /// classify (unauthenticated vs. a failed command).
    fn run_gh_raw(&self, args: &[&str], cwd: Option<&Path>) -> Result<Output, StageError> {
        self.gh_command(args, cwd)
            .output()
            .map_err(|e| self.gh_spawn_error(&e))
    }

    /// Spawn `gh` with `body` piped to its stdin (for `gh api … --input -`) and
    /// capture its output. The handle is closed after the write so `gh` sees
    /// EOF. Spawn failure maps to [`StageError::GhUnavailable`]; a non-zero exit
    /// is left for the caller to classify.
    fn run_gh_raw_stdin(
        &self,
        args: &[&str],
        cwd: Option<&Path>,
        body: &str,
    ) -> Result<Output, StageError> {
        use std::io::Write;
        let mut child = self
            .gh_command(args, cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| self.gh_spawn_error(&e))?;
        {
            // Take + drop the handle in this scope so the pipe closes (EOF)
            // before we wait, even if the write itself fails.
            let mut stdin = child.stdin.take().ok_or_else(|| {
                StageError::GhUnavailable("`gh` stdin pipe was unavailable".to_string())
            })?;
            stdin.write_all(body.as_bytes()).map_err(StageError::Io)?;
        }
        child.wait_with_output().map_err(StageError::Io)
    }

    /// Classify a finished `gh` invocation: success → its stdout; a non-zero exit
    /// → GitHub's own stderr (else stdout) surfaced **verbatim** as
    /// [`StageError::GhFailed`] (never swallowed, never defaulted — CLAUDE.md
    /// fail-loud). Shared by [`GitHub::run_gh`] and [`GitHub::run_gh_stdin`].
    fn classify_gh(&self, args: &[&str], out: Output) -> Result<String, StageError> {
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            let msg = match first_nonempty(stderr.trim(), stdout.trim()) {
                Some(s) => s.to_string(),
                // gh failed but said nothing — still loud, with the exit status.
                None => format!(
                    "`gh {}` exited with {}",
                    args.join(" "),
                    describe_status(&out)
                ),
            };
            tracing::error!(args = ?args, status = ?out.status.code(), "gh_command_failed");
            return Err(StageError::GhFailed(msg));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// The hard-requirement gate (ADR-0022 §5): confirm `gh` is installed **and**
    /// authenticated. Runs `gh auth status` lazily on first use and caches the
    /// success, so it runs at most once per adapter. A missing or
    /// unauthenticated `gh` is a loud, one-time, actionable error — there is no
    /// broker fallback.
    pub fn ensure_ready(&self) -> Result<(), StageError> {
        if self.ready.get().is_some() {
            return Ok(());
        }
        let out = self.run_gh_raw(&["auth", "status"], None)?;
        if !out.status.success() {
            let detail = combined_output(&out);
            tracing::error!(status = ?out.status.code(), "gh_unauthenticated");
            let base = "GitHub CLI (`gh`) is not authenticated. Run `gh auth login` to connect \
                        your GitHub account — Stage acts as you and stores no token of its own.";
            let msg = if detail.is_empty() {
                base.to_string()
            } else {
                format!("{base}\n\n{detail}")
            };
            return Err(StageError::GhUnavailable(msg));
        }
        let _ = self.ready.set(());
        Ok(())
    }

    /// Run a `gh` command and return its stdout. The gate runs first
    /// ([`GitHub::ensure_ready`]); a non-zero exit surfaces GitHub's own stderr
    /// **verbatim** as [`StageError::GhFailed`] (never swallowed, never
    /// defaulted). `cwd` scopes repo-relative commands (`gh pr …`); pass `None`
    /// for global ones (`gh api …`).
    ///
    /// This is the primitive the networked milestones compose their typed
    /// commands on.
    pub fn run_gh(&self, args: &[&str], cwd: Option<&Path>) -> Result<String, StageError> {
        self.ensure_ready()?;
        let out = self.run_gh_raw(args, cwd)?;
        self.classify_gh(args, out)
    }

    /// Like [`GitHub::run_gh`] but pipes `body` to `gh`'s stdin — the primitive
    /// for `gh api <endpoint> --input -`, where the request payload is a JSON
    /// object on stdin (the only clean way to send a nested array, e.g. a review
    /// with bundled line comments). Same gate and same verbatim fail-loud
    /// classification as [`GitHub::run_gh`].
    pub fn run_gh_stdin(
        &self,
        args: &[&str],
        cwd: Option<&Path>,
        body: &str,
    ) -> Result<String, StageError> {
        self.ensure_ready()?;
        let out = self.run_gh_raw_stdin(args, cwd, body)?;
        self.classify_gh(args, out)
    }

    /// Run a `gh` command and parse its stdout JSON into `T` (e.g. `gh api …`
    /// or `gh … --json …`). A parse failure is loud — never a silent default.
    pub fn run_gh_json<T: DeserializeOwned>(
        &self,
        args: &[&str],
        cwd: Option<&Path>,
    ) -> Result<T, StageError> {
        let stdout = self.run_gh(args, cwd)?;
        parse_gh_json(args, &stdout)
    }

    /// Like [`GitHub::run_gh_json`] but pipes `body` to `gh`'s stdin and parses
    /// the response JSON into `T` — used for `gh api … --input -` POSTs that
    /// return a resource (e.g. the created review). Fails loud on a parse error.
    pub fn run_gh_json_stdin<T: DeserializeOwned>(
        &self,
        args: &[&str],
        cwd: Option<&Path>,
        body: &str,
    ) -> Result<T, StageError> {
        let stdout = self.run_gh_stdin(args, cwd, body)?;
        parse_gh_json(args, &stdout)
    }

    /// Resolve the `gh` token owner via `gh api user`, cached for the adapter's
    /// lifetime (ADR-0022 §5). This is the "who am I" used to attribute GitHub
    /// actions; committed artifacts are attributed by their git commit author
    /// instead, which Stage does not reconcile against this identity.
    pub fn current_user(&self) -> Result<GitHubUser, StageError> {
        if let Some(user) = self.user.get() {
            return Ok(user.clone());
        }
        let user: GitHubUser = self.run_gh_json(&["api", "user"], None)?;
        // A redundant fetch under a race is harmless (the call is idempotent);
        // keep whichever lands first.
        let _ = self.user.set(user.clone());
        Ok(user)
    }

    /// Spawn `git` in `repo_dir` and capture its output. A spawn failure maps to
    /// [`StageError::GitCli`]; the caller classifies a non-zero exit.
    fn run_git_raw(&self, repo_dir: &Path, args: &[&str]) -> Result<Output, StageError> {
        Command::new(&self.git_bin)
            .current_dir(repo_dir)
            .args(args)
            .output()
            .map_err(|e| {
                tracing::error!(err = %e, bin = ?self.git_bin, "git_spawn_failed");
                StageError::GitCli(format!("Couldn't run `git`: {e}"))
            })
    }

    /// `git fetch --prune <remote>` — transport over the user's own git
    /// credentials (ADR-0022 §5). On a non-zero exit git's stderr is surfaced
    /// verbatim (fail loud).
    pub fn git_fetch(&self, repo_dir: &Path, remote: &str) -> Result<(), StageError> {
        let out = self.run_git_raw(repo_dir, &["fetch", "--prune", remote])?;
        check_git(&out, "git fetch")
    }

    /// `git push --set-upstream <remote> <branch>` — transport over the user's
    /// own git credentials (ADR-0022 §5). A no-op push (remote already has the
    /// commits) still exits 0, so re-publishing is idempotent. On a non-zero
    /// exit git's stderr is surfaced verbatim (auth failure, protected branch,
    /// missing write access) — fail loud.
    pub fn git_push(&self, repo_dir: &Path, remote: &str, branch: &str) -> Result<(), StageError> {
        let out = self.run_git_raw(repo_dir, &["push", "--set-upstream", remote, branch])?;
        check_git(&out, "git push")
    }

    /// The local ref a fetched PR head lands at ([`GitHub::fetch_pr_head`]). Kept
    /// under `refs/stage/review/` so it never collides with the user's branches
    /// or remote-tracking refs, and so the reviewer entry can diff/read it by a
    /// stable name without a checkout.
    pub fn pr_head_local_ref(pr_number: u32) -> String {
        format!("refs/stage/review/pr-{pr_number}")
    }

    /// Fetch PR `pr_number`'s head commit (and refresh its base branch) into
    /// local refs — **read-only, no working-tree mutation** (ADR-0022 §6,
    /// milestone F). Transport is the user's own `git` credentials, like
    /// [`GitHub::git_fetch`].
    ///
    /// The head is fetched via the canonical `refs/pull/<n>/head` ref, which the
    /// **base** repo publishes even when the PR is opened from a fork — so the
    /// reviewer never needs the contributor's branch or fork remote. It lands at
    /// [`GitHub::pr_head_local_ref`] (returned). The base branch is refreshed into
    /// its `refs/remotes/<remote>/<base_ref>` tracking ref in the same fetch so
    /// the tree-to-tree diff resolves a current base (ADR-0018).
    ///
    /// Fail loud: git's stderr surfaces verbatim on a non-zero exit (a deleted
    /// PR, no network, no read access).
    pub fn fetch_pr_head(
        &self,
        repo_dir: &Path,
        remote: &str,
        pr_number: u32,
        base_ref: &str,
    ) -> Result<String, StageError> {
        let local_head = Self::pr_head_local_ref(pr_number);
        let head_spec = format!("+refs/pull/{pr_number}/head:{local_head}");
        let base_spec = format!("+refs/heads/{base_ref}:refs/remotes/{remote}/{base_ref}");
        let out = self.run_git_raw(repo_dir, &["fetch", remote, &head_spec, &base_spec])?;
        check_git(&out, "git fetch")?;
        Ok(local_head)
    }

    /// Check out `branch` at `source_ref`, creating or resetting the local branch
    /// to that commit (`git checkout -B`). **This is the lone working-tree
    /// mutation the reviewer flow performs** (ADR-0022 §6, narrowly amending
    /// ADR-0016's observe-only stance) and must only be reached on explicit user
    /// confirmation — see [`crate::reviewer::checkout_pr_branch`]. Fail loud:
    /// git's stderr verbatim (e.g. uncommitted changes that would be overwritten).
    pub fn checkout_local_branch(
        &self,
        repo_dir: &Path,
        branch: &str,
        source_ref: &str,
    ) -> Result<(), StageError> {
        let out = self.run_git_raw(repo_dir, &["checkout", "-B", branch, source_ref])?;
        check_git(&out, "git checkout")
    }

    /// List the repo's PRs for the dashboard (DB-1 #84 / DB-3 #86, ADR-0022 §6).
    /// `repo` is the `owner/name` slug; `filter` picks authored vs.
    /// review-requested. `--state all` is deliberate: the archived view-filter
    /// (DB-5 #88) is a *computed* dashboard concern, so this returns open **and**
    /// closed/merged PRs and the caller hides them — state is never stored.
    ///
    /// Fail loud through [`GitHub::run_gh_json`]: a missing/unauthenticated `gh`,
    /// a non-zero `gh` exit (its stderr verbatim), or unparseable JSON all
    /// surface their real cause — never an empty list standing in for a failure.
    pub fn list_repo_prs(
        &self,
        repo: &str,
        filter: PrFilter,
    ) -> Result<Vec<GhPullRequest>, StageError> {
        // Field set drives the JSON shape of [`GhPullRequest`]; keep them in sync.
        const FIELDS: &str = "number,title,state,url,headRefName,baseRefName,\
isDraft,additions,deletions,reviewDecision,author,comments,updatedAt";
        // `--limit` wants a &str; PR_LIST_LIMIT is the matching numeric guard.
        const LIMIT_ARG: &str = "200";
        let mut args: Vec<&str> = vec![
            "pr", "list", "--repo", repo, "--state", "all", "--limit", LIMIT_ARG, "--json", FIELDS,
        ];
        match filter {
            PrFilter::Authored => args.extend_from_slice(&["--author", "@me"]),
            PrFilter::ReviewRequested => {
                args.extend_from_slice(&["--search", "review-requested:@me"])
            }
        }
        let prs: Vec<GhPullRequest> = self.run_gh_json(&args, None)?;
        if prs.len() >= PR_LIST_LIMIT {
            tracing::warn!(
                repo = %repo,
                limit = PR_LIST_LIMIT,
                "pr_list_hit_limit: the dashboard may be missing older PRs for this repo"
            );
        }
        Ok(prs)
    }
}

/// Classify a finished `git` transport command: success, or git's stderr
/// surfaced verbatim as [`StageError::GitCli`].
fn check_git(out: &Output, what: &str) -> Result<(), StageError> {
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg = match stderr.trim() {
        "" => format!("{what} failed with {}", describe_status(out)),
        s => s.to_string(),
    };
    tracing::error!(what = %what, status = ?out.status.code(), "git_transport_failed");
    Err(StageError::GitCli(msg))
}

/// Parse `gh` stdout JSON into `T`, failing loud (never a silent default) when
/// the output isn't the JSON `T` expects. Shared by the plain and stdin JSON
/// runners.
fn parse_gh_json<T: DeserializeOwned>(args: &[&str], stdout: &str) -> Result<T, StageError> {
    serde_json::from_str(stdout).map_err(|e| {
        tracing::error!(err = %e, args = ?args, "gh_json_parse_failed");
        StageError::Invalid(format!(
            "Couldn't parse `gh {}` output as JSON: {e}",
            args.join(" ")
        ))
    })
}

/// The first of two trimmed strings that is non-empty (stderr preferred over
/// stdout for error context).
fn first_nonempty<'a>(a: &'a str, b: &'a str) -> Option<&'a str> {
    if !a.is_empty() {
        Some(a)
    } else if !b.is_empty() {
        Some(b)
    } else {
        None
    }
}

/// stderr if present, else stdout — the diagnostic text from a captured output.
fn combined_output(out: &Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    first_nonempty(stderr.trim(), stdout.trim())
        .unwrap_or("")
        .to_string()
}

/// A human description of an exit status — the code, or "a signal" when killed.
fn describe_status(out: &Output) -> String {
    match out.status.code() {
        Some(code) => format!("status {code}"),
        None => "a signal".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command as TestCommand;

    /// Write an executable fake-CLI script and return its path (unix-only: CI
    /// and dev are macOS/Linux). The body dispatches on `"$@"`.
    #[cfg(unix)]
    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    /// Run `git -C <dir> <args…>`, asserting success. Test-only helper, mirrors
    /// `worktree.rs`.
    fn git(dir: &Path, args: &[&str]) {
        let status = TestCommand::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .expect("spawn git");
        assert!(status.success(), "git {args:?} failed in {dir:?}");
    }

    // ---- the gh hard-requirement: missing ---------------------------------

    #[test]
    fn gh_missing_is_a_loud_actionable_error() {
        // A binary name that does not exist on PATH → spawn NotFound.
        let gh = GitHub::with_bins("stage-nonexistent-gh-binary-xyz", "git");
        let err = gh.current_user().expect_err("missing gh must fail");
        match err {
            StageError::GhUnavailable(msg) => {
                assert!(
                    msg.contains("https://cli.github.com"),
                    "names install URL: {msg}"
                );
                assert!(msg.contains("gh auth login"), "names the remedy: {msg}");
                assert!(msg.contains("not found"), "says it's missing: {msg}");
            }
            other => panic!("expected GhUnavailable, got {other:?}"),
        }
    }

    #[test]
    fn ensure_ready_reports_missing_gh() {
        let gh = GitHub::with_bins("stage-nonexistent-gh-binary-xyz", "git");
        let err = gh
            .ensure_ready()
            .expect_err("missing gh must fail the gate");
        assert!(matches!(err, StageError::GhUnavailable(_)));
    }

    // ---- the gh hard-requirement: unauthenticated -------------------------

    #[cfg(unix)]
    #[test]
    fn gh_unauthenticated_is_a_loud_actionable_error() {
        let dir = tempfile::tempdir().unwrap();
        let fake = write_script(
            dir.path(),
            "gh",
            "#!/usr/bin/env bash\n\
             if [ \"$1\" = auth ] && [ \"$2\" = status ]; then\n\
               echo 'You are not logged into any GitHub hosts. To log in, run: gh auth login' >&2\n\
               exit 1\n\
             fi\n\
             exit 1\n",
        );
        let gh = GitHub::with_bins(fake, "git");
        let err = gh.current_user().expect_err("unauthenticated gh must fail");
        match err {
            StageError::GhUnavailable(msg) => {
                assert!(msg.contains("gh auth login"), "names the remedy: {msg}");
                assert!(
                    msg.contains("not authenticated"),
                    "says it's unauthed: {msg}"
                );
                // gh's own diagnostic is carried through for context.
                assert!(
                    msg.contains("not logged into any GitHub hosts"),
                    "carries gh detail: {msg}"
                );
            }
            other => panic!("expected GhUnavailable, got {other:?}"),
        }
    }

    // ---- identity: gh api user, parsed and cached -------------------------

    #[cfg(unix)]
    #[test]
    fn current_user_parses_and_caches() {
        let dir = tempfile::tempdir().unwrap();
        let counter = dir.path().join("api_user_calls");
        // auth status → ok; `api user` → fixture JSON, and record each call so
        // we can prove the result is cached (the script is hit exactly once).
        let body = format!(
            "#!/usr/bin/env bash\n\
             if [ \"$1\" = auth ] && [ \"$2\" = status ]; then exit 0; fi\n\
             if [ \"$1\" = api ] && [ \"$2\" = user ]; then\n\
               echo call >> {counter:?}\n\
               echo '{{\"login\":\"octocat\",\"id\":583231,\"name\":\"The Octocat\",\"extra\":true}}'\n\
               exit 0\n\
             fi\n\
             exit 1\n",
            counter = counter.display(),
        );
        let fake = write_script(dir.path(), "gh", &body);
        let gh = GitHub::with_bins(fake, "git");

        let first = gh.current_user().expect("first resolve");
        assert_eq!(first.login, "octocat");
        assert_eq!(first.id, 583231);
        assert_eq!(first.name.as_deref(), Some("The Octocat"));

        let second = gh.current_user().expect("second resolve");
        assert_eq!(first, second);

        // Cached: `gh api user` ran exactly once across the two calls.
        let calls = std::fs::read_to_string(&counter).unwrap_or_default();
        assert_eq!(
            calls.lines().count(),
            1,
            "identity must be cached, got: {calls:?}"
        );
    }

    /// The auth gate is checked at most once per adapter (cached on success).
    #[cfg(unix)]
    #[test]
    fn auth_gate_runs_once() {
        let dir = tempfile::tempdir().unwrap();
        let counter = dir.path().join("auth_status_calls");
        let body = format!(
            "#!/usr/bin/env bash\n\
             if [ \"$1\" = auth ] && [ \"$2\" = status ]; then echo call >> {counter:?}; exit 0; fi\n\
             echo ok\n\
             exit 0\n",
            counter = counter.display(),
        );
        let fake = write_script(dir.path(), "gh", &body);
        let gh = GitHub::with_bins(fake, "git");

        gh.run_gh(&["api", "rate_limit"], None).expect("first call");
        gh.run_gh(&["api", "rate_limit"], None)
            .expect("second call");

        let calls = std::fs::read_to_string(&counter).unwrap_or_default();
        assert_eq!(
            calls.lines().count(),
            1,
            "auth gate must be cached, got: {calls:?}"
        );
    }

    // ---- error mapping: gh non-zero exit surfaces stderr verbatim ---------

    #[cfg(unix)]
    #[test]
    fn gh_command_failure_surfaces_github_message_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let fake = write_script(
            dir.path(),
            "gh",
            "#!/usr/bin/env bash\n\
             if [ \"$1\" = auth ] && [ \"$2\" = status ]; then exit 0; fi\n\
             echo 'gh: Not Found (HTTP 404)' >&2\n\
             exit 1\n",
        );
        let gh = GitHub::with_bins(fake, "git");
        let err = gh
            .run_gh(&["api", "repos/owner/missing"], None)
            .expect_err("a 404 must fail");
        match err {
            // Verbatim — no prefix, no rewrite (CLAUDE.md fail-loud).
            StageError::GhFailed(msg) => assert_eq!(msg, "gh: Not Found (HTTP 404)"),
            other => panic!("expected GhFailed, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn gh_json_parse_failure_is_loud() {
        let dir = tempfile::tempdir().unwrap();
        let fake = write_script(
            dir.path(),
            "gh",
            "#!/usr/bin/env bash\n\
             if [ \"$1\" = auth ] && [ \"$2\" = status ]; then exit 0; fi\n\
             echo 'this is not json'\n\
             exit 0\n",
        );
        let gh = GitHub::with_bins(fake, "git");
        let err = gh
            .run_gh_json::<GitHubUser>(&["api", "user"], None)
            .expect_err("non-JSON must fail");
        match err {
            StageError::Invalid(msg) => assert!(msg.contains("Couldn't parse"), "{msg}"),
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    // ---- git transport: push/fetch over the user's own credentials --------

    /// A repo with one commit and a bare "remote" alongside it. Returns the
    /// working repo path; `origin` points at the bare repo (no network).
    fn repo_with_bare_remote(base: &Path) -> PathBuf {
        let remote = base.join("remote.git");
        git(base, &["init", "-q", "--bare", remote.to_str().unwrap()]);

        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        git(&work, &["init", "-q", "-b", "main"]);
        std::fs::write(work.join("README.md"), "hi\n").unwrap();
        git(&work, &["add", "."]);
        git(
            &work,
            &[
                "-c",
                "user.email=t@e.com",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "-m",
                "init",
            ],
        );
        git(
            &work,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        work
    }

    #[test]
    fn git_push_then_fetch_succeed_against_a_bare_remote() {
        let tmp = tempfile::tempdir().unwrap();
        let work = repo_with_bare_remote(tmp.path());
        let gh = GitHub::new();

        gh.git_push(&work, "origin", "main")
            .expect("push to bare remote");
        // A no-op repeat push still exits 0 — re-publish is idempotent.
        gh.git_push(&work, "origin", "main")
            .expect("idempotent re-push");
        gh.git_fetch(&work, "origin")
            .expect("fetch from bare remote");
    }

    #[test]
    fn git_push_failure_surfaces_git_stderr() {
        let tmp = tempfile::tempdir().unwrap();
        let work = repo_with_bare_remote(tmp.path());
        let gh = GitHub::new();

        let err = gh
            .git_push(&work, "no-such-remote", "main")
            .expect_err("pushing to an undefined remote must fail");
        match err {
            StageError::GitCli(msg) => {
                assert!(!msg.is_empty(), "carries git's stderr");
                assert!(
                    msg.contains("no-such-remote"),
                    "names the bad remote: {msg}"
                );
            }
            other => panic!("expected GitCli, got {other:?}"),
        }
    }

    // ---- reviewer entry: fetch the PR head read-only, then opt-in checkout --

    /// A bare "origin" with `main` pushed and a `feat/x` commit (adding
    /// `feat.txt`) exposed as `refs/pull/1/head` — exactly what GitHub publishes
    /// for a PR. Returns a fresh reviewer clone, checked out on `main`, that has
    /// **not** fetched the PR head yet.
    fn pr_remote_and_reviewer_clone(base: &Path) -> PathBuf {
        let remote = base.join("remote.git");
        git(base, &["init", "-q", "--bare", remote.to_str().unwrap()]);

        let publisher = base.join("publisher");
        std::fs::create_dir_all(&publisher).unwrap();
        git(&publisher, &["init", "-q", "-b", "main"]);
        git(&publisher, &["config", "user.email", "t@e.com"]);
        git(&publisher, &["config", "user.name", "t"]);
        std::fs::write(publisher.join("base.txt"), "x\n").unwrap();
        git(&publisher, &["add", "-A"]);
        git(&publisher, &["commit", "-q", "-m", "base"]);
        git(
            &publisher,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&publisher, &["push", "-q", "origin", "main"]);
        git(&publisher, &["checkout", "-q", "-b", "feat/x"]);
        std::fs::write(publisher.join("feat.txt"), "y\n").unwrap();
        git(&publisher, &["add", "-A"]);
        git(&publisher, &["commit", "-q", "-m", "feat"]);
        // GitHub exposes the PR head at refs/pull/<n>/head on the base repo.
        git(
            &publisher,
            &["push", "-q", "origin", "feat/x:refs/pull/1/head"],
        );

        let reviewer = base.join("reviewer");
        git(
            base,
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                reviewer.to_str().unwrap(),
            ],
        );
        reviewer
    }

    #[test]
    fn fetch_pr_head_lands_the_pull_ref_without_touching_the_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let reviewer = pr_remote_and_reviewer_clone(tmp.path());
        let gh = GitHub::new();

        let local = gh
            .fetch_pr_head(&reviewer, "origin", 1, "main")
            .expect("fetch PR head");
        assert_eq!(local, "refs/stage/review/pr-1");

        let repo = git2::Repository::open(&reviewer).unwrap();
        // The PR head and a current base are both resolvable locally now.
        assert!(repo.revparse_single("refs/stage/review/pr-1").is_ok());
        assert!(repo.revparse_single("origin/main").is_ok());
        // Read-only invariant: the working tree was not mutated — the PR's
        // `feat.txt` is not checked out, and HEAD is still `main`.
        assert!(
            !reviewer.join("feat.txt").exists(),
            "fetching a PR head must not write the working tree"
        );
        assert_eq!(repo.head().unwrap().shorthand(), Some("main"));
    }

    #[test]
    fn checkout_local_branch_is_the_lone_opt_in_worktree_mutation() {
        let tmp = tempfile::tempdir().unwrap();
        let reviewer = pr_remote_and_reviewer_clone(tmp.path());
        let gh = GitHub::new();
        let local = gh.fetch_pr_head(&reviewer, "origin", 1, "main").unwrap();

        // Before the confirmed checkout the working tree is untouched.
        assert!(!reviewer.join("feat.txt").exists());

        gh.checkout_local_branch(&reviewer, "feat/x", &local)
            .expect("checkout the PR branch");

        // After it: the PR branch is checked out so the reviewer can build/run.
        assert!(
            reviewer.join("feat.txt").exists(),
            "checkout brings the PR head into the working tree"
        );
        let repo = git2::Repository::open(&reviewer).unwrap();
        assert_eq!(repo.head().unwrap().shorthand(), Some("feat/x"));
    }

    // ---- dashboard PR search: parse + role-distinguishing query -------------

    #[cfg(unix)]
    #[test]
    fn list_repo_prs_parses_authored_and_review_requested() {
        let dir = tempfile::tempdir().unwrap();
        // The fake gh dispatches on the args: a `review-requested:@me` search
        // returns the reviewer fixture, anything else the authored fixture.
        // `comments` is the full array gh streams — we keep only its length;
        // `author` carries gh's extra fields (node id, is_bot) which we ignore.
        let body = "#!/usr/bin/env bash\n\
             if [ \"$1\" = auth ] && [ \"$2\" = status ]; then exit 0; fi\n\
             case \"$*\" in\n\
               *review-requested*)\n\
                 echo '[{\"number\":7,\"title\":\"Their PR\",\"state\":\"OPEN\",\"url\":\"https://gh/7\",\"headRefName\":\"feat/their\",\"baseRefName\":\"main\",\"isDraft\":false,\"additions\":3,\"deletions\":1,\"reviewDecision\":\"REVIEW_REQUIRED\",\"author\":{\"login\":\"them\",\"id\":\"NID\",\"is_bot\":false},\"comments\":[{},{}]}]'\n\
                 ;;\n\
               *)\n\
                 echo '[{\"number\":5,\"title\":\"My PR\",\"state\":\"MERGED\",\"url\":\"https://gh/5\",\"headRefName\":\"feat/mine\",\"baseRefName\":\"main\",\"isDraft\":false,\"additions\":10,\"deletions\":2,\"reviewDecision\":\"\",\"author\":{\"login\":\"me\",\"id\":\"NID\",\"is_bot\":false},\"comments\":[]}]'\n\
                 ;;\n\
             esac\n\
             exit 0\n";
        let fake = write_script(dir.path(), "gh", body);
        let gh = GitHub::with_bins(fake, "git");

        let mine = gh.list_repo_prs("o/r", PrFilter::Authored).unwrap();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].number, 5);
        assert_eq!(mine[0].state, "MERGED");
        assert_eq!(mine[0].author.login, "me");
        assert_eq!(mine[0].additions, 10);
        assert_eq!(mine[0].deletions, 2);
        // Empty comments array → count 0.
        assert_eq!(mine[0].comments, 0);
        assert_eq!(mine[0].review_decision, "");

        let theirs = gh.list_repo_prs("o/r", PrFilter::ReviewRequested).unwrap();
        assert_eq!(theirs.len(), 1);
        assert_eq!(theirs[0].number, 7);
        assert_eq!(theirs[0].state, "OPEN");
        assert_eq!(theirs[0].review_decision, "REVIEW_REQUIRED");
        assert_eq!(theirs[0].author.login, "them");
        // Two-element comments array → count 2 (the bodies are discarded).
        assert_eq!(theirs[0].comments, 2);
    }
}
