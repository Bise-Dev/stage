//! ST-1 #89 — the single, unified storyline-staleness check.
//!
//! A storyline step is *stale* when its diff anchor no longer lines up with the
//! change the branch actually contains. Historically Stage detected this in two
//! places — the client's pre-publish check and the backend's post-publish check.
//! This module is the **one** check that replaces both (ADR-0022 §7, WS-5): each
//! step's `anchor` is flagged against the **current committed diff** for whoever
//! holds the branch, in Rust, with a reason. **Nothing here auto-fixes** —
//! detection only; the author re-anchors by hand.
//!
//! Pass the pre-publish draft's step files or the published `.stage` step
//! anchors — same call, same rules.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use git2::{DiffFindOptions, DiffOptions, Repository};
use serde::Serialize;
use ts_rs::TS;

use crate::diff::resolve_base_commit;
use crate::error::StageError;

/// Why a storyline step is stale (ST-1 #89). A step with no reason is fresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum StaleReason {
    /// The anchored file was deleted in the current committed diff.
    Removed,
    /// The anchored file was renamed; the step still points at the old path. The
    /// new path rides on [`StepStaleness::renamed_to`] (informational only).
    Renamed,
    /// The anchored file is untouched by the change set — not part of this
    /// branch's diff at all, so the step narrates code the PR doesn't contain.
    NotInChangeSet,
}

/// The staleness verdict for one storyline step against the current committed
/// diff (ST-1 #89). Computed, never stored; nothing here auto-fixes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StepStaleness {
    /// The step's anchor — the repo-relative file path it narrates.
    pub anchor: String,
    /// `true` when the step no longer lines up with the diff (⇔ `reason.is_some()`).
    pub stale: bool,
    /// Why it's stale, or `None` when fresh.
    pub reason: Option<StaleReason>,
    /// For [`StaleReason::Renamed`]: the file's new path in the diff, surfaced so
    /// the author can re-anchor by hand. `None` in every other case.
    pub renamed_to: Option<String>,
}

impl StepStaleness {
    fn fresh(anchor: String) -> Self {
        Self {
            anchor,
            stale: false,
            reason: None,
            renamed_to: None,
        }
    }

    fn stale(anchor: String, reason: StaleReason, renamed_to: Option<String>) -> Self {
        Self {
            anchor,
            stale: true,
            reason: Some(reason),
            renamed_to,
        }
    }
}

/// Flag each storyline step's anchor against the **current committed diff** for
/// whoever holds the branch — `merge_base(base_ref, head_ref) → head_ref`, the
/// three-dot diff GitHub shows (ADR-0018), with rename detection **on** so a
/// moved file reads as a `Renamed` delta rather than a delete + add pair.
///
/// This is the *single* staleness check (ST-1 #89): one Rust computation in
/// place of the former client-pre-publish and backend-post-publish sites.
///
/// Per-step rules, given the diff's classified file sets:
/// - anchor is a changed path — added / modified / a rename's **new** path → fresh;
/// - anchor is a rename's **old** path → [`StaleReason::Renamed`] (+ `renamed_to`);
/// - anchor is a deleted path → [`StaleReason::Removed`];
/// - anchor appears nowhere in the diff → [`StaleReason::NotInChangeSet`].
///
/// Fail loud (CLAUDE.md): a bad ref or an unreadable diff fails the whole call —
/// never a partial verdict that leaves the author guessing which rows are real.
pub fn assess_step_staleness(
    repo_root: &Path,
    base_ref: &str,
    head_ref: &str,
    step_anchors: &[String],
) -> Result<Vec<StepStaleness>, StageError> {
    let repo = Repository::open(repo_root)?;
    let (base_commit, _) = resolve_base_commit(&repo, base_ref)?;
    let head_commit = repo
        .revparse_single(head_ref)
        .map_err(|e| StageError::Diff(format!("staleness: head ref '{head_ref}' not found: {e}")))?
        .peel_to_commit()
        .map_err(|e| StageError::Diff(format!("staleness: peel head '{head_ref}' failed: {e}")))?;
    let merge_base = repo
        .merge_base(base_commit.id(), head_commit.id())
        .map_err(|e| StageError::Diff(format!("staleness: merge_base failed: {e}")))?;
    let base_tree = repo
        .find_commit(merge_base)
        .and_then(|c| c.tree())
        .map_err(|e| StageError::Diff(format!("staleness: merge-base tree failed: {e}")))?;
    let head_tree = head_commit
        .tree()
        .map_err(|e| StageError::Diff(format!("staleness: head tree failed: {e}")))?;

    let mut opts = DiffOptions::new();
    let mut diff = repo
        .diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))
        .map_err(|e| StageError::Diff(format!("staleness: tree→tree diff failed: {e}")))?;
    // Rename detection: a moved file then reads as one `Renamed` delta (old→new),
    // giving the precise "renamed" reason instead of a delete + add pair (which
    // is all the plain `diff_files`/`committed_diff` produce).
    let mut find = DiffFindOptions::new();
    find.renames(true);
    diff.find_similar(Some(&mut find))
        .map_err(|e| StageError::Diff(format!("staleness: rename detection failed: {e}")))?;

    // Classify the diff once into the three sets the per-anchor rules consult.
    let mut present: HashSet<String> = HashSet::new(); // live paths (added/modified/rename-new)
    let mut removed: HashSet<String> = HashSet::new(); // deleted paths
    let mut renamed_from: HashMap<String, String> = HashMap::new(); // old path → new path
    for delta in diff.deltas() {
        let new_path = delta
            .new_file()
            .path()
            .and_then(|p| p.to_str())
            .map(str::to_string);
        let old_path = delta
            .old_file()
            .path()
            .and_then(|p| p.to_str())
            .map(str::to_string);
        match delta.status() {
            git2::Delta::Deleted => {
                if let Some(p) = old_path {
                    removed.insert(p);
                }
            }
            git2::Delta::Renamed => {
                if let (Some(old), Some(new)) = (old_path, new_path.clone()) {
                    renamed_from.insert(old, new);
                }
                if let Some(p) = new_path {
                    present.insert(p);
                }
            }
            // Added / Modified / Copied / Typechange: the current path is live.
            _ => {
                if let Some(p) = new_path.or(old_path) {
                    present.insert(p);
                }
            }
        }
    }

    Ok(step_anchors
        .iter()
        .map(|anchor| {
            if present.contains(anchor) {
                StepStaleness::fresh(anchor.clone())
            } else if let Some(new_path) = renamed_from.get(anchor) {
                StepStaleness::stale(anchor.clone(), StaleReason::Renamed, Some(new_path.clone()))
            } else if removed.contains(anchor) {
                StepStaleness::stale(anchor.clone(), StaleReason::Removed, None)
            } else {
                StepStaleness::stale(anchor.clone(), StaleReason::NotInChangeSet, None)
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .expect("spawn git")
            .success();
        assert!(ok, "git {args:?} failed in {dir:?}");
    }

    #[test]
    fn assess_step_staleness_flags_removed_renamed_and_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.email", "t@e.com"]);
        git(root, &["config", "user.name", "t"]);
        std::fs::write(root.join("keep.rs"), "fn keep() {}\n").unwrap();
        std::fs::write(root.join("del.rs"), "fn del() {}\n").unwrap();
        // Substantial, identical content so the move is detected as an exact rename.
        std::fs::write(
            root.join("move_me.rs"),
            "fn a() {}\nfn b() {}\nfn c() {}\nfn d() {}\n",
        )
        .unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "init"]);

        git(root, &["checkout", "-q", "-b", "feat/x"]);
        std::fs::write(root.join("keep.rs"), "fn keep() {}\n// touched\n").unwrap();
        git(root, &["rm", "del.rs"]);
        git(root, &["mv", "move_me.rs", "moved.rs"]);
        std::fs::write(root.join("new.rs"), "fn brand_new() {}\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "change"]);

        let anchors = vec![
            "keep.rs".to_string(),
            "moved.rs".to_string(),
            "del.rs".to_string(),
            "move_me.rs".to_string(),
            "untouched.rs".to_string(),
        ];
        let out = assess_step_staleness(root, "main", "feat/x", &anchors).unwrap();
        let by = |a: &str| {
            out.iter()
                .find(|s| s.anchor == a)
                .unwrap_or_else(|| panic!("missing verdict for {a}"))
        };

        // A modified file and a rename's new path both stay fresh.
        assert!(!by("keep.rs").stale, "modified file is fresh");
        assert!(!by("moved.rs").stale, "rename's new path is fresh");

        let del = by("del.rs");
        assert!(del.stale);
        assert_eq!(del.reason, Some(StaleReason::Removed));
        assert_eq!(del.renamed_to, None);

        let mv = by("move_me.rs");
        assert!(mv.stale);
        assert_eq!(mv.reason, Some(StaleReason::Renamed));
        assert_eq!(mv.renamed_to.as_deref(), Some("moved.rs"));

        let absent = by("untouched.rs");
        assert!(absent.stale);
        assert_eq!(absent.reason, Some(StaleReason::NotInChangeSet));
    }

    #[test]
    fn no_anchors_yields_no_verdicts() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.email", "t@e.com"]);
        git(root, &["config", "user.name", "t"]);
        std::fs::write(root.join("a.rs"), "x\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "init"]);
        // base == head: an empty diff, and no anchors → an empty result.
        let out = assess_step_staleness(root, "main", "main", &[]).unwrap();
        assert!(out.is_empty());
    }
}
