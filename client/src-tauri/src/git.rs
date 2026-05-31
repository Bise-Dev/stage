use std::path::Path;
use std::process::Command;

use git2::{BranchType, Diff, DiffOptions, Repository};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

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

    out.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
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
pub struct ChangedFile {
    pub path: String,
    /// One of "A" added, "M" modified, "D" deleted, "R" renamed, "C" copied, "?" other.
    pub status: String,
    pub added: usize,
    pub removed: usize,
}

/// Files changed in `head_ref` since it diverged from `base_ref` (merge-base
/// tree → head tree), with per-file +/− counts. Same resolution as
/// [`diff_stats`]; here we enumerate per-file deltas instead of aggregating.
///
/// Rename detection is intentionally off (no `find_similar`): a rename surfaces
/// as a delete + add pair, which is fine for v1's file-ordering UI. Fail-loud
/// per CLAUDE.md: an unreadable delta/path fails the whole call naming the
/// offending index rather than silently dropping a file the user can't see.
pub fn diff_files(
    repo_path: &Path,
    base_ref: &str,
    head_ref: &str,
) -> Result<Vec<ChangedFile>, AppError> {
    let repo = Repository::open(repo_path)?;
    let base_commit = repo.revparse_single(base_ref)?.peel_to_commit()?;
    let head_commit = repo.revparse_single(head_ref)?.peel_to_commit()?;
    let merge_base = repo.merge_base(base_commit.id(), head_commit.id())?;
    let base_tree = repo.find_commit(merge_base)?.tree()?;
    let head_tree = head_commit.tree()?;
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), None)?;

    let mut out = Vec::new();
    for (idx, delta) in diff.deltas().enumerate() {
        let status = match delta.status() {
            git2::Delta::Added => "A",
            git2::Delta::Deleted => "D",
            git2::Delta::Modified => "M",
            // No Renamed/Copied: rename detection is off (see the fn doc), so a
            // rename surfaces as a Deleted + Added pair, never Delta::Renamed.
            _ => "?",
        }
        .to_string();
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .and_then(|p| p.to_str())
            .ok_or_else(|| {
                AppError::Backend(format!(
                    "diff_files: non-UTF-8 or missing path at delta {idx}"
                ))
            })?
            .to_string();
        let (added, removed) = match git2::Patch::from_diff(&diff, idx) {
            Ok(Some(patch)) => {
                let (_context, additions, deletions) = patch.line_stats().map_err(|e| {
                    AppError::Backend(format!("diff_files: line stats for '{path}' failed: {e}"))
                })?;
                (additions, deletions)
            }
            Ok(None) => (0, 0), // binary or no textual patch
            Err(e) => {
                return Err(AppError::Backend(format!(
                    "diff_files: patch failed for '{path}': {e}"
                )))
            }
        };
        out.push(ChangedFile {
            path,
            status,
            added,
            removed,
        });
    }
    Ok(out)
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

/// Per-file patch text cap — see ADR-0010 / CLAUDE.md "Error handling".
/// Large lockfile diffs would otherwise blow through the IPC payload; the
/// frontend still renders the file (collapsed-with-warning), just not the
/// full patch.
const PATCH_SIZE_CAP: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SelfReviewScope {
    /// `HEAD → index → workdir + untracked` — only uncommitted edits.
    Workdir,
    /// `merge_base(base_ref, HEAD) → workdir + index` — committed branch work
    /// plus any pending uncommitted edits, i.e. "what the PR would contain if
    /// the author committed everything right now".
    Base,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: usize,
    pub deletions: usize,
    pub patch: String,
    pub is_binary: bool,
    /// True if `patch` was clipped at `PATCH_SIZE_CAP`. The frontend should
    /// surface a "diff too large — showing first N KB" hint when set.
    pub is_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfReviewStats {
    pub added: usize,
    pub removed: usize,
    pub files_changed: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfReviewDiff {
    pub current_branch: String,
    pub scope: SelfReviewScope,
    /// Only set when `scope == Base`; the ref the diff was computed against.
    pub base_ref: Option<String>,
    /// Short HEAD sha (8 chars), surfaced for stale-anchor detection on the
    /// frontend when the watcher re-fetches mid-session.
    pub head_sha: String,
    pub files: Vec<FileChange>,
    pub stats: SelfReviewStats,
}

/// Compute the diff that the Self-Review screen renders.
///
/// In `Workdir` mode: HEAD → index → workdir, with untracked files folded in
/// (so a brand-new file shows up as full additions). In `Base` mode: from
/// the merge-base of `base_ref` and HEAD down to the working tree (committed
/// branch work plus any pending uncommitted edits).
///
/// Per CLAUDE.md "Error handling" this fails loud on any per-delta patch
/// extraction failure — the frontend should never have to wonder whether a
/// row's patch text is real or a fallback.
pub fn self_review_diff(
    repo_path: &Path,
    scope: SelfReviewScope,
    base_ref: Option<&str>,
) -> Result<SelfReviewDiff, AppError> {
    let repo = Repository::open(repo_path)?;
    let current_branch = current_branch_name(&repo);
    let head_commit = repo.head().and_then(|h| h.peel_to_commit()).ok();
    let head_sha = head_commit
        .as_ref()
        .map(|c| c.id().to_string()[..8].to_string())
        .unwrap_or_else(|| "0000000".to_string());

    debug!(
        scope = ?scope,
        base_ref = base_ref,
        branch = %current_branch,
        "self_review_diff: start",
    );

    let head_tree = head_commit.as_ref().and_then(|c| c.tree().ok());

    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    opts.show_untracked_content(true);

    let (diff, resolved_base_ref) = match scope {
        SelfReviewScope::Workdir => {
            // HEAD → index → workdir, merged.
            let mut combined = repo
                .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
                .map_err(|e| {
                    AppError::Backend(format!("self_review_diff: staged diff failed: {e}"))
                })?;
            let unstaged = repo
                .diff_index_to_workdir(None, Some(&mut opts))
                .map_err(|e| {
                    AppError::Backend(format!("self_review_diff: unstaged diff failed: {e}"))
                })?;
            combined.merge(&unstaged).map_err(|e| {
                AppError::Backend(format!("self_review_diff: merge diffs failed: {e}"))
            })?;
            (combined, None)
        }
        SelfReviewScope::Base => {
            let base_ref = base_ref.ok_or_else(|| {
                AppError::Backend(
                    "self_review_diff: base_ref required in base scope but was not provided".into(),
                )
            })?;
            let base_commit = repo.revparse_single(base_ref).map_err(|e| {
                AppError::Backend(format!(
                    "self_review_diff: base ref '{base_ref}' not found: {e}"
                ))
            })?;
            let base_commit = base_commit.peel_to_commit().map_err(|e| {
                AppError::Backend(format!("self_review_diff: peel base commit failed: {e}"))
            })?;
            let head_commit = head_commit.ok_or_else(|| {
                AppError::Backend("self_review_diff: repository has no HEAD".into())
            })?;
            let merge_base_oid = repo
                .merge_base(base_commit.id(), head_commit.id())
                .map_err(|e| {
                    AppError::Backend(format!("self_review_diff: merge_base failed: {e}"))
                })?;
            let merge_base_tree = repo
                .find_commit(merge_base_oid)
                .and_then(|c| c.tree())
                .map_err(|e| {
                    AppError::Backend(format!("self_review_diff: merge-base tree failed: {e}"))
                })?;
            // `diff_tree_to_workdir_with_index` covers committed work + index
            // + workdir in one pass. Untracked files are included via opts.
            let diff = repo
                .diff_tree_to_workdir_with_index(Some(&merge_base_tree), Some(&mut opts))
                .map_err(|e| {
                    AppError::Backend(format!("self_review_diff: tree→workdir diff failed: {e}"))
                })?;
            (diff, Some(base_ref.to_string()))
        }
    };

    let files = extract_file_changes(&diff)?;

    let raw_stats = diff
        .stats()
        .map_err(|e| AppError::Backend(format!("self_review_diff: stats failed: {e}")))?;
    let stats = SelfReviewStats {
        added: raw_stats.insertions(),
        removed: raw_stats.deletions(),
        files_changed: raw_stats.files_changed(),
    };

    debug!(
        files = files.len(),
        added = stats.added,
        removed = stats.removed,
        "self_review_diff: done",
    );

    Ok(SelfReviewDiff {
        current_branch,
        scope,
        base_ref: resolved_base_ref,
        head_sha,
        files,
        stats,
    })
}

fn current_branch_name(repo: &Repository) -> String {
    match repo.head() {
        Ok(h) if h.is_branch() => h.shorthand().unwrap_or("HEAD").to_string(),
        Ok(h) => h
            .target()
            .map(|oid| oid.to_string()[..8].to_string())
            .unwrap_or_else(|| "HEAD".to_string()),
        Err(_) => "(no commits)".to_string(),
    }
}

fn extract_file_changes(diff: &Diff) -> Result<Vec<FileChange>, AppError> {
    let num_deltas = diff.deltas().len();
    let mut files = Vec::with_capacity(num_deltas);

    for delta_idx in 0..num_deltas {
        let delta = diff.get_delta(delta_idx).ok_or_else(|| {
            AppError::Backend(format!(
                "self_review_diff: delta {delta_idx} disappeared mid-iter"
            ))
        })?;

        let status = match delta.status() {
            git2::Delta::Added | git2::Delta::Untracked => FileStatus::Added,
            git2::Delta::Deleted => FileStatus::Deleted,
            git2::Delta::Renamed => FileStatus::Renamed,
            // Copied is rare and reads like a modify to the user; group it.
            git2::Delta::Modified | git2::Delta::Copied | git2::Delta::Typechange => {
                FileStatus::Modified
            }
            other => {
                warn!(
                    ?other,
                    "self_review_diff: unexpected delta status, treating as modified"
                );
                FileStatus::Modified
            }
        };

        let new_file = delta.new_file();
        let old_file = delta.old_file();
        let path = new_file
            .path()
            .or_else(|| old_file.path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let old_path = if matches!(status, FileStatus::Renamed) {
            old_file.path().map(|p| p.to_string_lossy().to_string())
        } else {
            None
        };

        // Binary detection via the delta flags. libgit2 marks a delta as
        // binary when at least one side is binary; we render those as
        // "binary file" rather than dumping the bytes.
        let is_binary = delta.flags().contains(git2::DiffFlags::BINARY)
            || new_file.is_binary()
            || old_file.is_binary();

        // Patch extraction. A None from from_diff indicates an unfilled patch
        // (typical for binary or empty deltas) — that's a valid empty patch,
        // not a failure. An Err is a real failure: name the offending file.
        let mut patch_text = String::new();
        let mut additions = 0usize;
        let mut deletions = 0usize;
        if !is_binary {
            match git2::Patch::from_diff(diff, delta_idx) {
                Ok(Some(mut patch)) => {
                    let buf = patch.to_buf().map_err(|e| {
                        AppError::Backend(format!(
                            "self_review_diff: patch to_buf failed for {path}: {e}"
                        ))
                    })?;
                    patch_text = String::from_utf8_lossy(&buf).to_string();
                    for line in patch_text.lines() {
                        if line.starts_with('+') && !line.starts_with("+++") {
                            additions += 1;
                        } else if line.starts_with('-') && !line.starts_with("---") {
                            deletions += 1;
                        }
                    }
                }
                Ok(None) => { /* empty patch — leave defaults */ }
                Err(e) => {
                    return Err(AppError::Backend(format!(
                        "self_review_diff: patch extraction failed for {path}: {e}"
                    )));
                }
            }
        }

        let is_truncated = patch_text.len() > PATCH_SIZE_CAP;
        if is_truncated {
            // Char-boundary clamp: truncate at the last codepoint boundary
            // <= the cap. String slicing on a non-boundary would panic.
            let mut cap = PATCH_SIZE_CAP;
            while cap > 0 && !patch_text.is_char_boundary(cap) {
                cap -= 1;
            }
            patch_text.truncate(cap);
        }

        files.push(FileChange {
            path,
            old_path,
            status,
            additions,
            deletions,
            patch: patch_text,
            is_binary,
            is_truncated,
        });
    }

    Ok(files)
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

#[cfg(test)]
mod tests {
    use std::fs;

    use git2::{IndexAddOption, Repository, Signature};

    use super::*;

    fn commit_all(repo: &Repository, msg: &str, parent: Option<git2::Oid>) -> git2::Oid {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("t", "t@example.com").unwrap();
        let parents: Vec<git2::Commit> = parent
            .map(|p| repo.find_commit(p).unwrap())
            .into_iter()
            .collect();
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs)
            .unwrap()
    }

    #[test]
    fn diff_files_lists_added_modified_and_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();

        fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        fs::write(dir.path().join("gone.txt"), "bye\n").unwrap();
        let base = commit_all(&repo, "base", None);

        fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap(); // modify
        fs::write(dir.path().join("b.txt"), "hello\n").unwrap(); // add
        fs::remove_file(dir.path().join("gone.txt")).unwrap(); // delete
        let head = commit_all(&repo, "head", Some(base));

        let files = diff_files(dir.path(), &base.to_string(), &head.to_string()).unwrap();
        let mut got: Vec<(&str, &str)> = files
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str()))
            .collect();
        got.sort();
        assert_eq!(got, vec![("a.txt", "M"), ("b.txt", "A"), ("gone.txt", "D")]);

        let b = files.iter().find(|f| f.path == "b.txt").unwrap();
        assert_eq!(b.added, 1);
        assert_eq!(b.removed, 0);
    }
}
