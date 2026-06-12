//! Base-scope (and workdir-scope) git diffing, shared by the desktop app's
//! Self-Review screen and the `stage` CLI. Moved here from `src-tauri`'s
//! `git.rs` so the CLI can compute the same diff without compiling Tauri; the
//! app re-exports these from `git.rs` (ADR-0010, ADR-0011).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use git2::{Diff, DiffOptions, Repository};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use crate::domain::{NoteAnchor, Side};
use crate::error::StageError;
use crate::repo_key::current_branch;

#[derive(Serialize)]
pub struct DiffStats {
    pub added: usize,
    pub removed: usize,
}

/// Resolve a base ref to its commit, **preferring the remote-tracking copy**
/// (`origin/<base_ref>`) over a possibly-stale local branch of the same name —
/// the Self-Review base model (ADR-0016), so a local `main` left behind inside a
/// worktree never skews the diff. Falls back to `base_ref` verbatim for refs
/// that are already remote (`origin/main`), tags, or raw SHAs. Returns the
/// resolved commit and the ref string it actually came from (for the UI).
fn resolve_base_commit<'r>(
    repo: &'r Repository,
    base_ref: &str,
) -> Result<(git2::Commit<'r>, String), StageError> {
    let remote = format!("origin/{base_ref}");
    if let Ok(obj) = repo.revparse_single(&remote) {
        if let Ok(commit) = obj.peel_to_commit() {
            return Ok((commit, remote));
        }
    }
    let commit = repo
        .revparse_single(base_ref)
        .map_err(|e| {
            StageError::Diff(format!(
                "base ref '{base_ref}' not found (also tried '{remote}'): {e}"
            ))
        })?
        .peel_to_commit()
        .map_err(|e| StageError::Diff(format!("peel base commit '{base_ref}' failed: {e}")))?;
    Ok((commit, base_ref.to_string()))
}

/// Added/removed line counts for `head_ref` since it diverged from `base_ref`
/// (diff of the merge-base tree → head tree), matching PR additions/deletions.
pub fn diff_stats(
    repo_path: &Path,
    base_ref: &str,
    head_ref: &str,
) -> Result<DiffStats, StageError> {
    let repo = Repository::open(repo_path)?;
    let (base_commit, _) = resolve_base_commit(&repo, base_ref)?;
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
) -> Result<Vec<ChangedFile>, StageError> {
    let repo = Repository::open(repo_path)?;
    let (base_commit, _) = resolve_base_commit(&repo, base_ref)?;
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
                StageError::Diff(format!(
                    "diff_files: non-UTF-8 or missing path at delta {idx}"
                ))
            })?
            .to_string();
        let (added, removed) = match git2::Patch::from_diff(&diff, idx) {
            Ok(Some(patch)) => {
                let (_context, additions, deletions) = patch.line_stats().map_err(|e| {
                    StageError::Diff(format!("diff_files: line stats for '{path}' failed: {e}"))
                })?;
                (additions, deletions)
            }
            Ok(None) => (0, 0), // binary or no textual patch
            Err(e) => {
                return Err(StageError::Diff(format!(
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
) -> Result<SelfReviewDiff, StageError> {
    let repo = Repository::open(repo_path)?;
    let current_branch = current_branch(&repo);
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
                    StageError::Diff(format!("self_review_diff: staged diff failed: {e}"))
                })?;
            let unstaged = repo
                .diff_index_to_workdir(None, Some(&mut opts))
                .map_err(|e| {
                    StageError::Diff(format!("self_review_diff: unstaged diff failed: {e}"))
                })?;
            combined.merge(&unstaged).map_err(|e| {
                StageError::Diff(format!("self_review_diff: merge diffs failed: {e}"))
            })?;
            (combined, None)
        }
        SelfReviewScope::Base => {
            let base_ref = base_ref.ok_or_else(|| {
                StageError::Diff(
                    "self_review_diff: base_ref required in base scope but was not provided".into(),
                )
            })?;
            let base_commit = repo.revparse_single(base_ref).map_err(|e| {
                StageError::Diff(format!(
                    "self_review_diff: base ref '{base_ref}' not found: {e}"
                ))
            })?;
            let base_commit = base_commit.peel_to_commit().map_err(|e| {
                StageError::Diff(format!("self_review_diff: peel base commit failed: {e}"))
            })?;
            let head_commit = head_commit.ok_or_else(|| {
                StageError::Diff("self_review_diff: repository has no HEAD".into())
            })?;
            let merge_base_oid = repo
                .merge_base(base_commit.id(), head_commit.id())
                .map_err(|e| {
                    StageError::Diff(format!("self_review_diff: merge_base failed: {e}"))
                })?;
            let merge_base_tree = repo
                .find_commit(merge_base_oid)
                .and_then(|c| c.tree())
                .map_err(|e| {
                    StageError::Diff(format!("self_review_diff: merge-base tree failed: {e}"))
                })?;
            // `diff_tree_to_workdir_with_index` covers committed work + index
            // + workdir in one pass. Untracked files are included via opts.
            let diff = repo
                .diff_tree_to_workdir_with_index(Some(&merge_base_tree), Some(&mut opts))
                .map_err(|e| {
                    StageError::Diff(format!("self_review_diff: tree→workdir diff failed: {e}"))
                })?;
            (diff, Some(base_ref.to_string()))
        }
    };

    let files = extract_file_changes(&diff)?;

    let raw_stats = diff
        .stats()
        .map_err(|e| StageError::Diff(format!("self_review_diff: stats failed: {e}")))?;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedDiff {
    /// The base ref the diff was actually computed against (e.g. `origin/main`),
    /// after the remote-tracking preference in [`resolve_base_commit`].
    pub base_ref: String,
    /// The head ref diffed (the storyline/PR branch, e.g. `feature-x`).
    pub head_ref: String,
    /// Short head sha (8 chars). This is the PR head commit — and the `commit_id`
    /// a reviewer needs when posting a line comment against this diff.
    pub head_sha: String,
    pub files: Vec<FileChange>,
    pub stats: SelfReviewStats,
}

/// Diff a storyline's **committed** branch against its base — exactly what the
/// GitHub PR will contain: `merge_base(base, head) → head` (the "three-dot"
/// diff GitHub shows on the PR page).
///
/// Unlike [`self_review_diff`], this never reads the working tree: both sides are
/// resolved as refs, so the result is independent of what (if anything) is
/// checked out. That is the whole point — a storyline can be previewed from the
/// main checkout, any worktree, or none, as long as `head_ref` exists as a
/// committed branch. The base prefers the remote-tracking ref (`origin/<base>`)
/// to dodge a stale local default (ADR-0016).
///
/// Fail-loud per CLAUDE.md: a missing ref or an unreadable patch fails the whole
/// call, naming the offender — never a partial/empty fallback.
pub fn committed_diff(
    repo_path: &Path,
    base_ref: &str,
    head_ref: &str,
) -> Result<CommittedDiff, StageError> {
    let repo = Repository::open(repo_path)?;
    let (base_commit, resolved_base) = resolve_base_commit(&repo, base_ref)?;
    let head_commit = repo
        .revparse_single(head_ref)
        .map_err(|e| {
            StageError::Diff(format!(
                "committed_diff: head ref '{head_ref}' not found: {e}"
            ))
        })?
        .peel_to_commit()
        .map_err(|e| {
            StageError::Diff(format!(
                "committed_diff: peel head commit '{head_ref}' failed: {e}"
            ))
        })?;
    let merge_base_oid = repo
        .merge_base(base_commit.id(), head_commit.id())
        .map_err(|e| StageError::Diff(format!("committed_diff: merge_base failed: {e}")))?;
    let merge_base_tree = repo
        .find_commit(merge_base_oid)
        .and_then(|c| c.tree())
        .map_err(|e| StageError::Diff(format!("committed_diff: merge-base tree failed: {e}")))?;
    let head_tree = head_commit
        .tree()
        .map_err(|e| StageError::Diff(format!("committed_diff: head tree failed: {e}")))?;

    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    let diff = repo
        .diff_tree_to_tree(Some(&merge_base_tree), Some(&head_tree), Some(&mut opts))
        .map_err(|e| StageError::Diff(format!("committed_diff: tree→tree diff failed: {e}")))?;

    let files = extract_file_changes(&diff)?;
    let raw_stats = diff
        .stats()
        .map_err(|e| StageError::Diff(format!("committed_diff: stats failed: {e}")))?;
    let stats = SelfReviewStats {
        added: raw_stats.insertions(),
        removed: raw_stats.deletions(),
        files_changed: raw_stats.files_changed(),
    };
    let head_sha = head_commit.id().to_string()[..8].to_string();

    debug!(
        base_ref = %resolved_base,
        head_ref = %head_ref,
        files = files.len(),
        added = stats.added,
        removed = stats.removed,
        "committed_diff: done",
    );

    Ok(CommittedDiff {
        base_ref: resolved_base,
        head_ref: head_ref.to_string(),
        head_sha,
        files,
        stats,
    })
}

fn extract_file_changes(diff: &Diff) -> Result<Vec<FileChange>, StageError> {
    let num_deltas = diff.deltas().len();
    let mut files = Vec::with_capacity(num_deltas);

    for delta_idx in 0..num_deltas {
        let delta = diff.get_delta(delta_idx).ok_or_else(|| {
            StageError::Diff(format!(
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
                        StageError::Diff(format!(
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
                    return Err(StageError::Diff(format!(
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

/// The repo's default base branch for a Base-scope diff: the `origin/HEAD`
/// target if known (e.g. `main`), else `"main"`. Used as the `--base` default
/// for `stage self-review files`.
pub fn default_base(repo_path: &Path) -> Result<String, StageError> {
    let repo = Repository::open(repo_path)?;
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            if let Some(name) = target.rsplit('/').next() {
                return Ok(name.to_string());
            }
        }
    }
    Ok("main".to_string())
}

/// The set of repo-relative file paths in the Base-scope diff against
/// `base_ref`. Shared by Debrief `set` validation and Review-note `outdated`
/// computation, both of which only need the membership, not the patches.
pub fn base_diff_file_set(repo_path: &Path, base_ref: &str) -> Result<HashSet<String>, StageError> {
    let diff = self_review_diff(repo_path, SelfReviewScope::Base, Some(base_ref))?;
    Ok(diff.files.into_iter().map(|f| f.path).collect())
}

/// Reject any `files` (repo-relative paths) that are not present in the
/// Base-scope diff against `base_ref`. Fail-loud per CLAUDE.md: a Debrief must
/// never reference a file the author isn't actually being shown.
pub fn assert_files_in_base_diff(
    repo_path: &Path,
    base_ref: &str,
    files: &[String],
) -> Result<(), StageError> {
    let present = base_diff_file_set(repo_path, base_ref)?;
    let mut unknown: Vec<&str> = files
        .iter()
        .map(String::as_str)
        .filter(|f| !present.contains(*f))
        .collect();
    if !unknown.is_empty() {
        unknown.sort_unstable();
        unknown.dedup();
        return Err(StageError::Invalid(format!(
            "debrief references {} file(s) not in the diff against '{base_ref}': {}",
            unknown.len(),
            unknown.join(", "),
        )));
    }
    Ok(())
}

/// Per-file present line numbers (per side) for a Base-scope diff, used to
/// compute a Review note's `outdated` flag at **line** granularity. Built once
/// per note-list call and shared by the CLI and the desktop app so both agree
/// (ADR-0012) — the **Stale step** pattern, extended from files to lines.
pub struct DiffLineIndex {
    /// file path → (left lines present, right lines present).
    files: HashMap<String, (HashSet<u32>, HashSet<u32>)>,
    /// Files present in the diff but whose patch can't be line-indexed (binary
    /// or truncated). A line anchor on one of these is treated as **live** — we
    /// can't prove it stale, and falsely flagging a valid note is worse.
    unverifiable: HashSet<String>,
}

impl DiffLineIndex {
    /// Build the index from an already-computed Base-scope diff.
    pub fn from_diff(diff: &SelfReviewDiff) -> Self {
        let mut files = HashMap::new();
        let mut unverifiable = HashSet::new();
        for f in &diff.files {
            if f.is_binary || f.is_truncated {
                unverifiable.insert(f.path.clone());
            } else {
                files.insert(f.path.clone(), index_patch_lines(&f.patch));
            }
        }
        Self {
            files,
            unverifiable,
        }
    }

    /// Build directly from the repo's Base-scope diff against `base_ref`.
    pub fn from_base_diff(repo_path: &Path, base_ref: &str) -> Result<Self, StageError> {
        let diff = self_review_diff(repo_path, SelfReviewScope::Base, Some(base_ref))?;
        Ok(Self::from_diff(&diff))
    }

    /// Whether a note's anchor is outdated against this diff. Anchorless →
    /// never. File-level anchor → outdated iff the file is gone. Line anchor →
    /// outdated iff the file is gone or any line in the range is absent on its
    /// side.
    pub fn is_outdated(&self, anchor: &Option<NoteAnchor>) -> bool {
        let Some(anchor) = anchor else {
            return false;
        };
        let in_diff =
            self.files.contains_key(&anchor.file) || self.unverifiable.contains(&anchor.file);
        if !in_diff {
            return true;
        }
        // File-level anchor (no line range): fresh as long as the file is here.
        let (Some(start), Some(end)) = (anchor.line_start, anchor.line_end) else {
            return false;
        };
        // Line anchor on a binary/truncated file: unverifiable → treat as live.
        let Some((left, right)) = self.files.get(&anchor.file) else {
            return false;
        };
        let set = match anchor.side {
            Some(Side::Left) => left,
            // No side with a line range shouldn't happen, but default to the
            // new-file side (where the author most often comments).
            Some(Side::Right) | None => right,
        };
        (start..=end).any(|n| !set.contains(&n))
    }
}

/// Walk a unified patch and collect the line numbers present per side. Ported
/// from the webview's `indexFileLines` (ADR-0012): `+` lines advance the
/// new-file (right) counter, `-` the old-file (left), context lines both.
fn index_patch_lines(patch: &str) -> (HashSet<u32>, HashSet<u32>) {
    let mut left = HashSet::new();
    let mut right = HashSet::new();
    let mut left_no = 0u32;
    let mut right_no = 0u32;
    for raw in patch.split('\n') {
        if let Some((l, r)) = parse_hunk_header(raw) {
            left_no = l;
            right_no = r;
            continue;
        }
        if raw.starts_with('\\') {
            continue; // "\ No newline at end of file"
        }
        if raw.starts_with('+') && !raw.starts_with("+++") {
            right.insert(right_no);
            right_no += 1;
        } else if raw.starts_with('-') && !raw.starts_with("---") {
            left.insert(left_no);
            left_no += 1;
        } else if raw.starts_with(' ') {
            // Context line — present on both sides. A blank context line is
            // `" "` (space prefix), so this branch covers it; a bare `""` only
            // comes from the patch's trailing newline and must NOT be counted
            // (it would phantom an extra line onto each side).
            left.insert(left_no);
            right.insert(right_no);
            left_no += 1;
            right_no += 1;
        }
    }
    (left, right)
}

/// Parse a hunk header `@@ -l[,s] +r[,s] @@ …` into `(left_start, right_start)`.
/// Returns `None` for any non-header line. Anchored at column 0 (a context line
/// is space-prefixed, an add/remove `+`/`-`-prefixed), so real code lines that
/// happen to contain `@@` never misparse.
fn parse_hunk_header(line: &str) -> Option<(u32, u32)> {
    let rest = line.strip_prefix("@@ ")?;
    let mut it = rest.split_whitespace();
    let left = it
        .next()?
        .strip_prefix('-')?
        .split(',')
        .next()?
        .parse()
        .ok()?;
    let right = it
        .next()?
        .strip_prefix('+')?
        .split(',')
        .next()?
        .parse()
        .ok()?;
    Some((left, right))
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

    #[test]
    fn committed_diff_is_committed_only_and_checkout_independent() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        fs::write(dir.path().join("base.txt"), "x\n").unwrap();
        let base = commit_all(&repo, "base", None);

        // Commit a change on `feat`.
        let base_commit = repo.find_commit(base).unwrap();
        repo.branch("feat", &base_commit, true).unwrap();
        repo.set_head("refs/heads/feat").unwrap();
        fs::write(dir.path().join("feat.txt"), "committed\n").unwrap();
        commit_all(&repo, "feat work", Some(base));

        // Move HEAD off `feat` (detached at base) so the checkout is NOT the head
        // ref, and leave an uncommitted file — committed_diff must ignore both.
        repo.set_head_detached(base).unwrap();
        fs::write(dir.path().join("dirty.txt"), "uncommitted\n").unwrap();

        let diff = committed_diff(dir.path(), &base.to_string(), "feat").unwrap();
        let paths: Vec<&str> = diff.files.iter().map(|f| f.path.as_str()).collect();
        assert!(
            paths.contains(&"feat.txt"),
            "committed branch change must show regardless of checkout: {paths:?}"
        );
        assert!(
            !paths.contains(&"dirty.txt"),
            "uncommitted working-tree change must be excluded: {paths:?}"
        );
        assert_eq!(diff.head_ref, "feat");
    }

    #[test]
    fn base_scope_includes_uncommitted_work_and_validates_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        fs::write(dir.path().join("base.txt"), "x\n").unwrap();
        let base = commit_all(&repo, "base", None);
        // Branch off so merge-base is the base commit, then edit without committing.
        let base_commit = repo.find_commit(base).unwrap();
        repo.branch("feat", &base_commit, true).unwrap();
        repo.set_head("refs/heads/feat").unwrap();
        fs::write(dir.path().join("new.txt"), "fresh\n").unwrap(); // untracked

        let diff =
            self_review_diff(dir.path(), SelfReviewScope::Base, Some(&base.to_string())).unwrap();
        assert!(
            diff.files.iter().any(|f| f.path == "new.txt"),
            "base scope should include the uncommitted new file"
        );

        // Validation: a known file passes, an unknown one is rejected loudly.
        assert!(
            assert_files_in_base_diff(dir.path(), &base.to_string(), &["new.txt".into()]).is_ok()
        );
        let err = assert_files_in_base_diff(
            dir.path(),
            &base.to_string(),
            &["new.txt".into(), "ghost.txt".into()],
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("ghost.txt"),
            "message names the offender: {msg}"
        );
        assert!(
            !msg.contains("new.txt"),
            "message lists only offenders: {msg}"
        );
    }

    fn file_change(path: &str, patch: &str) -> FileChange {
        FileChange {
            path: path.into(),
            old_path: None,
            status: FileStatus::Modified,
            additions: 0,
            deletions: 0,
            patch: patch.into(),
            is_binary: false,
            is_truncated: false,
        }
    }

    fn diff_with(files: Vec<FileChange>) -> SelfReviewDiff {
        SelfReviewDiff {
            current_branch: "feat".into(),
            scope: SelfReviewScope::Base,
            base_ref: Some("main".into()),
            head_sha: "0000000".into(),
            files,
            stats: SelfReviewStats {
                added: 0,
                removed: 0,
                files_changed: 0,
            },
        }
    }

    fn line_anchor(file: &str, start: u32, end: u32, side: Side) -> Option<NoteAnchor> {
        Some(NoteAnchor {
            file: file.into(),
            line_start: Some(start),
            line_end: Some(end),
            side: Some(side),
        })
    }

    #[test]
    fn line_index_marks_outdated_at_line_granularity() {
        // right present {1,2,3,4}; left present {1,2,3}
        let patch = "@@ -1,3 +1,4 @@\n ctx1\n-old2\n+new2\n+new3\n ctx4\n";
        let index = DiffLineIndex::from_diff(&diff_with(vec![file_change("a.rs", patch)]));

        // Present lines on each side → fresh.
        assert!(!index.is_outdated(&line_anchor("a.rs", 2, 2, Side::Right)));
        assert!(!index.is_outdated(&line_anchor("a.rs", 3, 3, Side::Left)));
        // A right-side line beyond the patch → outdated.
        assert!(index.is_outdated(&line_anchor("a.rs", 5, 5, Side::Right)));
        // File-level anchor on a present file → fresh.
        assert!(!index.is_outdated(&Some(NoteAnchor {
            file: "a.rs".into(),
            line_start: None,
            line_end: None,
            side: None,
        })));
        // Anchor to a file not in the diff → outdated.
        assert!(index.is_outdated(&line_anchor("gone.rs", 1, 1, Side::Right)));
        // Anchorless (general) note → never outdated.
        assert!(!index.is_outdated(&None));
    }

    #[test]
    fn line_anchor_on_binary_or_truncated_file_is_treated_as_live() {
        let mut binary = file_change("img.png", "");
        binary.is_binary = true;
        let mut truncated = file_change("big.rs", "@@ -1,1 +1,1 @@\n+x\n");
        truncated.is_truncated = true;
        let index = DiffLineIndex::from_diff(&diff_with(vec![binary, truncated]));

        // File present but unindexable → can't prove stale → live (not outdated).
        assert!(!index.is_outdated(&line_anchor("img.png", 1, 1, Side::Right)));
        assert!(!index.is_outdated(&line_anchor("big.rs", 99, 99, Side::Right)));
    }
}
