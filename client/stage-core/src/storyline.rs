//! The pre-publish **storyline** — the author's ordered, annotated walkthrough
//! of one change (ADR-0022 §1, milestone B). Each step is anchored to a file in
//! the change's diff and carries an intro (markdown) plus an optional title.
//!
//! Lifecycle (ADR-0022 §3): Self-Review → **Ready to share** (creates the draft
//! Review, [`crate::store::Store::create_review_draft`]) → **compose the
//! storyline** (the curation ops here edit the draft's steps; no commits, so the
//! pre-PR history stays clean) → Publish (milestone D serializes the draft into
//! `.stage/<branch>/`, see [`crate::review_folder`]).
//!
//! The draft and its steps live entirely in the local SQLite store — they are
//! **single-writer / single-machine** (ADR-0022 §2): only the author edits them,
//! and there is no second writer to coordinate with before Publish. (Post-publish
//! single-writer is enforced by git push permissions, milestone D.) Composing a
//! storyline therefore requires the Ready-to-share draft to exist; the store ops
//! fail loud otherwise rather than inventing a draft.
//!
//! This module owns the storyline *domain* (the [`StorylineStep`] DTO), the
//! author-side **preview** assembly ([`assemble_preview`], [`preview`]) and the
//! anchor-validation that ties a step to a real file in the diff. The CRUD on the
//! draft steps lives in [`crate::store`]; the committed `.stage` serialization is
//! milestone D. Per ADR-0022 §7 all derived state (stale anchors, the overlay
//! residue) is computed here so the webview only renders.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::diff::{committed_diff, CommittedDiff};
use crate::error::StageError;
use crate::repo_key::RepoKey;
use crate::store::Store;

/// One step of a draft storyline (SL-1 #65 / SL-2 #66): an author-written intro
/// (markdown) plus an optional human-readable title, anchored to a single file
/// in the change's committed diff.
///
/// `id` is **store-minted** and stable across reorder/edit — the curation ops
/// address a step by id, so it must survive a reorder (unlike `order`). `order`
/// is the ascending presentation index; it is serialized into the zero-padded
/// `NNN_` filename prefix only at Publish (milestone D), never before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StorylineStep {
    /// Store-minted stable id (`st_<hex>`). Returned by add/list; passed back to
    /// edit/remove/reorder.
    pub id: String,
    /// Repo-relative path of the file this step walks through. Validated to be a
    /// file present in the committed diff at compose time ([`add_step`]).
    pub anchor: String,
    /// Optional step heading, distinct from the `anchor` path and the `intro`.
    #[serde(default)]
    pub title: Option<String>,
    /// The step intro — author-written markdown explaining this part of the change.
    pub intro: String,
    /// Presentation order, ascending. Reassigned by [`Store::reorder_storyline_steps`].
    pub order: u32,
    // `i64` epoch seconds cross the JSON IPC boundary as a JS `number`, so the
    // generated TS must say `number` (ts-rs defaults 64-bit ints to `bigint`) —
    // matching the convention in [`crate::domain`].
    /// First-written time, epoch seconds.
    #[ts(type = "number")]
    pub created_at: i64,
    /// Last-written time, epoch seconds.
    #[ts(type = "number")]
    pub updated_at: i64,
}

/// A [`StorylineStep`] paired with its place in the author's local preview. The
/// step's anchored-file diff lives in [`StorylinePreview::diff`] (looked up by
/// `step.anchor`); `stale` is set when that anchor is **no longer** a file in the
/// diff — the file dropped out of the change since the step was written, so the
/// guided sequence shows the step but flags that its target is gone (fail-loud,
/// never a silent empty diff). Mirrors the **Stale step** pattern (ADR-0012).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StorylineStepView {
    /// The draft step. Nested (not flattened) so the webview reads `step` + the
    /// computed `stale` flag as distinct fields.
    pub step: StorylineStep,
    /// True when `step.anchor` is absent from [`StorylinePreview::diff`].
    pub stale: bool,
}

/// The author-side **local storyline preview** (SL-4 #68 author side + GAP-4
/// #94). Carries the *full* tree-to-tree diff — every changed file — so the
/// storyline is a **guided overlay, not a filter**: files no step anchors stay
/// reachable. `unstoried` lists exactly those un-anchored diff paths, computed in
/// Rust so the webview only renders (ADR-0022 §7).
// Output-only DTO; `CommittedDiff` derives only `Serialize`/`TS`, so this can't
// derive `Debug`/`Clone`/`PartialEq` without propagating those to the diff type.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StorylinePreview {
    /// The full committed diff (`merge_base(base, head) → head`) — what the PR
    /// will contain, and the overlay base every step/file is rendered from.
    pub diff: CommittedDiff,
    /// The storyline: steps in author order, each with a computed `stale` flag.
    pub steps: Vec<StorylineStepView>,
    /// Repo-relative paths present in `diff.files` that **no** step anchors — the
    /// changes outside the guided storyline, still browsable (GAP-4).
    pub unstoried: Vec<String>,
}

/// Assemble the author preview from the full committed `diff` and the draft
/// `steps`. Pure (no git, no store): flags each step `stale` when its anchor is
/// no longer in the diff, and computes `unstoried` as the diff files no step
/// anchors — preserving diff order. Steps are emitted in ascending `order`.
///
/// A stale step anchors a file absent from the diff, so it never removes a diff
/// file from `unstoried`; the overlay residue is exactly the un-anchored changes.
pub fn assemble_preview(diff: CommittedDiff, mut steps: Vec<StorylineStep>) -> StorylinePreview {
    steps.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));

    let diff_paths: HashSet<&str> = diff.files.iter().map(|f| f.path.as_str()).collect();
    let anchored: HashSet<&str> = steps.iter().map(|s| s.anchor.as_str()).collect();

    let unstoried: Vec<String> = diff
        .files
        .iter()
        .filter(|f| !anchored.contains(f.path.as_str()))
        .map(|f| f.path.clone())
        .collect();

    let steps = steps
        .into_iter()
        .map(|step| {
            let stale = !diff_paths.contains(step.anchor.as_str());
            StorylineStepView { step, stale }
        })
        .collect();

    StorylinePreview {
        diff,
        steps,
        unstoried,
    }
}

/// The set of repo-relative paths in the committed tree-to-tree diff
/// (`merge_base(base_ref, head_ref) → head_ref`) — the files a storyline step is
/// allowed to anchor. Reuses [`committed_diff`] so the membership matches exactly
/// what the preview and the eventual PR show.
pub fn committed_diff_file_set(
    repo_root: &Path,
    base_ref: &str,
    head_ref: &str,
) -> Result<HashSet<String>, StageError> {
    let diff = committed_diff(repo_root, base_ref, head_ref)?;
    Ok(diff.files.into_iter().map(|f| f.path).collect())
}

/// Compose a step (SL-1/SL-2): append a step anchored to `anchor` with `intro`
/// and an optional `title` to the draft storyline for `key`.
///
/// Fails loud (CLAUDE.md) when:
/// - there is no Ready-to-share draft for `key` (composing requires it — the
///   single-writer draft is the only place a pre-publish storyline lives), or
/// - `anchor` is not a file in the committed diff (a step must point at a real
///   part of the change the author is shown), or
/// - a step already anchors `anchor` (v1 is one step per file).
///
/// The draft's own `base_ref`/`head_ref` drive the diff — the caller does not
/// pass refs, so a step can never be validated against a different base than the
/// one the storyline is composed over.
pub fn add_step(
    store: &Store,
    repo_root: &Path,
    key: &RepoKey,
    anchor: &str,
    title: Option<&str>,
    intro: &str,
) -> Result<StorylineStep, StageError> {
    let draft = store.get_review_draft(key)?.ok_or_else(|| {
        StageError::Invalid(format!(
            "no storyline draft for branch '{}' — mark the change Ready to share first",
            key.branch
        ))
    })?;

    let present = committed_diff_file_set(repo_root, &draft.base_ref, &draft.head_ref)?;
    if !present.contains(anchor) {
        tracing::error!(
            anchor = %anchor,
            base_ref = %draft.base_ref,
            head_ref = %draft.head_ref,
            "storyline_anchor_not_in_diff"
        );
        return Err(StageError::Invalid(format!(
            "can't anchor a step to '{anchor}': it isn't in the committed diff of '{}' against '{}'",
            draft.head_ref, draft.base_ref
        )));
    }

    store.add_storyline_step(key, anchor, title, intro)
}

/// Build the author preview (SL-4 + GAP-4) for `key`'s draft storyline: list the
/// draft steps, compute the full committed diff against the draft's base, and
/// assemble the overlay. Fails loud if there is no Ready-to-share draft.
pub fn preview(
    store: &Store,
    repo_root: &Path,
    key: &RepoKey,
) -> Result<StorylinePreview, StageError> {
    let draft = store.get_review_draft(key)?.ok_or_else(|| {
        StageError::Invalid(format!(
            "no storyline draft for branch '{}' — mark the change Ready to share first",
            key.branch
        ))
    })?;
    let diff = committed_diff(repo_root, &draft.base_ref, &draft.head_ref)?;
    let steps = store.list_storyline_steps(key)?;
    Ok(assemble_preview(diff, steps))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::{FileChange, FileStatus, SelfReviewStats};

    fn file(path: &str) -> FileChange {
        FileChange {
            path: path.into(),
            old_path: None,
            status: FileStatus::Modified,
            additions: 1,
            deletions: 0,
            patch: format!("@@ -1 +1 @@\n+{path}\n"),
            is_binary: false,
            is_truncated: false,
        }
    }

    fn diff_of(paths: &[&str]) -> CommittedDiff {
        let files: Vec<FileChange> = paths.iter().map(|p| file(p)).collect();
        CommittedDiff {
            base_ref: "origin/main".into(),
            head_ref: "feat/x".into(),
            head_sha: "abcd1234".into(),
            files,
            stats: SelfReviewStats {
                added: paths.len(),
                removed: 0,
                files_changed: paths.len(),
            },
        }
    }

    fn step(id: &str, anchor: &str, order: u32) -> StorylineStep {
        StorylineStep {
            id: id.into(),
            anchor: anchor.into(),
            title: None,
            intro: format!("intro for {anchor}"),
            order,
            created_at: 100,
            updated_at: 100,
        }
    }

    #[test]
    fn overlay_keeps_unstoried_files_reachable_and_orders_steps() {
        // Diff touches three files; the storyline only covers two of them.
        let diff = diff_of(&["a.rs", "b.rs", "c.rs"]);
        // Deliberately out of order — assemble must sort by `order`.
        let steps = vec![step("st_2", "c.rs", 20), step("st_1", "a.rs", 10)];

        let preview = assemble_preview(diff, steps);

        // Steps come back in author order.
        assert_eq!(
            preview
                .steps
                .iter()
                .map(|s| s.step.anchor.as_str())
                .collect::<Vec<_>>(),
            vec!["a.rs", "c.rs"],
        );
        // No step is stale — both anchors are in the diff.
        assert!(preview.steps.iter().all(|s| !s.stale));
        // GAP-4: the un-anchored file is still reachable in the overlay residue.
        assert_eq!(preview.unstoried, vec!["b.rs"]);
        // The full diff is preserved — the storyline is an overlay, not a filter.
        assert_eq!(preview.diff.files.len(), 3);
    }

    #[test]
    fn empty_storyline_leaves_every_file_unstoried() {
        let diff = diff_of(&["a.rs", "b.rs"]);
        let preview = assemble_preview(diff, vec![]);
        assert!(preview.steps.is_empty());
        // With no steps the whole diff is browsable — nothing is hidden.
        assert_eq!(preview.unstoried, vec!["a.rs", "b.rs"]);
    }

    #[test]
    fn step_anchoring_a_dropped_file_is_flagged_stale_not_hidden() {
        // The step anchors `gone.rs`, which is no longer in the diff.
        let diff = diff_of(&["a.rs"]);
        let steps = vec![step("st_1", "gone.rs", 10), step("st_2", "a.rs", 20)];

        let preview = assemble_preview(diff, steps);

        let gone = preview
            .steps
            .iter()
            .find(|s| s.step.anchor == "gone.rs")
            .unwrap();
        assert!(
            gone.stale,
            "a step anchoring a dropped file must be flagged stale"
        );
        let live = preview
            .steps
            .iter()
            .find(|s| s.step.anchor == "a.rs")
            .unwrap();
        assert!(!live.stale);
        // A stale step doesn't consume a diff file: `a.rs` is anchored, so the
        // only diff file is storied and nothing is left unstoried.
        assert!(preview.unstoried.is_empty());
    }

    // --- Integration: add_step + preview against a real repo + store --------

    use git2::{IndexAddOption, Repository, Signature};

    use crate::store::Store;

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

    /// A repo on branch `feat` with `a.rs` and `b.rs` committed since `main`, plus
    /// a store carrying a Ready-to-share draft for `feat` (base `main`). Returns
    /// the repo root, the store, and the key.
    fn repo_with_draft() -> (tempfile::TempDir, std::path::PathBuf, Store, RepoKey) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let repo = Repository::init(&root).unwrap();
        std::fs::write(root.join("base.txt"), "x\n").unwrap();
        let base = commit_all(&repo, "base", None);

        let base_commit = repo.find_commit(base).unwrap();
        repo.branch("feat", &base_commit, true).unwrap();
        repo.set_head("refs/heads/feat").unwrap();
        std::fs::write(root.join("a.rs"), "a\n").unwrap();
        std::fs::write(root.join("b.rs"), "b\n").unwrap();
        commit_all(&repo, "feat work", Some(base));

        let store = Store::open(&dir.path().join("store.sqlite3")).unwrap();
        let key = RepoKey {
            repo_owner: "local".into(),
            repo_name: "demo".into(),
            branch: "feat".into(),
        };
        // Base ref is the base commit SHA — git2 `init` doesn't create a `main`
        // branch, and `committed_diff` resolves the ref verbatim (no origin here).
        store
            .create_review_draft(&key, "Demo", &base.to_string())
            .unwrap();
        (dir, root, store, key)
    }

    #[test]
    fn add_step_rejects_an_anchor_not_in_the_committed_diff() {
        let (_dir, root, store, key) = repo_with_draft();

        // `a.rs` is in the committed diff → accepted.
        let step = add_step(&store, &root, &key, "a.rs", Some("A"), "did a").unwrap();
        assert_eq!(step.anchor, "a.rs");

        // `ghost.rs` is not in the diff → fail loud (a step must point at a real
        // part of the change).
        let err = add_step(&store, &root, &key, "ghost.rs", None, "x").unwrap_err();
        assert!(err.to_string().contains("ghost.rs"), "{err}");
        assert!(err.to_string().contains("committed diff"), "{err}");
    }

    #[test]
    fn preview_overlays_steps_on_the_full_diff() {
        let (_dir, root, store, key) = repo_with_draft();
        add_step(&store, &root, &key, "a.rs", None, "did a").unwrap();

        let pv = preview(&store, &root, &key).unwrap();
        // The full diff is present (overlay, not filter): both files are reachable.
        let mut paths: Vec<&str> = pv.diff.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, vec!["a.rs", "b.rs"]);
        // One step, anchored to a.rs, not stale.
        assert_eq!(pv.steps.len(), 1);
        assert_eq!(pv.steps[0].step.anchor, "a.rs");
        assert!(!pv.steps[0].stale);
        // b.rs is outside the storyline but still reachable.
        assert_eq!(pv.unstoried, vec!["b.rs"]);
    }

    #[test]
    fn preview_and_add_step_require_a_draft() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        Repository::init(&root).unwrap();
        let store = Store::open(&dir.path().join("store.sqlite3")).unwrap();
        let key = RepoKey {
            repo_owner: "local".into(),
            repo_name: "demo".into(),
            branch: "feat".into(),
        };
        // No Ready-to-share draft → both fail loud rather than inventing one.
        assert!(preview(&store, &root, &key).is_err());
        assert!(add_step(&store, &root, &key, "a.rs", None, "x").is_err());
    }
}
