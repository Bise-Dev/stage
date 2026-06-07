//! Resolving the Base-branch options for a Self-Review.
//!
//! The base defaults to the **remote** default branch (`origin/HEAD`), so a
//! stale local default, common inside a worktree, does not skew the
//! committed-work diff (ADR-0016). `recommended` is always resolvable: the
//! remote default when it has been fetched, else the local default, else
//! `"main"`.

use std::path::Path;
use std::time::UNIX_EPOCH;

use git2::Repository;
use serde::Serialize;

use crate::error::StageError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDefault {
    /// Local default branch shorthand (e.g. `"main"`).
    pub name: String,
    /// Commits the local default is behind the remote default (0 when up to
    /// date or not comparable).
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseOptions {
    /// The always-resolvable ref to default the Base diff to: the remote default
    /// (`"origin/main"`) when fetched, else the local default name, else `"main"`.
    pub recommended: String,
    /// The remote default ref (`"origin/main"`) when `origin/HEAD` resolves and
    /// the tracking ref exists locally; else `None`.
    pub remote_default: Option<String>,
    /// The local default branch and how far behind the remote default it is.
    pub local_default: Option<LocalDefault>,
    /// Last `git fetch` time (FETCH_HEAD mtime), epoch seconds; `None` if never.
    pub last_fetch_secs: Option<i64>,
}

/// Compute the Base-branch options for the repo at `repo_path`.
pub fn base_options(repo_path: &Path) -> Result<BaseOptions, StageError> {
    let repo = Repository::open(repo_path)?;

    // The default branch name: origin/HEAD's target, else the checked-out branch.
    let default_name = remote_head_shorthand(&repo).or_else(|| local_head_shorthand(&repo));

    // The remote-tracking default ref, only if it exists locally (i.e. fetched).
    let remote_default = default_name.as_ref().and_then(|name| {
        let r = format!("origin/{name}");
        repo.revparse_single(&r).ok().map(|_| r)
    });

    let local_default = match (&default_name, &remote_default) {
        (Some(name), Some(remote)) => Some(LocalDefault {
            name: name.clone(),
            // `unwrap_or(0)` here means "not locally comparable" (e.g. the local
            // default branch doesn't exist), not "up to date".
            behind: behind_count(&repo, name, remote).unwrap_or(0),
        }),
        (Some(name), None) => Some(LocalDefault {
            name: name.clone(),
            behind: 0,
        }),
        _ => None,
    };

    let recommended = remote_default
        .clone()
        .or_else(|| default_name.clone())
        .unwrap_or_else(|| "main".to_string());

    Ok(BaseOptions {
        recommended,
        remote_default,
        local_default,
        last_fetch_secs: last_fetch_secs(&repo),
    })
}

/// `origin/HEAD`'s target shorthand (e.g. `main`), if set.
fn remote_head_shorthand(repo: &Repository) -> Option<String> {
    let reference = repo.find_reference("refs/remotes/origin/HEAD").ok()?;
    let target = reference.symbolic_target()?;
    target.rsplit('/').next().map(str::to_string)
}

/// The checked-out branch shorthand, if HEAD is on a branch.
fn local_head_shorthand(repo: &Repository) -> Option<String> {
    repo.head().ok()?.shorthand().map(str::to_string)
}

/// Commits `local` is behind `remote` (commits in `remote` not in `local`).
fn behind_count(repo: &Repository, local: &str, remote: &str) -> Option<u32> {
    let l = repo
        .revparse_single(local)
        .ok()?
        .peel_to_commit()
        .ok()?
        .id();
    let r = repo
        .revparse_single(remote)
        .ok()?
        .peel_to_commit()
        .ok()?
        .id();
    let (_ahead, behind) = repo.graph_ahead_behind(l, r).ok()?;
    Some(behind as u32)
}

/// FETCH_HEAD mtime (epoch seconds). `git fetch` writes FETCH_HEAD to the
/// **per-worktree** gitdir (`repo.path()`) -- NOT the shared common dir -- so we
/// read it there. Correct for both the main worktree and a linked worktree
/// (whose fetch lands in `<common>/worktrees/<id>/FETCH_HEAD`).
fn last_fetch_secs(repo: &Repository) -> Option<i64> {
    let meta = std::fs::metadata(repo.path().join("FETCH_HEAD")).ok()?;
    let secs = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(secs as i64)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .expect("spawn git");
        assert!(status.success(), "git {args:?} failed in {dir:?}");
    }

    fn commit(dir: &Path, msg: &str) {
        std::fs::write(dir.join("f"), msg).unwrap();
        git(dir, &["add", "."]);
        git(
            dir,
            &[
                "-c",
                "user.email=t@e.com",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "-m",
                msg,
            ],
        );
    }

    #[test]
    fn no_remote_recommends_the_local_default() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        commit(&root, "init");

        let opts = base_options(&root).unwrap();
        assert_eq!(opts.recommended, "main");
        assert!(opts.remote_default.is_none());
        assert_eq!(opts.local_default.unwrap().name, "main");
    }

    #[test]
    fn clone_recommends_origin_default_and_counts_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "-q", "-b", "main"]);
        commit(&origin, "one");

        // Clone sets refs/remotes/origin/HEAD -> main.
        let work = tmp.path().join("work");
        git(
            tmp.path(),
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                work.to_str().unwrap(),
            ],
        );

        let opts = base_options(&work).unwrap();
        assert_eq!(opts.recommended, "origin/main");
        assert_eq!(opts.remote_default.as_deref(), Some("origin/main"));
        assert_eq!(opts.local_default.as_ref().unwrap().behind, 0);

        // Advance origin, fetch in the clone -> local main is now 1 behind.
        commit(&origin, "two");
        git(&work, &["fetch", "-q", "origin"]);
        let opts2 = base_options(&work).unwrap();
        assert_eq!(opts2.local_default.unwrap().behind, 1);
        assert!(
            opts2.last_fetch_secs.is_some(),
            "FETCH_HEAD exists after fetch"
        );
    }

    #[test]
    fn last_fetch_secs_set_after_fetch_in_a_linked_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "-q", "-b", "main"]);
        commit(&origin, "one");

        let work = tmp.path().join("work");
        git(
            tmp.path(),
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                work.to_str().unwrap(),
            ],
        );
        let wt = tmp.path().join("wt");
        git(
            &work,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "feat"],
        );

        // Fetch FROM the linked worktree -- FETCH_HEAD lands in its own gitdir,
        // not the common dir. last_fetch_secs must still find it.
        git(&wt, &["fetch", "-q", "origin"]);

        let opts = base_options(&wt).unwrap();
        assert!(
            opts.last_fetch_secs.is_some(),
            "fetch from a linked worktree must register a last-fetch time"
        );
    }
}
