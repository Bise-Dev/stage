//! Deriving the `(repo_owner, repo_name, branch)` key that locates a Handoff.
//!
//! This is the single coordination point between the two writers: the `stage`
//! CLI and the desktop app both call [`repo_key_from_cwd`], so a Handoff the
//! agent writes and the one the app reads resolve to the same row. The shape
//! mirrors the backend Workspace key, easing a future Handoff→Storyline
//! promotion.

use std::path::{Path, PathBuf};

use git2::Repository;
use sha2::{Digest, Sha256};

use crate::error::StageError;

/// Identifies a Handoff's repo+branch scope.
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
/// canonical repo root — so a Handoff still has a stable home for repos that
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

/// No-remote fallback: `("local", "<repo-basename>-<hash8>")`, where the hash is
/// the first 4 bytes of SHA-256 over the canonical repo root. Deterministic and
/// effectively collision-free across a user's handful of local repos; `"local"`
/// keeps these out of the GitHub-slug namespace.
fn local_fallback_slug(repo: &Repository) -> Result<(String, String), StageError> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| StageError::Invalid("bare repositories have no working tree".into()))?;
    let canonical = workdir
        .canonicalize()
        .unwrap_or_else(|_| workdir.to_path_buf());

    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let hash8: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();

    let basename = canonical
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("repo");
    Ok(("local".to_string(), format!("{basename}-{hash8}")))
}

#[cfg(test)]
mod tests {
    use super::*;

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
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch(branch, &head, true).unwrap();
        }
        repo.set_head(&format!("refs/heads/{branch}")).unwrap();

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
}
