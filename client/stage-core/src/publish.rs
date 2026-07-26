//! Publish — one author action that promotes a draft to a reviewable PR
//! (milestone D, PUB-1..7 / GAP-2 / GAP-5 / WS-4, ADR-0022 §1/§3/§5/§7).
//!
//! [`publish_review`] is the whole pipeline: serialize the per-machine draft
//! (the draft Review + its storyline steps, [`crate::store`]) into
//! `.stage/<branch>/` ([`crate::review_folder`]), make a **scoped** commit of
//! only that folder, `git push`, and open the PR with `gh pr create`. After the
//! first publish the committed `.stage` is **authoritative** (one-way promotion,
//! §3); the PR number is recorded back into `review.toml` and the draft so the
//! artifact is self-describing (it powers the reviewer-from-PR lookup, #93/#105).
//!
//! Lifecycle the one action absorbs (the PR is GitHub's, looked up live so
//! GitHub stays the source of truth, §5):
//!
//! - **first publish** — no PR for the branch yet → `gh pr create` (PUB-1) +
//!   exactly **one** auto-posted "open in Stage" comment (GAP-5);
//! - **re-publish** — an open PR already rides the branch → the push alone
//!   updates it (PUB-3); the title/body are revised to the request (PUB-7);
//! - **reopen** — a closed (un-merged) PR → `gh pr reopen`, reusing the material
//!   straight from `.stage/<branch>/` which outlived the PR (PUB-5 / WS-4).
//!
//! **Gated on a review-ready storyline (PUB-2):** ≥1 step and every step has an
//! intro — computed here ([`assess_publish_readiness`]) so the webview can show
//! the author what's missing *before* they publish (Rust computes, TS renders).
//! Two further gates guard the dogfooding failures behind PR #124:
//!
//! - **stale steps block** (ST-1 joins Ready to publish, CONTEXT.md): every step
//!   anchor is checked against the current committed diff; any stale step fails
//!   the publish with no override — a stale step narrates code the PR wouldn't
//!   contain.
//! - **uncommitted work needs an explicit disposition** (ADR-0024): a dirty
//!   working tree (staged / unstaged / untracked, `.stage/` excluded) fails loud
//!   unless the request carries the author's per-publish
//!   [`UncommittedDisposition`] — commit everything (Stage's one code commit,
//!   author-editable message) or publish without it.
//!
//! **Fail loud, no half-updated state (PUB-4, CLAUDE.md):** a failed push or PR
//! creation surfaces GitHub's own message verbatim (via [`crate::github`]'s
//! mapping) and leaves nothing half-recorded — the PR number is written to the
//! store and `review.toml` only **after** the PR is confirmed, and the scoped
//! commit is idempotent ([`stage_folder_has_changes`]) so a retry after a failed
//! push re-pushes rather than failing on an empty commit. The reviewer entry
//! path (`stage://` deep link) and dashboard surfacing are later milestones (F/G).

use std::path::Path;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::StageError;
use crate::github::GitHub;
use crate::repo_key::RepoKey;
use crate::review_folder::{
    commit_all_except_stage, scoped_commit, stage_folder_has_changes, write_review, ReviewMeta,
    ReviewStep, StageReview,
};
use crate::staleness::{assess_step_staleness, StaleReason, StepStaleness};
use crate::store::Store;
use crate::storyline::StorylineStep;

// ---------------------------------------------------------------------------
// Public DTOs (the ts-rs contract — Rust computes, TS renders)
// ---------------------------------------------------------------------------

/// Whether a draft is ready to publish, and — when not — exactly what the author
/// must fix (PUB-2 #73, ADR-0022 §7). The rule: **≥1 step and every step has a
/// non-empty intro.** Computed from the draft's storyline, never stored; the
/// webview renders `ready` plus the gaps below, and [`publish_review`] enforces
/// the same rule (a not-ready publish fails loud with the same detail).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PublishReadiness {
    /// `true` iff there is at least one step and no step is missing its intro.
    pub ready: bool,
    /// Number of steps in the draft storyline.
    pub step_count: u32,
    /// Ids of steps whose intro is empty/whitespace — the gaps to fill in. Empty
    /// when every step has an intro (or when there are no steps at all).
    pub steps_missing_intro: Vec<String>,
}

/// Coarse display state of one uncommitted path (ADR-0024), derived from git
/// status bits. `New` covers untracked files and index-added files alike.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum UncommittedState {
    New,
    Modified,
    Deleted,
}

/// One uncommitted working-tree change Publish would silently leave out of the
/// PR (ADR-0024). Computed, never stored; the modal lists these so the author
/// chooses a [`UncommittedDisposition`] with eyes open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UncommittedFile {
    /// Repo-relative path.
    pub path: String,
    pub state: UncommittedState,
}

/// The author's explicit, per-publish choice for uncommitted work (ADR-0024,
/// CONTEXT.md *Uncommitted work at Publish*). Never remembered across
/// publishes; absent + dirty tree fails loud in [`publish_review`].
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum UncommittedDisposition {
    /// Commit every uncommitted change (everything but `.stage/`) with
    /// `message`, then publish — the one place Stage authors a commit of the
    /// author's code, taken only on this explicit choice.
    CommitAll { message: String },
    /// Publish only the committed branch; the uncommitted work stays local.
    PublishWithout,
}

/// The author's publish request (PUB-7 #78 / GAP-2 #92). The PR title/body are
/// **distinct** from the Review title (WS-3) — the Review title lives in
/// `review.toml`; these drive `gh pr create`/`gh pr edit` and are revised on
/// every (re-)publish. `base_ref` optionally retargets the change's base branch
/// (GAP-2); reviewers/labels are passed through to `gh` best-effort.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PublishRequest {
    /// The PR title (markdown not allowed by GitHub in titles, but accepted as
    /// plain text). Required — a PR must have a title.
    pub pr_title: String,
    /// The PR body (markdown). May be empty.
    pub pr_body: String,
    /// Optional base-branch override (GAP-2). `None` keeps the draft's stored
    /// base (which already defaults to the remote default branch, milestone A/B).
    /// May be `origin/<name>`; the `origin/` prefix is stripped for `gh`.
    #[serde(default)]
    pub base_ref: Option<String>,
    /// Reviewers to request (GitHub logins), best-effort (PUB-7).
    #[serde(default)]
    pub reviewers: Vec<String>,
    /// Labels to apply, best-effort (PUB-7).
    #[serde(default)]
    pub labels: Vec<String>,
    /// The author's choice for uncommitted working-tree changes (ADR-0024).
    /// `None` with a dirty tree fails loud — the gate never defaults.
    #[serde(default)]
    pub uncommitted: Option<UncommittedDisposition>,
}

/// Which lifecycle transition a [`publish_review`] call performed, so the UI can
/// message it precisely (created a PR, pushed an update, or reopened).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PublishAction {
    /// A new PR was opened (first publish, or a fresh cycle after a merge).
    Created,
    /// An existing open PR was updated by the push (re-publish).
    Updated,
    /// A closed PR was reopened.
    Reopened,
}

/// The result of a publish (PUB-1). Carries the stable PR identity and what
/// happened. `commit` is the scoped `.stage` commit this call made, or `None`
/// when the folder was already committed (a no-op re-publish that only re-pushed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PublishOutcome {
    /// The GitHub PR number — stable across re-publish/reopen cycles (PUB-3).
    pub pr_number: u32,
    /// The PR's URL on github.com.
    pub url: String,
    /// What this publish did.
    pub action: PublishAction,
    /// The scoped `.stage` commit SHA this call created, if any.
    pub commit: Option<String>,
}

// ---------------------------------------------------------------------------
// Readiness gate (PUB-2) — pure, so the UI and the publish path share it
// ---------------------------------------------------------------------------

/// Compute publish readiness (PUB-2 #73) from a draft's storyline steps. Pure —
/// no git, no store, no network — so the webview can poll it cheaply while the
/// author composes and [`publish_review`] can enforce the very same rule.
pub fn assess_publish_readiness(steps: &[StorylineStep]) -> PublishReadiness {
    let steps_missing_intro: Vec<String> = steps
        .iter()
        .filter(|s| s.intro.trim().is_empty())
        .map(|s| s.id.clone())
        .collect();
    PublishReadiness {
        ready: !steps.is_empty() && steps_missing_intro.is_empty(),
        step_count: steps.len() as u32,
        steps_missing_intro,
    }
}

/// The user-facing sentence explaining why a not-ready draft can't publish
/// (PUB-2: "show the author what's missing"). Only called when `!ready`.
fn not_ready_message(readiness: &PublishReadiness) -> String {
    if readiness.step_count == 0 {
        return "This review has no storyline steps yet. Add at least one step \
                walking through the change before publishing."
            .to_string();
    }
    let n = readiness.steps_missing_intro.len();
    format!(
        "{n} storyline step{} {} missing an intro. Every step needs an intro \
         explaining that part of the change before you can publish.",
        if n == 1 { "" } else { "s" },
        if n == 1 { "is" } else { "are" },
    )
}

// ---------------------------------------------------------------------------
// Uncommitted work at Publish (ADR-0024) — detection + fail-loud messages
// ---------------------------------------------------------------------------

/// Every uncommitted working-tree change Publish must not silently leave
/// behind (ADR-0024): staged, unstaged-tracked, and untracked (non-ignored)
/// paths — **excluding `.stage/`**, which is Stage's own domain (written during
/// publish and committed by the scoped commit, never "the author's uncommitted
/// work"). Sorted by path. Pure detection; the UI renders it in the publish
/// modal and [`publish_review`] enforces it.
pub fn assess_uncommitted_work(repo_root: &Path) -> Result<Vec<UncommittedFile>, StageError> {
    let repo = git2::Repository::open(repo_root)?;
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut out = Vec::new();
    for entry in statuses.iter() {
        let Some(path) = entry.path() else {
            // Fail loud (CLAUDE.md): a path we can't read is a change we can't
            // show — never a silently shorter list.
            return Err(StageError::Invalid(format!(
                "uncommitted work: a changed path is not valid UTF-8: {:?}",
                String::from_utf8_lossy(entry.path_bytes())
            )));
        };
        if path == ".stage" || path.starts_with(".stage/") {
            continue;
        }
        let s = entry.status();
        if s.is_ignored() {
            continue;
        }
        let state = if s.is_wt_new() || s.is_index_new() {
            UncommittedState::New
        } else if s.is_wt_deleted() || s.is_index_deleted() {
            UncommittedState::Deleted
        } else {
            UncommittedState::Modified
        };
        out.push(UncommittedFile {
            path: path.to_string(),
            state,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// The user-facing sentence for a dirty-tree publish with no disposition —
/// the CLI-facing backstop (the app collects the choice in its modal first).
fn uncommitted_message(files: &[UncommittedFile]) -> String {
    let n = files.len();
    let shown: Vec<&str> = files.iter().take(10).map(|f| f.path.as_str()).collect();
    let more = if n > shown.len() {
        format!(" (+{} more)", n - shown.len())
    } else {
        String::new()
    };
    format!(
        "{n} uncommitted change{} would be left out of the pull request: {}{more}. \
         Commit your work first, or publish with an explicit choice to commit \
         everything or to publish without it.",
        if n == 1 { "" } else { "s" },
        shown.join(", "),
    )
}

/// Fail loud when any storyline step is stale against the committed diff of
/// `branch` vs `base_ref` (ST-1 joins the Ready-to-publish gate — CONTEXT.md:
/// a stale step narrates code the PR wouldn't contain, so it is never
/// publishable and there is no override). `after_commit` selects the message
/// for the re-check after a [`UncommittedDisposition::CommitAll`] commit moved
/// HEAD (the commit stays; only the publish aborts).
fn ensure_steps_fresh(
    repo_root: &Path,
    base_ref: &str,
    branch: &str,
    steps: &[StorylineStep],
    after_commit: bool,
) -> Result<(), StageError> {
    let anchors: Vec<String> = steps.iter().map(|s| s.anchor.clone()).collect();
    let stale: Vec<StepStaleness> = assess_step_staleness(repo_root, base_ref, branch, &anchors)?
        .into_iter()
        .filter(|s| s.stale)
        .collect();
    if stale.is_empty() {
        return Ok(());
    }
    let list = stale
        .iter()
        .map(|s| format!("'{}' ({})", s.anchor, stale_reason_label(s)))
        .collect::<Vec<_>>()
        .join(", ");
    let n = stale.len();
    let plural = if n == 1 { "" } else { "s" };
    tracing::error!(stale = %list, after_commit, "publish_blocked_stale_steps");
    let msg = if after_commit {
        format!(
            "The commit was made, but it changed the committed diff and left \
             {n} storyline step{plural} stale: {list}. Remove or re-anchor \
             the step{plural} in the storyline, then publish again."
        )
    } else {
        format!(
            "{n} storyline step{plural} {} stale against the committed diff of \
             '{branch}' vs '{base_ref}': {list}. Remove or re-anchor the \
             step{plural} before publishing.",
            if n == 1 { "is" } else { "are" },
        )
    };
    Err(StageError::Invalid(msg))
}

/// Human label for a stale step's reason, used in the publish gate's message.
fn stale_reason_label(s: &StepStaleness) -> String {
    match (s.reason, &s.renamed_to) {
        (Some(StaleReason::Removed), _) => "file removed".to_string(),
        (Some(StaleReason::Renamed), Some(to)) => format!("renamed to {to}"),
        (Some(StaleReason::Renamed), None) => "renamed".to_string(),
        (Some(StaleReason::NotInChangeSet), _) => "not part of the change".to_string(),
        (None, _) => "fresh".to_string(),
    }
}

// ---------------------------------------------------------------------------
// The publish pipeline (PUB-1, PUB-3, PUB-5, GAP-2, GAP-5, WS-4)
// ---------------------------------------------------------------------------

/// Publish (or re-publish / reopen) the draft Review for `key` as a GitHub PR.
///
/// Reads the draft + storyline from `store`, gates on review-readiness (PUB-2),
/// serializes into `.stage/<branch>/`, scoped-commits + pushes, then creates or
/// reaches the branch's PR via `github`. `repo_root` is the working tree (also
/// the `gh`/`git` cwd). Fails loud at the first error, leaving no half-recorded
/// state (PUB-4).
pub fn publish_review(
    store: &Store,
    github: &GitHub,
    repo_root: &Path,
    key: &RepoKey,
    req: &PublishRequest,
) -> Result<PublishOutcome, StageError> {
    let branch = key.branch.as_str();

    // 1. The draft must exist — publish promotes an existing Ready-to-share draft,
    //    it never invents one (matches `storyline::{add_step,preview}`).
    let draft = store.get_review_draft(key)?.ok_or_else(|| {
        StageError::Invalid(format!(
            "no review draft for branch '{branch}' — mark the change Ready to share \
             and compose a storyline before publishing."
        ))
    })?;

    // 2. Gate on a review-ready storyline (PUB-2). Fail loud with what's missing.
    let steps = store.list_storyline_steps(key)?;
    let readiness = assess_publish_readiness(&steps);
    if !readiness.ready {
        return Err(StageError::Invalid(not_ready_message(&readiness)));
    }

    // 3. Resolve the base ref (GAP-2). An explicit override is persisted to the
    //    draft so it sticks across re-publishes; otherwise keep the draft's base
    //    (already defaulted to the remote default branch upstream).
    let base_ref = match req.base_ref.as_deref().map(str::trim) {
        Some(b) if !b.is_empty() && b != draft.base_ref => {
            store.set_review_base_ref(key, b)?.base_ref
        }
        _ => draft.base_ref.clone(),
    };

    // 4. Stale-step gate (ST-1 joins Ready to publish, CONTEXT.md): a stale step
    //    narrates code the PR wouldn't contain — never publishable, no override.
    ensure_steps_fresh(repo_root, &base_ref, branch, &steps, false)?;

    // 5. Uncommitted-work gate (ADR-0024): never publish silently over a dirty
    //    tree. The author's explicit disposition rides the request; without one
    //    the publish fails loud (the app collects the choice in its modal, the
    //    CLI gets the message). The disposition is per-publish, never stored.
    let uncommitted = assess_uncommitted_work(repo_root)?;
    if !uncommitted.is_empty() {
        match &req.uncommitted {
            None => {
                tracing::error!(
                    count = uncommitted.len(),
                    "publish_blocked_uncommitted_work"
                );
                return Err(StageError::Invalid(uncommitted_message(&uncommitted)));
            }
            Some(UncommittedDisposition::PublishWithout) => {
                // The committed branch is the whole change; the listed paths
                // stay local. Proceed.
            }
            Some(UncommittedDisposition::CommitAll { message }) => {
                let message = message.trim();
                if message.is_empty() {
                    return Err(StageError::Invalid(
                        "A commit message is required to commit everything at publish.".to_string(),
                    ));
                }
                commit_all_except_stage(repo_root, message)?;
                // The commit moved HEAD, so the committed diff changed — re-run
                // the staleness gate against it (a committed revert can drop a
                // step's file out of the diff). The commit stays either way;
                // only the publish aborts, loud, with nothing half-published.
                ensure_steps_fresh(repo_root, &base_ref, branch, &steps, true)?;
            }
        }
    }

    // 6. Serialize the draft into `.stage/<branch>/`. `pr_number` carries the
    //    draft's current value (None on a first publish; reconciled in step 9).
    let mut review = StageReview {
        meta: ReviewMeta {
            title: draft.title.clone(),
            base_ref: base_ref.clone(),
            head_ref: branch.to_string(),
            pr_number: draft.pr_number,
        },
        steps: steps_to_review_steps(&steps),
    };
    write_review(repo_root, &review)?;

    // 7. Look up the branch's PR *before* mutating git, so we pick the action and
    //    the commit message up front (GitHub is the source of truth, §5).
    let existing = classify_branch_pr(github.prs_for_branch(repo_root, branch)?);
    let commit_message = match existing {
        BranchPrState::None => format!("stage: publish review for {branch}"),
        _ => format!("stage: update review for {branch}"),
    };

    // 8. Scoped commit — only if `.stage/<branch>/` actually changed. Skipping a
    //    clean folder keeps re-publish (and a retry after a failed push)
    //    idempotent instead of failing on an empty commit.
    let mut last_commit: Option<String> = None;
    if stage_folder_has_changes(repo_root, branch)? {
        last_commit = Some(scoped_commit(repo_root, branch, &commit_message)?);
    }

    // 9. Push the branch (PUB-1). Fails loud with git's stderr (auth, protected
    //    branch, no write access). Nothing past here ran, so no half state.
    github.git_push(repo_root, "origin", branch)?;

    // 10. Create / reach / reopen the PR.
    let base_branch = pr_base_branch(&base_ref);
    let (pr_number, url, action) = match existing {
        BranchPrState::None => {
            let created = github.create_pr(repo_root, base_branch, branch, req)?;
            (created.number, created.url, PublishAction::Created)
        }
        BranchPrState::Open(pr) => {
            // The push already updated the open PR; revise its title/body (PUB-7).
            github.edit_pr(repo_root, pr.number, &req.pr_title, &req.pr_body)?;
            (pr.number, pr.url, PublishAction::Updated)
        }
        BranchPrState::Closed(pr) => {
            github.reopen_pr(repo_root, pr.number)?;
            github.edit_pr(repo_root, pr.number, &req.pr_title, &req.pr_body)?;
            (pr.number, pr.url, PublishAction::Reopened)
        }
    };

    // 11. Record the PR number into `review.toml` and the draft — only now that the
    //    PR is confirmed (PUB-4: nothing half-recorded on an earlier failure). On
    //    a re-publish where the number is already present this is a no-op.
    if review.meta.pr_number != Some(pr_number) {
        review.meta.pr_number = Some(pr_number);
        write_review(repo_root, &review)?;
        if stage_folder_has_changes(repo_root, branch)? {
            last_commit = Some(scoped_commit(
                repo_root,
                branch,
                &format!("stage: record PR #{pr_number} for {branch}"),
            )?);
            github.git_push(repo_root, "origin", branch)?;
        }
    }
    store.set_review_pr_number(key, pr_number)?;

    // 12. On a first publish only, auto-post exactly one discovery comment
    //     (GAP-5). Re-publish/reopen never comment, so it stays exactly-once by
    //     construction (a PR now exists, so a later publish takes another branch).
    if action == PublishAction::Created {
        github.comment_on_pr(repo_root, pr_number, &open_in_stage_comment(&url))?;
    }

    Ok(PublishOutcome {
        pr_number,
        url,
        action,
        commit: last_commit,
    })
}

/// Map the draft's ordered storyline steps to committed-folder steps. The
/// presentation order becomes a zero-padded `NNN_` filename prefix; we space it
/// by tens (`010`, `020`, …) — matching the ADR-0022 §1 layout and leaving room
/// for a later manual insertion. The filename slug is derived from the step
/// title, else the anchored file's name; the `NNN_` prefix keeps duplicate slugs
/// from colliding.
fn steps_to_review_steps(steps: &[StorylineStep]) -> Vec<ReviewStep> {
    steps
        .iter()
        .enumerate()
        .map(|(i, s)| ReviewStep {
            order: (i as u32 + 1) * 10,
            slug: slug_for_step(s),
            anchor: s.anchor.clone(),
            title: s.title.clone(),
            intro: s.intro.clone(),
        })
        .collect()
}

/// The filename slug for a step: its title when set, else the basename of its
/// anchored file. Always non-empty (`"step"` fallback).
fn slug_for_step(step: &StorylineStep) -> String {
    let source = match step.title.as_deref() {
        Some(t) if !t.trim().is_empty() => t,
        _ => step.anchor.rsplit('/').next().unwrap_or(&step.anchor),
    };
    slugify(source)
}

/// Lowercase, ASCII-alphanumeric, dash-separated slug; runs of other characters
/// collapse to a single `-` and leading/trailing dashes are trimmed. Empty input
/// (or all-punctuation) yields `"step"` so a filename is always producible.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
            pending_dash = false;
        } else {
            pending_dash = true;
        }
    }
    if out.is_empty() {
        "step".to_string()
    } else {
        out
    }
}

/// The `gh pr create --base` value for a stored `base_ref`. The PR base is a
/// branch on the remote, so a remote-tracking `origin/<name>` is reduced to
/// `<name>` (the comparison still prefers `origin/<name>`, but GitHub names the
/// branch).
fn pr_base_branch(base_ref: &str) -> &str {
    base_ref.strip_prefix("origin/").unwrap_or(base_ref)
}

/// The single auto-posted discovery comment (GAP-5 / ADR-0022 §6). Carries the
/// copy-paste `stage open <pr-url>` command — the guaranteed reviewer-entry path
/// (the https one-click link + `stage://` handler is deferred to milestone F).
fn open_in_stage_comment(pr_url: &str) -> String {
    format!(
        "This pull request has a **Stage** review attached — a guided, \
         step-by-step walkthrough of the change.\n\n\
         To open it locally in Stage, run:\n\n```\nstage open {pr_url}\n```\n"
    )
}

/// The branch's PR as it bears on a (re-)publish. A merged PR is **not** carried
/// here: it can't be reopened and the branch starts a fresh cycle, so it folds
/// into [`BranchPrState::None`] (create a new PR — WS-4 reuse across cycles).
enum BranchPrState {
    /// No open or closed (un-merged) PR — first publish / new cycle.
    None,
    /// An open PR rides the branch — re-publish reaches it.
    Open(BranchPr),
    /// A closed (un-merged) PR — reopen it.
    Closed(BranchPr),
}

/// Pick the PR a (re-)publish should act on from gh's `pr list` for the branch:
/// an open PR wins, else a closed (un-merged) one to reopen, else none (no PR, or
/// only merged PRs — both mean "open a new one").
fn classify_branch_pr(prs: Vec<BranchPr>) -> BranchPrState {
    if let Some(pr) = prs.iter().find(|p| p.state == "OPEN") {
        return BranchPrState::Open(pr.clone());
    }
    if let Some(pr) = prs.iter().find(|p| p.state == "CLOSED") {
        return BranchPrState::Closed(pr.clone());
    }
    BranchPrState::None
}

// ---------------------------------------------------------------------------
// The publish-specific `gh` commands (built on the runners in `github.rs`,
// mirroring how `pr.rs` adds its typed feature commands)
// ---------------------------------------------------------------------------

/// A created pull request: the parsed number + URL from `gh pr create`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedPr {
    pub number: u32,
    pub url: String,
}

/// One PR returned by `gh pr list --head <branch>`: only the fields the publish
/// path branches on. gh's other fields are ignored.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct BranchPr {
    number: u32,
    /// gh's uppercase state: `"OPEN"`, `"CLOSED"`, or `"MERGED"`.
    state: String,
    url: String,
}

impl GitHub {
    /// PRs whose **head** is `branch`, across all states (`gh pr list --head …
    /// --state all`). Empty when the branch has never had a PR — the first-publish
    /// signal. Fail loud through the JSON runner (a missing/unauthenticated `gh`,
    /// a non-zero exit, or unparseable JSON surface their real cause).
    fn prs_for_branch(&self, repo_dir: &Path, branch: &str) -> Result<Vec<BranchPr>, StageError> {
        self.run_gh_json(
            &[
                "pr",
                "list",
                "--head",
                branch,
                "--state",
                "all",
                "--json",
                "number,state,url",
            ],
            Some(repo_dir),
        )
    }

    /// Open a PR for `head` against `base` from a [`PublishRequest`] (PUB-1/PUB-7).
    /// The request's reviewers and labels are passed through best-effort. Returns
    /// the parsed number + URL from gh's stdout. Fail loud: gh's own message (a
    /// protected base, a missing reviewer, "no commits between …") surfaces
    /// verbatim.
    fn create_pr(
        &self,
        repo_dir: &Path,
        base: &str,
        head: &str,
        req: &PublishRequest,
    ) -> Result<CreatedPr, StageError> {
        let mut args: Vec<String> = vec![
            "pr".into(),
            "create".into(),
            "--base".into(),
            base.into(),
            "--head".into(),
            head.into(),
            "--title".into(),
            req.pr_title.clone(),
            "--body".into(),
            req.pr_body.clone(),
        ];
        for reviewer in &req.reviewers {
            args.push("--reviewer".into());
            args.push(reviewer.clone());
        }
        for label in &req.labels {
            args.push("--label".into());
            args.push(label.clone());
        }
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let stdout = self.run_gh(&argv, Some(repo_dir))?;
        let url = pr_url_from_create_output(&stdout).ok_or_else(|| {
            tracing::error!(stdout = %stdout, "gh_pr_create_no_url");
            StageError::GhFailed(format!(
                "`gh pr create` succeeded but returned no PR URL to parse. Output was: {}",
                stdout.trim()
            ))
        })?;
        let number = pr_number_from_url(&url).ok_or_else(|| {
            tracing::error!(url = %url, "gh_pr_create_unparsable_url");
            StageError::GhFailed(format!("Couldn't read a PR number from the PR URL: {url}"))
        })?;
        Ok(CreatedPr { number, url })
    }

    /// Revise an open PR's title and body (PUB-7, re-publish). `gh pr edit`.
    fn edit_pr(&self, repo_dir: &Path, pr: u32, title: &str, body: &str) -> Result<(), StageError> {
        let pr_s = pr.to_string();
        self.run_gh(
            &["pr", "edit", &pr_s, "--title", title, "--body", body],
            Some(repo_dir),
        )?;
        Ok(())
    }

    /// Reopen a closed PR (PUB-5). `gh pr reopen`. A merged PR can't be reopened —
    /// gh's refusal surfaces verbatim (we never route a merged PR here).
    fn reopen_pr(&self, repo_dir: &Path, pr: u32) -> Result<(), StageError> {
        let pr_s = pr.to_string();
        self.run_gh(&["pr", "reopen", &pr_s], Some(repo_dir))?;
        Ok(())
    }

    /// Post a top-level comment on a PR (GAP-5 auto-comment). `gh pr comment`.
    fn comment_on_pr(&self, repo_dir: &Path, pr: u32, body: &str) -> Result<(), StageError> {
        let pr_s = pr.to_string();
        self.run_gh(&["pr", "comment", &pr_s, "--body", body], Some(repo_dir))?;
        Ok(())
    }
}

/// The PR URL from `gh pr create`'s stdout — the last whitespace-delimited token
/// containing `/pull/` (gh prints the URL on its own line; this tolerates any
/// leading status lines).
fn pr_url_from_create_output(stdout: &str) -> Option<String> {
    stdout
        .split_whitespace()
        .rev()
        .find(|tok| tok.contains("/pull/"))
        .map(str::to_string)
}

/// The trailing PR number from a `…/pull/<n>` URL.
fn pr_number_from_url(url: &str) -> Option<u32> {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|s| s.parse().ok())
}

// The tests drive every `gh` command against a fake `gh` (a bash dispatcher) and
// real `git` against a scratch repo with a bare "remote", so they run fully
// offline. bash is unix-only; CI/dev are macOS/Linux (mirrors `github.rs`/`pr.rs`).
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::process::Command;

    use crate::review_folder::{read_review_at, review_dir};

    fn key(branch: &str) -> RepoKey {
        RepoKey {
            repo_owner: "octo".into(),
            repo_name: "stage".into(),
            branch: branch.into(),
        }
    }

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

    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    /// A work repo on branch `feat/x` whose `origin` is a bare repo alongside it
    /// (so `git push` works with no network). One commit on `main` (pushed, so
    /// `origin/main` resolves for the staleness gate), then a committed branch
    /// change adding `src/domain.rs` + `src/store.rs` — the files the test
    /// storylines anchor. The tree is clean. Returns the work-repo root.
    fn repo_with_bare_remote(base: &Path) -> PathBuf {
        let remote = base.join("remote.git");
        git(base, &["init", "-q", "--bare", remote.to_str().unwrap()]);

        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        git(&work, &["init", "-q", "-b", "main"]);
        git(&work, &["config", "user.email", "t@e.com"]);
        git(&work, &["config", "user.name", "t"]);
        std::fs::write(work.join("README.md"), "hi\n").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "-q", "-m", "init"]);
        git(
            &work,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        // Push main so origin/main exists locally (the staleness gate resolves
        // the draft's `origin/main` base against it).
        git(&work, &["push", "-q", "origin", "main"]);
        git(&work, &["checkout", "-q", "-b", "feat/x"]);
        std::fs::create_dir_all(work.join("src")).unwrap();
        std::fs::write(work.join("src/domain.rs"), "fn domain() {}\n").unwrap();
        std::fs::write(work.join("src/store.rs"), "fn store() {}\n").unwrap();
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-q", "-m", "branch work"]);
        work
    }

    /// A fake `gh` whose `pr list` answer is driven by the `pr_state` file the
    /// test writes (`none` → `[]`, else `open`/`closed`/`merged` → one PR with
    /// that uppercase state and the number in `pr_number`, default 7). `pr create`
    /// echoes a fixed URL (PR #7); reopen/edit/comment succeed and record their
    /// argv to `calls`. The stdin of a comment is irrelevant (body is an arg).
    fn fake_gh(rec: &Path) -> PathBuf {
        std::fs::write(rec.join("pr_state"), "none").unwrap();
        std::fs::write(rec.join("pr_number"), "7").unwrap();
        let rec_s = rec.to_str().unwrap();
        let body = format!(
            r#"#!/usr/bin/env bash
set -euo pipefail
REC="{rec_s}"
args="$*"
if [ "${{1:-}}" = auth ] && [ "${{2:-}}" = status ]; then exit 0; fi
echo "$args" >> "$REC/calls"
if [ "${{1:-}}" = pr ]; then
  case "${{2:-}}" in
    list)
      state="$(cat "$REC/pr_state")"
      num="$(cat "$REC/pr_number")"
      if [ "$state" = none ]; then echo '[]'; exit 0; fi
      up="$(echo "$state" | tr '[:lower:]' '[:upper:]')"
      printf '[{{"number":%s,"state":"%s","url":"https://github.com/o/r/pull/%s"}}]\n' "$num" "$up" "$num"
      exit 0
      ;;
    create)
      echo "https://github.com/o/r/pull/7"
      exit 0
      ;;
    reopen|edit|comment)
      echo ok
      exit 0
      ;;
  esac
fi
echo "fake gh: unhandled: $args" >&2
exit 1
"#
        );
        write_script(rec, "gh", &body)
    }

    fn calls(rec: &Path) -> String {
        std::fs::read_to_string(rec.join("calls")).unwrap_or_default()
    }

    fn set_pr(rec: &Path, state: &str, number: u32) {
        std::fs::write(rec.join("pr_state"), state).unwrap();
        std::fs::write(rec.join("pr_number"), number.to_string()).unwrap();
    }

    /// A store with a Ready-to-share draft on `feat/x` plus one storyline step
    /// (with an intro), so the readiness gate passes.
    fn ready_store(dir: &Path) -> Store {
        let store = Store::open(&dir.join("store.sqlite3")).unwrap();
        let k = key("feat/x");
        store
            .create_review_draft(&k, "Rename Workspace to Review", "origin/main")
            .unwrap();
        store
            .add_storyline_step(&k, "src/domain.rs", Some("Rename the type"), "Renamed it.")
            .unwrap();
        store
    }

    fn request() -> PublishRequest {
        PublishRequest {
            pr_title: "Rename Workspace → Review".into(),
            pr_body: "The big rename.".into(),
            base_ref: None,
            reviewers: vec![],
            labels: vec![],
            uncommitted: None,
        }
    }

    // ---- PUB-2: the readiness gate ----------------------------------------

    fn step(id: &str, intro: &str) -> StorylineStep {
        StorylineStep {
            id: id.into(),
            anchor: "a.rs".into(),
            title: None,
            intro: intro.into(),
            order: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn readiness_requires_a_step_and_every_intro() {
        // No steps → not ready.
        let r = assess_publish_readiness(&[]);
        assert!(!r.ready);
        assert_eq!(r.step_count, 0);
        assert!(r.steps_missing_intro.is_empty());

        // A step missing its intro → not ready, and it's named.
        let r = assess_publish_readiness(&[step("st_1", "ok"), step("st_2", "   ")]);
        assert!(!r.ready);
        assert_eq!(r.step_count, 2);
        assert_eq!(r.steps_missing_intro, vec!["st_2"]);

        // Every step has an intro → ready.
        let r = assess_publish_readiness(&[step("st_1", "a"), step("st_2", "b")]);
        assert!(r.ready);
        assert!(r.steps_missing_intro.is_empty());
    }

    #[test]
    fn publish_is_blocked_until_review_ready() {
        let tmp = tempfile::tempdir().unwrap();
        let root = repo_with_bare_remote(tmp.path());
        let rec = tmp.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let gh = GitHub::with_bins(fake_gh(&rec), "git");
        let k = key("feat/x");

        let store = Store::open(&tmp.path().join("store.sqlite3")).unwrap();

        // No draft at all → fail loud.
        let err = publish_review(&store, &gh, &root, &k, &request()).unwrap_err();
        assert!(err.to_string().contains("Ready to share"), "{err}");

        // Draft but no steps → blocked.
        store
            .create_review_draft(&k, "Title", "origin/main")
            .unwrap();
        let err = publish_review(&store, &gh, &root, &k, &request()).unwrap_err();
        assert!(err.to_string().contains("no storyline steps"), "{err}");

        // A step with a blank intro → blocked.
        store
            .add_storyline_step(&k, "src/a.rs", None, "   ")
            .unwrap();
        let err = publish_review(&store, &gh, &root, &k, &request()).unwrap_err();
        assert!(err.to_string().contains("missing an intro"), "{err}");

        // Nothing reached gh, and nothing was committed/pushed.
        assert!(!rec.join("calls").exists(), "gate must precede any gh call");
        assert!(
            !review_dir(&root, "feat/x").unwrap().exists()
                || read_review_at(&review_dir(&root, "feat/x").unwrap()).is_err()
        );
    }

    // ---- PUB-1 / GAP-5: first publish — commit, push, create, one comment --

    #[test]
    fn first_publish_commits_scoped_pushes_creates_and_comments_once() {
        let tmp = tempfile::tempdir().unwrap();
        let root = repo_with_bare_remote(tmp.path());
        let rec = tmp.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let gh = GitHub::with_bins(fake_gh(&rec), "git");
        let store = ready_store(tmp.path());
        let k = key("feat/x");

        // The user has an unrelated staged code change in flight — with the
        // explicit publish-without disposition (ADR-0024) it must survive
        // untouched and must NOT be swept into the scoped commit.
        std::fs::write(root.join("README.md"), "EDITED BY USER\n").unwrap();
        git(&root, &["add", "README.md"]);

        let mut req = request();
        req.uncommitted = Some(UncommittedDisposition::PublishWithout);
        let out = publish_review(&store, &gh, &root, &k, &req).unwrap();
        assert_eq!(out.action, PublishAction::Created);
        assert_eq!(out.pr_number, 7);
        assert_eq!(out.url, "https://github.com/o/r/pull/7");
        assert!(out.commit.is_some());

        // `.stage/feat-x/` is written, with the step file and the recorded PR.
        let dir = review_dir(&root, "feat/x").unwrap();
        let review = read_review_at(&dir).unwrap();
        assert_eq!(review.meta.pr_number, Some(7));
        assert_eq!(review.meta.base_ref, "origin/main");
        assert_eq!(review.steps.len(), 1);
        assert!(dir.join("steps/010_rename-the-type.md").is_file());

        // The PR number is mirrored onto the draft.
        assert_eq!(
            store.get_review_draft(&k).unwrap().unwrap().pr_number,
            Some(7)
        );

        // The scoped commit touched only `.stage/…`; the user's staged README is
        // intact and still staged.
        let head_files = git_show_names(&root);
        assert!(
            head_files.iter().any(|f| f.starts_with(".stage/")),
            "{head_files:?}"
        );
        assert!(
            !head_files.iter().any(|f| f == "README.md"),
            "{head_files:?}"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("README.md")).unwrap(),
            "EDITED BY USER\n"
        );

        // gh: a create and exactly one comment; the base had `origin/` stripped.
        let log = calls(&rec);
        assert_eq!(log.matches("pr create").count(), 1, "{log}");
        assert!(
            log.contains("--base main"),
            "base stripped to a branch: {log}"
        );
        assert_eq!(
            log.matches("pr comment").count(),
            1,
            "exactly one comment: {log}"
        );
        assert!(
            log.contains("stage open https://github.com/o/r/pull/7"),
            "{log}"
        );
    }

    // ---- PUB-3: re-publish reaches the same PR, no new PR, no new comment --

    #[test]
    fn republish_updates_same_pr_without_new_pr_or_comment() {
        let tmp = tempfile::tempdir().unwrap();
        let root = repo_with_bare_remote(tmp.path());
        let rec = tmp.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let gh = GitHub::with_bins(fake_gh(&rec), "git");
        let store = ready_store(tmp.path());
        let k = key("feat/x");

        publish_review(&store, &gh, &root, &k, &request()).unwrap();

        // The branch now has an open PR (#7). Edit the storyline and re-publish.
        set_pr(&rec, "open", 7);
        std::fs::remove_file(rec.join("calls")).unwrap();
        store
            .add_storyline_step(&k, "src/store.rs", None, "Added the draft table.")
            .unwrap();

        let out = publish_review(&store, &gh, &root, &k, &request()).unwrap();
        assert_eq!(out.action, PublishAction::Updated);
        assert_eq!(out.pr_number, 7);
        assert_eq!(out.url, "https://github.com/o/r/pull/7");

        // The edited storyline reached `.stage` (two steps now).
        let dir = review_dir(&root, "feat/x").unwrap();
        assert_eq!(read_review_at(&dir).unwrap().steps.len(), 2);

        // No second PR, no second comment; an edit was issued instead.
        let log = calls(&rec);
        assert_eq!(log.matches("pr create").count(), 0, "no new PR: {log}");
        assert_eq!(
            log.matches("pr comment").count(),
            0,
            "no new comment: {log}"
        );
        assert!(log.contains("pr edit 7"), "title/body revised: {log}");
    }

    #[test]
    fn noop_republish_repushes_without_a_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let root = repo_with_bare_remote(tmp.path());
        let rec = tmp.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let gh = GitHub::with_bins(fake_gh(&rec), "git");
        let store = ready_store(tmp.path());
        let k = key("feat/x");

        publish_review(&store, &gh, &root, &k, &request()).unwrap();
        set_pr(&rec, "open", 7);

        // Re-publish with no storyline change → nothing to commit, still succeeds.
        let out = publish_review(&store, &gh, &root, &k, &request()).unwrap();
        assert_eq!(out.action, PublishAction::Updated);
        assert_eq!(out.commit, None, "a clean .stage makes no new commit");
    }

    // ---- PUB-5: reopen a closed PR ----------------------------------------

    #[test]
    fn reopen_closed_pr_reuses_material() {
        let tmp = tempfile::tempdir().unwrap();
        let root = repo_with_bare_remote(tmp.path());
        let rec = tmp.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let gh = GitHub::with_bins(fake_gh(&rec), "git");
        let store = ready_store(tmp.path());
        let k = key("feat/x");

        publish_review(&store, &gh, &root, &k, &request()).unwrap();

        // The PR is now closed on GitHub; publishing reopens it.
        set_pr(&rec, "closed", 7);
        std::fs::remove_file(rec.join("calls")).unwrap();

        let out = publish_review(&store, &gh, &root, &k, &request()).unwrap();
        assert_eq!(out.action, PublishAction::Reopened);
        assert_eq!(out.pr_number, 7);

        let log = calls(&rec);
        assert!(log.contains("pr reopen 7"), "{log}");
        assert_eq!(
            log.matches("pr create").count(),
            0,
            "reopen, not create: {log}"
        );
        assert_eq!(
            log.matches("pr comment").count(),
            0,
            "no comment on reopen: {log}"
        );
    }

    // ---- GAP-2: base override persists and strips origin/ ------------------

    #[test]
    fn base_ref_override_persists_and_strips_origin_for_gh() {
        let tmp = tempfile::tempdir().unwrap();
        let root = repo_with_bare_remote(tmp.path());
        let rec = tmp.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let gh = GitHub::with_bins(fake_gh(&rec), "git");
        let store = ready_store(tmp.path());
        let k = key("feat/x");

        // The develop branch must exist on the remote for the staleness gate to
        // resolve the overridden base.
        git(&root, &["branch", "develop", "main"]);
        git(&root, &["push", "-q", "origin", "develop"]);

        let mut req = request();
        req.base_ref = Some("origin/develop".into());
        publish_review(&store, &gh, &root, &k, &req).unwrap();

        // review.toml carries the full ref; the draft persisted the override.
        let dir = review_dir(&root, "feat/x").unwrap();
        assert_eq!(
            read_review_at(&dir).unwrap().meta.base_ref,
            "origin/develop"
        );
        assert_eq!(
            store.get_review_draft(&k).unwrap().unwrap().base_ref,
            "origin/develop"
        );
        // gh saw the branch name, not the remote-tracking ref.
        assert!(calls(&rec).contains("--base develop"), "{}", calls(&rec));
    }

    // ---- PUB-4: failures surface and leave no half-updated state ----------

    #[test]
    fn pr_create_failure_surfaces_verbatim_and_records_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = repo_with_bare_remote(tmp.path());
        let rec = tmp.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        // A fake gh that passes auth + pr list (none) but fails `pr create`.
        let body = r#"#!/usr/bin/env bash
if [ "$1" = auth ] && [ "$2" = status ]; then exit 0; fi
if [ "$1" = pr ] && [ "$2" = list ]; then echo '[]'; exit 0; fi
if [ "$1" = pr ] && [ "$2" = create ]; then
  echo 'GraphQL: No commits between main and feat/x (createPullRequest)' >&2
  exit 1
fi
echo "unhandled: $*" >&2; exit 1
"#;
        let gh = GitHub::with_bins(write_script(&rec, "gh", body), "git");
        let store = ready_store(tmp.path());
        let k = key("feat/x");

        let err = publish_review(&store, &gh, &root, &k, &request()).unwrap_err();
        match err {
            StageError::GhFailed(msg) => {
                assert_eq!(
                    msg,
                    "GraphQL: No commits between main and feat/x (createPullRequest)"
                )
            }
            other => panic!("expected GhFailed, got {other:?}"),
        }
        // No PR number was recorded on the draft (nothing half-updated).
        assert_eq!(store.get_review_draft(&k).unwrap().unwrap().pr_number, None);
    }

    #[test]
    fn push_failure_surfaces_and_records_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        // A normal repo (origin/main fetched, branch work committed) whose
        // `origin` URL is then broken → the gates pass but `git push` fails.
        let work = repo_with_bare_remote(tmp.path());
        git(
            &work,
            &["remote", "set-url", "origin", "/nonexistent/remote.git"],
        );

        let rec = tmp.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let gh = GitHub::with_bins(fake_gh(&rec), "git");
        let store = ready_store(tmp.path());
        let k = key("feat/x");

        let err = publish_review(&store, &gh, &work, &k, &request()).unwrap_err();
        assert!(matches!(err, StageError::GitCli(_)), "{err:?}");
        // The PR was never created (push precedes create) and nothing recorded.
        assert!(!calls(&rec).contains("pr create"), "{}", calls(&rec));
        assert_eq!(store.get_review_draft(&k).unwrap().unwrap().pr_number, None);

        // A retry after a failed push doesn't choke on an empty commit: the
        // `.stage` folder is already committed, so the publish re-pushes (and
        // fails again on the same bad remote — but at the push, not the commit).
        let err2 = publish_review(&store, &gh, &work, &k, &request()).unwrap_err();
        assert!(
            matches!(err2, StageError::GitCli(_)),
            "retry still push-fails: {err2:?}"
        );
    }

    // ---- ADR-0024: the uncommitted-work gate --------------------------------

    #[test]
    fn assess_uncommitted_work_detects_and_excludes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = repo_with_bare_remote(tmp.path());

        // Clean tree → nothing.
        assert!(assess_uncommitted_work(&root).unwrap().is_empty());

        // Unstaged edit, staged edit, untracked file, deleted file — all count.
        std::fs::write(root.join("src/domain.rs"), "fn domain() { /* edit */ }\n").unwrap();
        std::fs::write(root.join("README.md"), "staged edit\n").unwrap();
        git(&root, &["add", "README.md"]);
        std::fs::write(root.join("scratch.txt"), "notes\n").unwrap();
        std::fs::remove_file(root.join("src/store.rs")).unwrap();
        // `.stage/` and ignored files never count.
        std::fs::create_dir_all(root.join(".stage/feat-x")).unwrap();
        std::fs::write(root.join(".stage/feat-x/review.toml"), "x\n").unwrap();
        std::fs::write(root.join(".gitignore"), "ignored.log\n").unwrap();
        std::fs::write(root.join("ignored.log"), "noise\n").unwrap();

        let got = assess_uncommitted_work(&root).unwrap();
        let by = |p: &str| {
            got.iter()
                .find(|f| f.path == p)
                .unwrap_or_else(|| panic!("missing {p} in {got:?}"))
        };
        assert_eq!(by("README.md").state, UncommittedState::Modified);
        assert_eq!(by("src/domain.rs").state, UncommittedState::Modified);
        assert_eq!(by("scratch.txt").state, UncommittedState::New);
        assert_eq!(by("src/store.rs").state, UncommittedState::Deleted);
        assert!(
            !got.iter().any(|f| f.path.starts_with(".stage")),
            ".stage is Stage's own domain: {got:?}"
        );
        assert!(
            !got.iter().any(|f| f.path == "ignored.log"),
            "ignored files never count: {got:?}"
        );
        // Sorted by path.
        let paths: Vec<&str> = got.iter().map(|f| f.path.as_str()).collect();
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted);
    }

    #[test]
    fn dirty_publish_without_disposition_fails_loud_and_mutates_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = repo_with_bare_remote(tmp.path());
        let rec = tmp.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let gh = GitHub::with_bins(fake_gh(&rec), "git");
        let store = ready_store(tmp.path());
        let k = key("feat/x");

        std::fs::write(root.join("forgotten.rs"), "fn missing_from_pr() {}\n").unwrap();

        let head_before = git_head(&root);
        let err = publish_review(&store, &gh, &root, &k, &request()).unwrap_err();
        assert!(
            err.to_string().contains("forgotten.rs"),
            "the message names what would be left out: {err}"
        );
        assert!(
            err.to_string().contains("uncommitted"),
            "the message says why: {err}"
        );
        // Nothing was committed, written, or sent to gh.
        assert_eq!(git_head(&root), head_before);
        assert!(!review_dir(&root, "feat/x")
            .unwrap()
            .join("review.toml")
            .exists());
        assert!(!rec.join("calls").exists(), "no gh call before the gate");
        assert_eq!(store.get_review_draft(&k).unwrap().unwrap().pr_number, None);
    }

    #[test]
    fn commit_all_commits_code_with_message_then_publishes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = repo_with_bare_remote(tmp.path());
        let rec = tmp.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let gh = GitHub::with_bins(fake_gh(&rec), "git");
        let store = ready_store(tmp.path());
        let k = key("feat/x");

        // The change exists partly as an unstaged edit and an untracked file —
        // the PR-124 failure mode.
        std::fs::write(
            root.join("src/domain.rs"),
            "fn domain() { /* full impl */ }\n",
        )
        .unwrap();
        std::fs::write(root.join("src/new_part.rs"), "fn new_part() {}\n").unwrap();

        let mut req = request();
        req.uncommitted = Some(UncommittedDisposition::CommitAll {
            message: "finish the rename".into(),
        });
        let out = publish_review(&store, &gh, &root, &k, &req).unwrap();
        assert_eq!(out.action, PublishAction::Created);

        // HEAD and HEAD~1 are the two scoped .stage commits a first publish makes
        // (publish + record-PR); beneath them sits the author-code commit with
        // the author's message, carrying the code and no .stage paths.
        let scoped_files = git_show_names(&root);
        assert!(scoped_files.iter().all(|f| f.starts_with(".stage/")));
        let code_msg = git_log_subject(&root, "HEAD~2");
        assert_eq!(code_msg, "finish the rename");
        let code_files = git_show_names_at(&root, "HEAD~2");
        assert!(
            code_files.contains(&"src/domain.rs".to_string()),
            "{code_files:?}"
        );
        assert!(
            code_files.contains(&"src/new_part.rs".to_string()),
            "{code_files:?}"
        );
        assert!(
            !code_files.iter().any(|f| f.starts_with(".stage/")),
            "the code commit must not carry .stage: {code_files:?}"
        );

        // The tree is clean afterwards — everything reached the PR.
        assert!(assess_uncommitted_work(&root).unwrap().is_empty());
    }

    #[test]
    fn commit_all_requires_a_message() {
        let tmp = tempfile::tempdir().unwrap();
        let root = repo_with_bare_remote(tmp.path());
        let rec = tmp.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let gh = GitHub::with_bins(fake_gh(&rec), "git");
        let store = ready_store(tmp.path());

        std::fs::write(root.join("scratch.txt"), "x\n").unwrap();
        let mut req = request();
        req.uncommitted = Some(UncommittedDisposition::CommitAll {
            message: "   ".into(),
        });
        let err = publish_review(&store, &gh, &root, &key("feat/x"), &req).unwrap_err();
        assert!(err.to_string().contains("commit message"), "{err}");
    }

    // ---- ST-1 at publish: stale steps block ---------------------------------

    #[test]
    fn stale_step_blocks_publish_before_any_mutation() {
        let tmp = tempfile::tempdir().unwrap();
        let root = repo_with_bare_remote(tmp.path());
        let rec = tmp.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let gh = GitHub::with_bins(fake_gh(&rec), "git");
        let store = ready_store(tmp.path());
        let k = key("feat/x");

        // A step anchoring a file that is not part of the committed diff — the
        // PR-124 junk-step shape (added against a stale base, valid at the time).
        store
            .add_storyline_step(&k, "backend/ghost.py", None, "Narrates removed code.")
            .unwrap();

        let head_before = git_head(&root);
        let err = publish_review(&store, &gh, &root, &k, &request()).unwrap_err();
        assert!(err.to_string().contains("backend/ghost.py"), "{err}");
        assert!(err.to_string().contains("stale"), "{err}");
        assert!(
            err.to_string().contains("not part of the change"),
            "the reason is spelled out: {err}"
        );
        assert_eq!(git_head(&root), head_before);
        assert!(!rec.join("calls").exists(), "no gh call before the gate");
    }

    #[test]
    fn commit_all_that_stales_a_step_aborts_after_the_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let root = repo_with_bare_remote(tmp.path());
        let rec = tmp.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let gh = GitHub::with_bins(fake_gh(&rec), "git");
        let store = ready_store(tmp.path());
        let k = key("feat/x");

        // The uncommitted work *reverts* the branch's addition of src/domain.rs —
        // committing it drops the file from the committed diff, staling the step
        // that anchors it.
        std::fs::remove_file(root.join("src/domain.rs")).unwrap();

        let mut req = request();
        req.uncommitted = Some(UncommittedDisposition::CommitAll {
            message: "drop the domain module".into(),
        });
        let err = publish_review(&store, &gh, &root, &k, &req).unwrap_err();
        assert!(err.to_string().contains("src/domain.rs"), "{err}");
        assert!(
            err.to_string().contains("The commit was made"),
            "the author is told the commit stands: {err}"
        );
        // The code commit stands (fail loud, not half-undone)…
        assert_eq!(git_log_subject(&root, "HEAD"), "drop the domain module");
        // …but nothing was published.
        assert!(!rec.join("calls").exists(), "no gh call after the abort");
        assert_eq!(store.get_review_draft(&k).unwrap().unwrap().pr_number, None);
    }

    fn git_head(repo: &Path) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn git_log_subject(repo: &Path, rev: &str) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["log", "-1", "--format=%s", rev])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn git_show_names_at(repo: &Path, rev: &str) -> Vec<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["show", "--name-only", "--format=", rev])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn git_show_names(repo: &Path) -> Vec<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["show", "--name-only", "--format=", "HEAD"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect()
    }

    // ---- pure helpers ------------------------------------------------------

    #[test]
    fn slug_and_order_mapping() {
        let mk = |id: &str, anchor: &str, title: Option<&str>| StorylineStep {
            id: id.into(),
            anchor: anchor.into(),
            title: title.map(str::to_string),
            intro: "x".into(),
            order: 0,
            created_at: 0,
            updated_at: 0,
        };
        let steps = vec![
            mk("st_1", "src/domain.rs", Some("Rename the type")),
            mk("st_2", "src/store.rs", None),
        ];
        let mapped = steps_to_review_steps(&steps);
        assert_eq!(mapped[0].order, 10);
        assert_eq!(mapped[0].slug, "rename-the-type");
        assert_eq!(mapped[1].order, 20);
        // No title → basename of the anchor.
        assert_eq!(mapped[1].slug, "store-rs");
    }

    #[test]
    fn url_and_base_parsing() {
        assert_eq!(
            pr_url_from_create_output("https://github.com/o/r/pull/42\n").as_deref(),
            Some("https://github.com/o/r/pull/42")
        );
        assert_eq!(
            pr_url_from_create_output(
                "Warning: 1 uncommitted change\nhttps://github.com/o/r/pull/9\n"
            )
            .as_deref(),
            Some("https://github.com/o/r/pull/9")
        );
        assert_eq!(pr_url_from_create_output("nothing here"), None);
        assert_eq!(
            pr_number_from_url("https://github.com/o/r/pull/42"),
            Some(42)
        );
        assert_eq!(
            pr_number_from_url("https://github.com/o/r/pull/42/"),
            Some(42)
        );
        assert_eq!(pr_base_branch("origin/main"), "main");
        assert_eq!(pr_base_branch("main"), "main");
    }
}
