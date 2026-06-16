//! Deriving the `(repo_owner, repo_name, branch)` key that locates a Debrief.
//!
//! This is the single coordination point between the two writers: the `stage`
//! CLI and the desktop app both call [`repo_key_from_cwd`], so a Debrief the
//! agent writes and the one the app reads resolve to the same row. The shape
//! mirrors the backend Workspace key, easing a future Debrief→Storyline
//! promotion.

use std::path::{Path, PathBuf};

use git2::Repository;
use sha2::{Digest, Sha256};

use crate::error::StageError;

/// Identifies a Debrief's repo+branch scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoKey {
    pub repo_owner: String,
    pub repo_name: String,
    pub branch: String,
}

/// Derive the [`RepoKey`] for the git repository containing `cwd`.
///
/// owner/name come from the `origin` remote URL (falling back to the first
/// configured remote, matching what the app's Workspaces screen shows). With
/// no usable remote we fall back to a deterministic key derived from the
/// canonical repo root — so a Debrief still has a stable home for repos that
/// aren't on GitHub. The branch is the checked-out branch (or a short SHA when
/// detached).
pub fn repo_key_from_cwd(cwd: &Path) -> Result<RepoKey, StageError> {
    let repo = Repository::discover(cwd).map_err(|_| StageError::NotARepo(cwd.to_path_buf()))?;
    let branch = current_branch(&repo);

    if let Some((repo_owner, repo_name)) = primary_remote_url(&repo)
        .as_deref()
        .and_then(slug_from_remote)
    {
        return Ok(RepoKey {
            repo_owner,
            repo_name,
            branch,
        });
    }

    let (repo_owner, repo_name) = local_fallback_slug(&repo)?;
    Ok(RepoKey {
        repo_owner,
        repo_name,
        branch,
    })
}

/// The working-tree root of the git repository containing `cwd`. The `stage`
/// CLI runs from anywhere inside the repo, so it discovers the root rather than
/// assuming `cwd` is it; diff helpers want the root.
pub fn repo_root_from_cwd(cwd: &Path) -> Result<PathBuf, StageError> {
    let repo = Repository::discover(cwd).map_err(|_| StageError::NotARepo(cwd.to_path_buf()))?;
    repo.workdir()
        .map(Path::to_path_buf)
        .ok_or_else(|| StageError::Invalid("bare repositories have no working tree".into()))
}

/// The checked-out branch name, a short SHA if HEAD is detached, or a sentinel
/// for an unborn branch. Shared with `diff` and mirrored by `git.rs`.
pub(crate) fn current_branch(repo: &Repository) -> String {
    match repo.head() {
        Ok(h) if h.is_branch() => h.shorthand().unwrap_or("HEAD").to_string(),
        Ok(h) => h
            .target()
            .map(|oid| oid.to_string()[..8].to_string())
            .unwrap_or_else(|| "HEAD".to_string()),
        Err(_) => "(no commits)".to_string(),
    }
}

/// `origin`'s URL, or the first configured remote's URL. Same precedence as
/// `git.rs::summary`, so the key agrees with the app's repo overview.
fn primary_remote_url(repo: &Repository) -> Option<String> {
    repo.find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(str::to_string))
        .or_else(|| {
            repo.remotes()
                .ok()
                .and_then(|names| names.iter().flatten().next().map(str::to_string))
                .and_then(|name| {
                    repo.find_remote(&name)
                        .ok()
                        .and_then(|r| r.url().map(str::to_string))
                })
        })
}

/// Parse `owner/name` out of a git remote URL.
///
/// Mirrors the client's `slugFromRemote` (`OpenRepository.tsx`): take the last
/// two path segments — separated by `/` or `:` (the latter for scp-style SSH
/// URLs like `git@github.com:owner/repo.git`) — after stripping a trailing
/// slash and a `.git` suffix. Returns `None` when the URL has no such pair.
pub fn slug_from_remote(url: &str) -> Option<(String, String)> {
    let trimmed = url.trim_end_matches('/');
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let mut segments = trimmed.rsplit(['/', ':']).filter(|s| !s.is_empty());
    let name = segments.next()?;
    let owner = segments.next()?;
    Some((owner.to_string(), name.to_string()))
}

/// The `(owner, name)` slug of `repo_root`'s **`origin`** remote, or `None` when
/// there is no git repo there, no `origin` remote, or its URL carries no
/// owner/name pair. This is the reviewer-entry origin-match key (ADR-0022 §6,
/// milestone F): a PR `owner/name` is matched against a candidate clone's
/// `origin`.
///
/// Unlike [`repo_key_from_cwd`] this is **`origin`-only** (no first-remote
/// fallback) and never invents a `local` slug — a non-match must stay a
/// non-match, so an unrelated clone is never mistaken for the PR's repo. A path
/// that isn't a repo is `Ok(None)` (skip it), not an error, so resolution can
/// scan a list of candidates without one bad entry failing the whole lookup.
pub fn origin_slug(repo_root: &Path) -> Result<Option<(String, String)>, StageError> {
    let Ok(repo) = Repository::open(repo_root) else {
        return Ok(None);
    };
    let Ok(remote) = repo.find_remote("origin") else {
        return Ok(None);
    };
    Ok(remote.url().and_then(slug_from_remote))
}

/// No-remote fallback: `("local", "<repo-basename>-<hash8>")`, where the hash is
/// the first 4 bytes of SHA-256 over the canonical **common directory** and the
/// basename is that common dir's parent (the main worktree's directory). Keying
/// on the common dir — not the per-worktree workdir — makes every worktree of a
/// local-only repo resolve to one identity (ADR-0016). `"local"` keeps these out
/// of the GitHub-slug namespace.
fn local_fallback_slug(repo: &Repository) -> Result<(String, String), StageError> {
    let common_dir = crate::worktree::repo_common_dir(repo);
    let canonical = common_dir
        .canonicalize()
        .unwrap_or_else(|_| common_dir.clone());

    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let hash8: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();

    // `.../proj/.git` -> `proj`; fall back to the common dir's own name (bare repos).
    let basename = canonical
        .parent()
        .and_then(|p| p.file_name())
        .or_else(|| canonical.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("repo");
    Ok(("local".to_string(), format!("{basename}-{hash8}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .expect("spawn git");
        assert!(status.success(), "git {args:?} failed in {dir:?}");
    }

    #[test]
    fn worktrees_of_a_no_remote_repo_share_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("f"), "x\n").unwrap();
        git(&root, &["add", "."]);
        git(
            &root,
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
        let linked = tmp.path().join("proj-feat");
        git(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                linked.to_str().unwrap(),
                "-b",
                "feat",
            ],
        );

        let a = repo_key_from_cwd(&root).unwrap();
        let b = repo_key_from_cwd(&linked).unwrap();

        assert_eq!(a.repo_owner, "local");
        assert_eq!(b.repo_owner, "local");
        assert_eq!(
            a.repo_name, b.repo_name,
            "worktrees of one no-remote repo must share identity"
        );
        assert_eq!(a.branch, "main");
        assert_eq!(b.branch, "feat");
    }

    #[test]
    fn slug_parses_https_ssh_and_bare_forms() {
        let cases = [
            ("https://github.com/octo/Stage.git", ("octo", "Stage")),
            ("https://github.com/octo/Stage", ("octo", "Stage")),
            ("https://github.com/octo/Stage/", ("octo", "Stage")),
            ("git@github.com:octo/Stage.git", ("octo", "Stage")),
            ("ssh://git@github.com/octo/Stage.git", ("octo", "Stage")),
            ("git@host.xz:group/sub.repo.git", ("group", "sub.repo")),
        ];
        for (url, (owner, name)) in cases {
            let got = slug_from_remote(url).unwrap_or_else(|| panic!("no slug for {url}"));
            assert_eq!(got, (owner.to_string(), name.to_string()), "url={url}");
        }
    }

    #[test]
    fn slug_rejects_urls_without_owner_and_name() {
        assert_eq!(slug_from_remote(""), None);
        assert_eq!(slug_from_remote("flat"), None);
        assert_eq!(slug_from_remote("/onlyname"), None);
    }

    /// Init a repo with one commit on branch `branch` and an optional `origin`.
    fn fixture(dir: &Path, branch: &str, origin: Option<&str>) -> Repository {
        let repo = Repository::init(dir).unwrap();
        // git2 handles (Tree, Commit) borrow `repo` and hold that borrow until
        // dropped, so confine them to blocks before `repo` is returned.
        {
            std::fs::write(dir.join("README.md"), "hi\n").unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("README.md")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = git2::Signature::now("t", "t@example.com").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }
        {
            let head_ref = repo.head().unwrap();
            let already_on_branch = head_ref.shorthand() == Some(branch);
            if !already_on_branch {
                let commit = head_ref.peel_to_commit().unwrap();
                repo.branch(branch, &commit, false).unwrap();
                repo.set_head(&format!("refs/heads/{branch}")).unwrap();
            }
        }

        if let Some(url) = origin {
            repo.remote("origin", url).unwrap();
        }
        repo
    }

    #[test]
    fn key_uses_origin_slug_and_current_branch() {
        let dir = tempfile::tempdir().unwrap();
        let _repo = fixture(
            dir.path(),
            "feat/key",
            Some("git@github.com:octo/Stage.git"),
        );

        let key = repo_key_from_cwd(dir.path()).unwrap();
        assert_eq!(key.repo_owner, "octo");
        assert_eq!(key.repo_name, "Stage");
        assert_eq!(key.branch, "feat/key");
    }

    #[test]
    fn key_falls_back_to_local_namespace_without_a_remote() {
        let dir = tempfile::tempdir().unwrap();
        let _repo = fixture(dir.path(), "main", None);

        let key = repo_key_from_cwd(dir.path()).unwrap();
        assert_eq!(key.repo_owner, "local");
        assert!(
            key.repo_name.contains('-'),
            "expected basename-hash, got {}",
            key.repo_name
        );
        assert_eq!(key.branch, "main");
    }

    #[test]
    fn key_errors_outside_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        let err = repo_key_from_cwd(dir.path()).unwrap_err();
        assert!(matches!(err, StageError::NotARepo(_)));
    }

    #[test]
    fn origin_slug_reads_the_origin_remote_only() {
        let dir = tempfile::tempdir().unwrap();
        let _repo = fixture(dir.path(), "main", Some("git@github.com:octo/Stage.git"));
        let slug = origin_slug(dir.path()).unwrap();
        assert_eq!(slug, Some(("octo".into(), "Stage".into())));
    }

    #[test]
    fn origin_slug_is_none_without_origin_or_repo() {
        // A repo with no remote at all → None (never the `local` fallback slug).
        let with_repo = tempfile::tempdir().unwrap();
        let _repo = fixture(with_repo.path(), "main", None);
        assert_eq!(origin_slug(with_repo.path()).unwrap(), None);

        // A path that isn't a repo → None (skipped during candidate resolution),
        // not an error.
        let bare = tempfile::tempdir().unwrap();
        assert_eq!(origin_slug(bare.path()).unwrap(), None);
    }
}
