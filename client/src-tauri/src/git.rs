use std::path::Path;
use std::process::Command;

use git2::{BranchType, Repository};
use serde::Serialize;

use crate::errors::AppError;

pub fn current_branch(repo_path: &Path) -> Result<String, AppError> {
    let repo = Repository::open(repo_path)?;
    let head = repo.head()?;
    Ok(head.shorthand().unwrap_or("HEAD").to_string())
}

#[derive(Serialize)]
pub struct RepoSummary {
    #[serde(rename = "defaultBranch")]
    pub default_branch: Option<String>,
    #[serde(rename = "branchesCount")]
    pub branches_count: u32,
    #[serde(rename = "remoteUrl")]
    pub remote_url: Option<String>,
}

pub fn summary(repo_path: &Path) -> Result<RepoSummary, AppError> {
    let repo = Repository::open(repo_path)?;

    let branches_count = repo
        .branches(Some(BranchType::Local))
        .map(|iter| iter.filter(|b| b.is_ok()).count() as u32)
        .unwrap_or(0);

    let remote_url = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(str::to_string))
        .or_else(|| {
            // Fall back to first available remote if origin isn't present.
            repo.remotes()
                .ok()
                .and_then(|names| names.iter().flatten().next().map(str::to_string))
                .and_then(|name| {
                    repo.find_remote(&name)
                        .ok()
                        .and_then(|r| r.url().map(str::to_string))
                })
        });

    let default_branch = default_branch_for(&repo);

    Ok(RepoSummary {
        default_branch,
        branches_count,
        remote_url,
    })
}

#[derive(Serialize)]
pub struct BranchInfo {
    pub name: String,
    #[serde(rename = "isHead")]
    pub is_head: bool,
    /// Last-commit time, epoch seconds (UTC). Formatted on the client.
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    #[serde(rename = "lastCommit")]
    pub last_commit: Option<String>,
}

/// All local branches, most-recently-committed first.
///
/// Per the project's fail-loud convention (CLAUDE.md "Error handling"): if
/// any single ref is unreadable, the whole call fails with a message that
/// names the offending branch — preferable to silently dropping a row the
/// user can't see is missing.
pub fn local_branches(repo_path: &Path) -> Result<Vec<BranchInfo>, AppError> {
    let repo = Repository::open(repo_path)?;
    let mut out = Vec::new();

    for entry in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = entry.map_err(|e| {
            AppError::Backend(format!("local_branches: branch iterator failed: {e}"))
        })?;
        let raw_name = branch.name().map_err(|e| {
            AppError::Backend(format!("local_branches: unreadable branch name: {e}"))
        })?;
        let Some(name) = raw_name.map(str::to_string) else {
            // Non-UTF-8 ref name — the webview can't render it; fail loud
            // rather than quietly hide branches the user has on disk.
            return Err(AppError::Backend(
                "local_branches: non-UTF-8 branch name in repository".into(),
            ));
        };
        let is_head = branch.is_head();
        let commit = branch.get().peel_to_commit().map_err(|e| {
            AppError::Backend(format!(
                "local_branches: branch '{name}' has unreadable commit: {e}"
            ))
        })?;
        out.push(BranchInfo {
            name,
            is_head,
            updated_at: commit.time().seconds(),
            last_commit: commit.summary().map(str::to_string),
        });
    }

    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[derive(Serialize)]
pub struct DiffStats {
    pub added: usize,
    pub removed: usize,
}

/// Added/removed line counts for `head_ref` since it diverged from `base_ref`
/// (diff of the merge-base tree → head tree), matching PR additions/deletions.
pub fn diff_stats(repo_path: &Path, base_ref: &str, head_ref: &str) -> Result<DiffStats, AppError> {
    let repo = Repository::open(repo_path)?;
    let base_commit = repo.revparse_single(base_ref)?.peel_to_commit()?;
    let head_commit = repo.revparse_single(head_ref)?.peel_to_commit()?;
    let merge_base = repo.merge_base(base_commit.id(), head_commit.id())?;
    let base_tree = repo.find_commit(merge_base)?.tree()?;
    let head_tree = head_commit.tree()?;
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), None)?;
    let stats = diff.stats()?;
    Ok(DiffStats {
        added: stats.insertions(),
        removed: stats.deletions(),
    })
}

#[derive(Serialize)]
pub struct FetchOutcome {
    pub remote: String,
}

/// `git fetch --prune` against the primary remote.
///
/// Shells out to the system `git` rather than libgit2's transport: the vendored
/// libgit2 has no TLS/SSH transport ("unsupported URL protocol"), and the system
/// git transparently uses the user's own credentials (ssh-agent, credential
/// helpers, proxies). Stage holds no GitHub credentials of its own — this is a
/// plain local git-transport op. We still use libgit2 to resolve the remote name.
pub fn fetch(repo_path: &Path) -> Result<FetchOutcome, AppError> {
    let remote_name = {
        let repo = Repository::open(repo_path)?;
        primary_remote(&repo)?
    };

    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["fetch", "--prune", &remote_name])
        .output()
        .map_err(|e| AppError::Backend(format!("git_spawn_failed: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        return Err(AppError::Backend(if msg.is_empty() {
            "git fetch failed".to_string()
        } else {
            msg.to_string()
        }));
    }

    Ok(FetchOutcome {
        remote: remote_name,
    })
}

/// `origin` if present, otherwise the first configured remote.
fn primary_remote(repo: &Repository) -> Result<String, AppError> {
    if repo.find_remote("origin").is_ok() {
        return Ok("origin".to_string());
    }
    repo.remotes()?
        .iter()
        .flatten()
        .next()
        .map(str::to_string)
        .ok_or_else(|| AppError::Backend("no_remote_configured".into()))
}

fn default_branch_for(repo: &Repository) -> Option<String> {
    // Prefer the remote HEAD if present (e.g. refs/remotes/origin/HEAD → main).
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            if let Some(name) = target.rsplit('/').next() {
                return Some(name.to_string());
            }
        }
    }
    // Fall back to whatever the local HEAD points at.
    if let Ok(head) = repo.head() {
        if let Some(name) = head.shorthand() {
            return Some(name.to_string());
        }
    }
    None
}
