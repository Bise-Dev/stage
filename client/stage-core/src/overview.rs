//! The unified per-repo overview — **one** screen combining what git and
//! `.stage` know locally with what GitHub knows (DB-1..5 #84–88 + the local
//! branch list, ADR-0022 §6/§7).
//!
//! This subsumes the former two-screen split (a local branch list + a separate
//! GitHub dashboard): every local branch, per-machine draft, published Review,
//! and plain PR lands in a single row list, each row tagged with its
//! [`OverviewKind`] so the webview only buckets and renders (ADR-0022 §7 — TS
//! derives nothing).
//!
//! Sources, joined by branch (`head_ref`):
//! 1. **`gh` search** — my authored / review-requested PRs (when GitHub is
//!    included). A PR row absorbs its local branch: the branch stops being a
//!    plain `Branch` row and its worktree/debrief metadata rides along.
//! 2. **Local store** — pre-publish drafts (this machine only). A draft whose
//!    branch has a PR is subsumed by the PR row, exactly as the dashboard did.
//! 3. **git** — every local branch, with worktree annotations (observe-only,
//!    ADR-0016) and a ± signal vs. the repo's default base. A branch whose tip
//!    carries a committed `.stage/<branch>/` but matches no PR/draft surfaces
//!    as `Published` with its `review.toml` metadata — status is left `None`
//!    rather than invented (WS-5: derived or absent, never guessed).
//!
//! GitHub being unreachable is **not** hidden: `assemble_overview` with
//! `github: None` returns the purely-local view and flags it
//! (`github_included: false`); with `Some(gh)` any `gh` failure fails the whole
//! call (fail loud, CLAUDE.md) — the caller may then re-ask for the local view
//! and surface the error alongside it (ID-3 #56: local work needs no auth).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use ts_rs::TS;

use crate::diff::diff_stats;
use crate::domain::{DebriefFreshness, Review};
use crate::error::StageError;
use crate::github::{GhPrState, GhPullRequest, GitHub, PrFilter};
use crate::repo_key::RepoKey;
use crate::review_folder::{read_review_from_tree, StageReview};
use crate::status::{
    is_archived, status_from_pr, status_from_state, ReviewRole, ReviewSignal, ReviewStatus,
};
use crate::store::Store;
use crate::viewed::current_post_image_oid;
use crate::worktree::list_worktrees;

/// What a row *is* — the webview buckets on this and derives nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OverviewKind {
    /// A local branch with no Review yet — the Self-Review bucket.
    Branch,
    /// A per-machine pre-publish draft Review (Ready to share, not on GitHub).
    Draft,
    /// A Stage-guided Review that reached GitHub (a PR row with committed
    /// `.stage`, or a local branch whose tip carries one).
    Published,
    /// A plain GitHub PR — no `.stage` anywhere we can see (DB-3 #86).
    PlainPr,
}

/// The worktree a branch is checked out on, if any (observe-only, ADR-0016).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorktreeMeta {
    /// Absolute working-directory path — what `set_focused_worktree` takes.
    pub path: String,
    /// Git's original worktree (cannot be removed).
    pub is_root: bool,
    /// git reports the worktree locked.
    pub locked: bool,
    /// git reports the worktree prunable (its directory is gone/invalid).
    pub prunable: bool,
}

/// Self-Review progress for a branch (v6-light L2): counts derived from the
/// content-anchored viewed marks (F2b — a mark whose anchor no longer matches
/// the file's current post-image counts as unviewed). `total` is the
/// branch-vs-base changed file count — the same diff as `changed_file_count`.
/// (The explicit "Mark reviewed" done state was removed in L7 — F3 rescinded.)
///
/// `notes` is the branch's stored Self-Review note count, every status
/// included. It is the *other* half of "the author has started": a note
/// written without any file marked viewed leaves `viewed` at 0, and the row
/// would otherwise read as untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SelfReviewProgress {
    pub viewed: u32,
    pub total: u32,
    /// Notes the author has written on this branch, any status.
    pub notes: u32,
}

/// Local-git annotations for a row whose branch exists in this clone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BranchMeta {
    /// The branch checked out in the focused worktree (HEAD at `repo_root`).
    pub is_current: bool,
    /// The repo's default branch (`origin/HEAD`'s target).
    pub is_default: bool,
    /// A local agent Debrief exists for this branch (Self-Review entry signal).
    pub has_debrief: bool,
    /// Freshness of that Debrief (new/seen/outdated vs. the branch's current
    /// head); `None` exactly when `has_debrief` is false.
    pub debrief_freshness: Option<DebriefFreshness>,
    /// Working-tree entries (staged/unstaged/untracked) in this branch's
    /// worktree. `None` when the branch has no working tree — absent, never a
    /// fake 0 (a branch without a checkout has no dirtiness to report).
    pub uncommitted_count: Option<u32>,
    /// Files changed vs. the repo's default base (the same tree-to-tree diff
    /// as the ± signal). `None` when there is no comparable base.
    pub changed_file_count: Option<u32>,
    /// Viewed/total Self-Review progress plus the note count; `None` when
    /// there is no comparable base to diff against (then there is no honest
    /// `total`).
    pub self_review: Option<SelfReviewProgress>,
    /// Last-commit time, epoch seconds (UTC). Formatted on the client.
    #[ts(type = "number")]
    pub updated_at: i64,
    /// Last-commit summary line.
    pub last_commit: Option<String>,
    /// Set when the branch is checked out on a worktree.
    pub worktree: Option<WorktreeMeta>,
}

/// One overview entry. The union of the former dashboard row and the local
/// branch row: `status`/`signal`/`author_login` are `Option` because a purely
/// local row (or a GitHub-less view) has no honest value for them — absent is
/// rendered as absent, never faked (WS-5 #63).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OverviewRow {
    pub kind: OverviewKind,
    /// Review/PR title; for a `Branch` row, the branch name.
    pub title: String,
    /// The branch the change rides on — the Review's authoritative identity.
    pub branch: String,
    /// The branch it's composed against; `None` for a plain `Branch` row (its
    /// signal base is the repo default, not a chosen base).
    pub base_ref: Option<String>,
    /// Derived status (WS-5) — `None` when it cannot be derived from local data
    /// (a `Branch` row, or a locally-published Review outside the PR search).
    pub status: Option<ReviewStatus>,
    /// Mine vs. awaiting my review. Local-only rows are always `Author`.
    pub role: ReviewRole,
    /// ± lines. `None` when there is no comparable base (e.g. the default
    /// branch itself, or no merge base), or when only the cheap PR tier was
    /// fetched for this row — absent, not `0/0`.
    pub signal: Option<ReviewSignal>,
    /// Stage-guided (draft, or committed `.stage` at the head) vs. plain.
    pub stage_guided: bool,
    /// Closed/merged PR (DB-5 #88) — hidden by the default view.
    pub archived: bool,
    pub pr_number: Option<u32>,
    pub url: Option<String>,
    /// The change author's GitHub login; `None` when GitHub wasn't consulted.
    pub author_login: Option<String>,
    /// Storyline size — draft step count, or the committed `.stage` step count
    /// at the head. `None` when there is no storyline to count (plain rows).
    pub storyline_count: Option<u32>,
    /// GitHub's ISO-8601 `updatedAt` for PR rows; local rows time-stamp via
    /// `branch_meta.updated_at` (the last commit) instead.
    pub updated_at: Option<String>,
    /// Local-git annotations; `None` when the branch isn't in this clone.
    pub branch_meta: Option<BranchMeta>,
}

/// The assembled unified overview. `github_included: false` marks the local-only
/// view (no `gh` consulted) so the webview can say so instead of implying the
/// GitHub side is empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OverviewView {
    pub rows: Vec<OverviewRow>,
    pub github_included: bool,
    /// The repo's default branch name (e.g. `main`), when known.
    pub default_branch: Option<String>,
}

/// A local branch as git2 reports it — internal to the assembly.
struct LocalBranch {
    name: String,
    is_head: bool,
    /// Full tip commit SHA — the comparand for debrief freshness and the
    /// SHA-bound done state.
    tip_sha: String,
    updated_at: i64,
    last_commit: Option<String>,
}

/// The GitHub half of the overview, fetched separately from the assembly so a
/// long-lived caller (the background sync engine) can keep the last successful
/// fetch and re-assemble against it when only local state moved — instead of
/// re-asking `gh` on every recompute.
#[derive(Debug, Clone)]
pub struct OverviewGithubData {
    /// My **open** PRs at full detail, deduped (authored ordering wins over
    /// review-requested), each with the role it was found under. These are the
    /// only PRs a rendered row paints.
    pub prs: Vec<(GhPullRequest, ReviewRole)>,
    /// The archived remainder at state detail — every other PR, deduped the
    /// same way and with anything already in `prs` removed. Enough to absorb a
    /// finished branch's row and hide it (DB-5 #88) without paying the detail
    /// field set for ~40x as many PRs as the overview ever shows.
    pub pr_states: Vec<(GhPrState, ReviewRole)>,
    /// The `gh` token owner's login — attributes local draft rows.
    pub me: Option<String>,
}

/// Fetch the GitHub half of the overview: the `gh` PR searches (authored +
/// review-requested, DB-1/DB-3) and the token owner's identity. Fail loud —
/// any `gh` failure fails the whole call, never a partial result.
///
/// Each search runs at two tiers (see [`GitHub::list_repo_prs`]): full detail
/// for the open PRs a row actually paints, then `state` alone for every PR so
/// the archived view-filter still knows which branches are done. On a busy repo
/// that is the difference between one field set over ~200 PRs and over the ~5
/// that are open.
pub fn fetch_overview_github(
    gh: &GitHub,
    repo_key: &RepoKey,
) -> Result<OverviewGithubData, StageError> {
    let repo_slug = format!("{}/{}", repo_key.repo_owner, repo_key.repo_name);
    let authored = gh.list_repo_prs(&repo_slug, PrFilter::Authored)?;
    let review_requested = gh.list_repo_prs(&repo_slug, PrFilter::ReviewRequested)?;
    let authored_states = gh.list_repo_pr_states(&repo_slug, PrFilter::Authored)?;
    let review_requested_states = gh.list_repo_pr_states(&repo_slug, PrFilter::ReviewRequested)?;
    let me = gh.current_user()?.login;

    let mut seen_numbers: HashSet<u32> = HashSet::new();
    let mut prs = Vec::new();
    for (pr, role) in authored.into_iter().map(|p| (p, ReviewRole::Author)).chain(
        review_requested
            .into_iter()
            .map(|p| (p, ReviewRole::Reviewer)),
    ) {
        if seen_numbers.insert(pr.number) {
            prs.push((pr, role));
        }
    }
    // Same dedup set, so the detail tier wins wherever both saw a PR: whatever
    // the state tier adds on top is exactly the archived remainder.
    let mut pr_states = Vec::new();
    for (pr, role) in authored_states
        .into_iter()
        .map(|p| (p, ReviewRole::Author))
        .chain(
            review_requested_states
                .into_iter()
                .map(|p| (p, ReviewRole::Reviewer)),
        )
    {
        if seen_numbers.insert(pr.number) {
            pr_states.push((pr, role));
        }
    }
    Ok(OverviewGithubData {
        prs,
        pr_states,
        me: Some(me),
    })
}

/// A branch's tree-to-tree diff vs. the default base, as the overview needs
/// it: the ± signal plus the changed files with their post-image blob OIDs
/// (the validity comparand for content-anchored viewed marks, F2b). The file
/// list rides in an `Arc` so cache hits clone a pointer, not a Vec.
#[derive(Debug, Clone)]
struct BranchDiff {
    signal: ReviewSignal,
    /// `(path, post_image_oid)` per changed file; a deletion carries the zero
    /// OID ([`crate::viewed::ABSENT_POST_IMAGE`]), matching the mark sentinel.
    files: Arc<Vec<(String, String)>>,
}

/// Memoizes the per-branch base diffs across overview recomputes, keyed by the
/// commit OIDs the diff actually depends on: `(head, base)`. Resolving OIDs is
/// cheap; the `diff_tree_to_tree` behind each entry is not — with the cache a
/// branch only pays for a diff when its tip (or the base) moves. Hold one per
/// repo (the sync engine does) and pass it to [`assemble_overview_with`]; a
/// throwaway `SignalCache::default()` gives the uncached behaviour.
#[derive(Default)]
pub struct SignalCache {
    branch: HashMap<(git2::Oid, git2::Oid), Option<BranchDiff>>,
    draft: HashMap<(git2::Oid, git2::Oid), ReviewSignal>,
}

impl SignalCache {
    /// Cached [`branch_diff`]: same semantics (`None` for no comparable
    /// base / no merge base), memoized on `(head, base)` commit OIDs.
    fn branch_diff(
        &mut self,
        repo: &git2::Repository,
        base: Option<&str>,
        branch: &str,
    ) -> Result<Option<BranchDiff>, StageError> {
        let Some(base) = base else { return Ok(None) };
        let Ok(base_commit) = repo.revparse_single(base).and_then(|o| o.peel_to_commit()) else {
            return Ok(None); // default base not resolvable in this clone
        };
        let head_commit = repo.revparse_single(branch)?.peel_to_commit()?;
        let key = (head_commit.id(), base_commit.id());
        if let Some(diff) = self.branch.get(&key) {
            return Ok(diff.clone());
        }
        let diff = branch_diff(repo, Some(base), branch)?;
        self.branch.insert(key, diff.clone());
        Ok(diff)
    }

    /// The ± signal slice of [`Self::branch_diff`] — the shape the rows carry.
    fn branch_signal(
        &mut self,
        repo: &git2::Repository,
        base: Option<&str>,
        branch: &str,
    ) -> Result<Option<ReviewSignal>, StageError> {
        Ok(self.branch_diff(repo, base, branch)?.map(|d| d.signal))
    }

    /// Cached [`draft_signal`]: memoized on the draft's resolved `(head, base)`
    /// commit OIDs. When either ref can't be resolved for a key, fall through to
    /// the uncached path so its behaviour (skip-row `None`, or the loud diff
    /// failure) is preserved exactly.
    fn draft_signal(
        &mut self,
        repo_root: &Path,
        draft: &Review,
    ) -> Result<Option<ReviewSignal>, StageError> {
        let key = draft_oids(repo_root, draft)?;
        if let Some(key) = key {
            if let Some(signal) = self.draft.get(&key) {
                return Ok(Some(*signal));
            }
        }
        let signal = draft_signal(repo_root, draft)?;
        if let (Some(key), Some(signal)) = (key, signal) {
            self.draft.insert(key, signal);
        }
        Ok(signal)
    }
}

/// The `(head, base)` commit OIDs a draft's signal depends on, or `None` when
/// they don't both resolve (the uncached path then decides what that means).
fn draft_oids(
    repo_root: &Path,
    draft: &Review,
) -> Result<Option<(git2::Oid, git2::Oid)>, StageError> {
    let repo = git2::Repository::discover(repo_root)?;
    let resolve = |name: &str| {
        repo.revparse_single(name)
            .and_then(|o| o.peel_to_commit())
            .map(|c| c.id())
            .ok()
    };
    let head = resolve(&draft.head_ref).or_else(|| resolve(&format!("origin/{}", draft.head_ref)));
    let base = resolve(&draft.base_ref);
    Ok(head.zip(base))
}

/// Assemble the unified overview. With `github: Some`, any `gh` failure fails
/// the whole call (fail loud — the caller may re-ask with `None` and surface
/// the error next to the local view). `include_archived` flips the DB-5 filter.
///
/// A convenience wrapper over [`fetch_overview_github`] +
/// [`assemble_overview_with`] for one-shot callers; the sync engine calls the
/// parts separately so it can cache the GitHub half and the signal diffs.
pub fn assemble_overview(
    store: &Store,
    github: Option<&GitHub>,
    repo_root: &Path,
    repo_key: &RepoKey,
    include_archived: bool,
) -> Result<OverviewView, StageError> {
    let data = github
        .map(|gh| fetch_overview_github(gh, repo_key))
        .transpose()?;
    assemble_overview_with(
        store,
        repo_root,
        repo_key,
        data.as_ref(),
        include_archived,
        &mut SignalCache::default(),
    )
}

/// Assemble the unified overview from already-fetched parts. `github: None`
/// marks the purely-local view (`github_included: false`); `Some` merges the
/// given PR search results without touching the network.
pub fn assemble_overview_with(
    store: &Store,
    repo_root: &Path,
    repo_key: &RepoKey,
    github: Option<&OverviewGithubData>,
    include_archived: bool,
    cache: &mut SignalCache,
) -> Result<OverviewView, StageError> {
    let repo = git2::Repository::discover(repo_root)
        .map_err(|_| StageError::NotARepo(repo_root.to_path_buf()))?;

    // Local facts first: branches, worktrees, debriefs, the default base.
    let branches = local_branches(&repo)?;
    let worktrees = list_worktrees(repo_root)?;
    let debrief_inputs =
        store.list_debrief_freshness_inputs(&repo_key.repo_owner, &repo_key.repo_name)?;
    let viewed_by_branch =
        store.list_viewed_by_branch(&repo_key.repo_owner, &repo_key.repo_name)?;
    let notes_by_branch = store.count_notes_by_branch(&repo_key.repo_owner, &repo_key.repo_name)?;
    let default_branch = default_branch_name(&repo);
    // The comparison base for plain-branch signals: prefer the remote-tracking
    // default over a possibly-stale local one (ADR-0016/0018).
    let signal_base = default_branch.as_ref().map(|name| {
        let remote = format!("origin/{name}");
        if repo.revparse_single(&remote).is_ok() {
            remote
        } else {
            name.clone()
        }
    });

    let mut meta_by_branch: HashMap<String, BranchMeta> = HashMap::new();
    for b in &branches {
        let wt = worktrees
            .iter()
            .find(|w| w.branch.as_deref() == Some(b.name.as_str()))
            .map(|w| WorktreeMeta {
                path: w.path.to_string_lossy().into_owned(),
                is_root: w.is_root,
                locked: w.locked.is_some(),
                prunable: w.prunable.is_some(),
            });
        let is_default = default_branch.as_deref() == Some(b.name.as_str());

        // A prunable worktree's directory is gone — there is no working tree
        // to count, so `None` (absent), same as no worktree at all.
        let usable_wt_path = wt
            .as_ref()
            .filter(|w| !w.prunable)
            .map(|w| Path::new(&w.path).to_path_buf());
        let uncommitted = usable_wt_path
            .as_deref()
            .map(uncommitted_count)
            .transpose()?;

        // The base diff behind the ± signal, reused for the file count and the
        // viewed-progress total (one memoized diff, three fields). The default
        // branch has no base to compare against — all three stay absent.
        let bdiff = if is_default {
            None
        } else {
            cache.branch_diff(&repo, signal_base.as_deref(), &b.name)?
        };

        let self_review = match &bdiff {
            None => None,
            Some(d) => {
                let marks = viewed_by_branch.get(&b.name);
                let mut viewed = 0u32;
                for mark in marks.into_iter().flatten() {
                    // Validity (F2b): the stored anchor must equal the file's
                    // current post-image. For a materialized branch that is the
                    // working-tree content; otherwise the tip blob — which the
                    // memoized diff already carries, no extra git work.
                    let Some((_, tip_oid)) = d.files.iter().find(|(p, _)| p == &mark.file) else {
                        continue; // marked file no longer in the base diff
                    };
                    let current = match usable_wt_path.as_deref() {
                        Some(wt_path) => {
                            current_post_image_oid(&repo, Some(wt_path), &b.name, &mark.file)?
                        }
                        None => tip_oid.clone(),
                    };
                    if current == mark.blob_oid {
                        viewed += 1;
                    }
                }
                Some(SelfReviewProgress {
                    viewed,
                    total: d.files.len() as u32,
                    notes: notes_by_branch.get(&b.name).copied().unwrap_or(0),
                })
            }
        };

        let debrief_freshness = debrief_inputs
            .get(&b.name)
            .map(|(head_sha, seen_at)| DebriefFreshness::derive(head_sha, *seen_at, &b.tip_sha));

        meta_by_branch.insert(
            b.name.clone(),
            BranchMeta {
                is_current: b.is_head,
                is_default,
                has_debrief: debrief_freshness.is_some(),
                debrief_freshness,
                uncommitted_count: uncommitted,
                changed_file_count: bdiff.as_ref().map(|d| d.files.len() as u32),
                self_review,
                updated_at: b.updated_at,
                last_commit: b.last_commit.clone(),
                worktree: wt,
            },
        );
    }

    let mut rows: Vec<OverviewRow> = Vec::new();

    // --- Source 2 (when included): my PRs via `gh` search --------------------
    let mut pr_heads: HashSet<String> = HashSet::new();
    if let Some(data) = github {
        for (pr, role) in &data.prs {
            let role = *role;
            pr_heads.insert(pr.head_ref_name.clone());
            let status = status_from_pr(pr);
            // Checkout-free probe: the committed Review at the head, if any —
            // presence is the Stage-vs-plain flag, its steps size the storyline.
            let committed = committed_review(&repo, &pr.head_ref_name)?;
            let stage_guided = committed.is_some();
            rows.push(OverviewRow {
                kind: if stage_guided {
                    OverviewKind::Published
                } else {
                    OverviewKind::PlainPr
                },
                title: pr.title.clone(),
                branch: pr.head_ref_name.clone(),
                base_ref: Some(pr.base_ref_name.clone()),
                archived: is_archived(status),
                status: Some(status),
                role,
                signal: Some(ReviewSignal {
                    added: pr.additions,
                    removed: pr.deletions,
                }),
                stage_guided,
                pr_number: Some(pr.number),
                url: Some(pr.url.clone()),
                author_login: Some(pr.author.login.clone()),
                storyline_count: committed.map(|r| r.steps.len() as u32),
                updated_at: (!pr.updated_at.is_empty()).then(|| pr.updated_at.clone()),
                branch_meta: meta_by_branch.get(&pr.head_ref_name).cloned(),
            });
        }
        // The archived remainder. These rows exist to absorb their branch and
        // then be hidden (DB-5 #88) — so they claim only what the state tier
        // actually fetched: `signal`/`base_ref`/`author_login` stay `None`
        // rather than standing in at `0`/`""` (CLAUDE.md: no value that implies
        // data we don't have). `kind`/`stage_guided` skip the per-PR
        // `committed_review` tree probe for the same reason: nothing renders
        // them here, and paying ~200 git lookups to fill a hidden row is the
        // cost this tier exists to avoid.
        for (pr, role) in &data.pr_states {
            let status = status_from_state(&pr.state, "");
            pr_heads.insert(pr.head_ref_name.clone());
            rows.push(OverviewRow {
                kind: OverviewKind::PlainPr,
                title: pr.head_ref_name.clone(),
                branch: pr.head_ref_name.clone(),
                base_ref: None,
                archived: is_archived(status),
                status: Some(status),
                role: *role,
                signal: None,
                stage_guided: false,
                pr_number: Some(pr.number),
                url: Some(pr.url.clone()),
                author_login: None,
                storyline_count: None,
                updated_at: None,
                branch_meta: meta_by_branch.get(&pr.head_ref_name).cloned(),
            });
        }
    }

    // --- Source 1: pre-publish drafts (this machine) -------------------------
    let me = github.and_then(|data| data.me.clone());
    let mut draft_heads: HashSet<String> = HashSet::new();
    for draft in store.list_review_drafts(&repo_key.repo_owner, &repo_key.repo_name)? {
        if pr_heads.contains(&draft.head_ref) {
            continue; // published — the PR row subsumes it
        }
        // Accepted DB-1 risk: a draft only appears for a branch present in this
        // clone (documented per-machine behaviour, mirrors the dashboard).
        let Some(signal) = cache.draft_signal(repo_root, &draft)? else {
            tracing::debug!(
                branch = %draft.head_ref,
                "overview_draft_branch_absent: skipped (not present in this clone)"
            );
            continue;
        };
        draft_heads.insert(draft.head_ref.clone());
        let steps = store.list_storyline_steps(&RepoKey {
            repo_owner: repo_key.repo_owner.clone(),
            repo_name: repo_key.repo_name.clone(),
            branch: draft.head_ref.clone(),
        })?;
        // Draft vs Ready-to-publish: the same PUB-2 gate publish enforces
        // (CONTEXT.md *Ready to publish* — computed the moment it holds).
        let status = if crate::publish::assess_publish_readiness(&steps).ready {
            ReviewStatus::ReadyToPublish
        } else {
            ReviewStatus::Draft
        };
        rows.push(OverviewRow {
            kind: OverviewKind::Draft,
            title: draft.title.clone(),
            branch: draft.head_ref.clone(),
            base_ref: Some(draft.base_ref.clone()),
            status: Some(status),
            role: ReviewRole::Author,
            signal: Some(signal),
            stage_guided: true,
            archived: false,
            pr_number: None,
            url: None,
            author_login: me.clone(),
            storyline_count: Some(steps.len() as u32),
            updated_at: None,
            branch_meta: meta_by_branch.get(&draft.head_ref).cloned(),
        });
    }

    // --- Source 3: the remaining local branches ------------------------------
    for b in &branches {
        if pr_heads.contains(&b.name) || draft_heads.contains(&b.name) {
            continue; // absorbed by a PR/draft row above
        }
        let meta = meta_by_branch.get(&b.name).cloned();

        // A committed `.stage/<branch>/` at the tip without a matching PR row:
        // a published Review we can see locally (e.g. GitHub not consulted, or
        // someone else's branch). Surface its metadata; leave status underived.
        if let Some(committed) = committed_review(&repo, &b.name)? {
            rows.push(OverviewRow {
                kind: OverviewKind::Published,
                title: committed.meta.title.clone(),
                branch: b.name.clone(),
                base_ref: Some(committed.meta.base_ref.clone()),
                status: None,
                role: ReviewRole::Author,
                signal: cache.branch_signal(&repo, signal_base.as_deref(), &b.name)?,
                stage_guided: true,
                archived: false,
                pr_number: committed.meta.pr_number,
                url: None,
                author_login: None,
                storyline_count: Some(committed.steps.len() as u32),
                updated_at: None,
                branch_meta: meta,
            });
            continue;
        }

        rows.push(OverviewRow {
            kind: OverviewKind::Branch,
            title: b.name.clone(),
            branch: b.name.clone(),
            base_ref: None,
            status: None,
            role: ReviewRole::Author,
            signal: if meta.as_ref().is_some_and(|m| m.is_default) {
                None // the default branch has no base to compare against
            } else {
                cache.branch_signal(&repo, signal_base.as_deref(), &b.name)?
            },
            stage_guided: false,
            archived: false,
            pr_number: None,
            url: None,
            author_login: None,
            storyline_count: None,
            updated_at: None,
            branch_meta: meta,
        });
    }

    // DB-5 #88: archived (closed/merged) hidden by default; a *view* filter only.
    if !include_archived {
        rows.retain(|r| !r.archived);
    }

    Ok(OverviewView {
        rows,
        github_included: github.is_some(),
        default_branch,
    })
}

/// The committed Review at a branch's tip, read from the tree (never the
/// working dir) — the checkout-free Stage-vs-plain probe, upgraded to return
/// the whole Review so the row can carry its metadata and step count.
/// Candidates are tried like `review_committed_for_branch`: the local branch,
/// then its `origin/<branch>` remote-tracking copy; a ref absent from this
/// clone honestly reads as "plain as far as we can tell" (DB-4 #87).
fn committed_review(
    repo: &git2::Repository,
    branch: &str,
) -> Result<Option<StageReview>, StageError> {
    for candidate in [branch.to_string(), format!("origin/{branch}")] {
        let Ok(obj) = repo.revparse_single(&candidate) else {
            continue;
        };
        let tree = obj.peel_to_tree()?;
        if let Some(review) = read_review_from_tree(repo, &tree, branch)? {
            return Ok(Some(review));
        }
    }
    Ok(None)
}

/// The ±lines signal for a pre-publish draft, from its branch's committed diff
/// vs. its base. `Ok(None)` when the branch isn't present in this clone (the
/// accepted DB-1 per-machine risk) so the caller skips the row rather than fail
/// the overview or fake a size.
fn draft_signal(repo_root: &Path, draft: &Review) -> Result<Option<ReviewSignal>, StageError> {
    if !branch_present(repo_root, &draft.head_ref)? {
        return Ok(None);
    }
    let stats = diff_stats(repo_root, &draft.base_ref, &draft.head_ref)?;
    Ok(Some(ReviewSignal {
        added: stats.added as u32,
        removed: stats.removed as u32,
    }))
}

/// Whether `branch` (or its `origin/<branch>`) resolves in this clone.
fn branch_present(repo_root: &Path, branch: &str) -> Result<bool, StageError> {
    let repo = git2::Repository::discover(repo_root)?;
    Ok([branch.to_string(), format!("origin/{branch}")]
        .iter()
        .any(|r| repo.revparse_single(r).is_ok()))
}

/// The base diff for a plain branch vs. the repo's default base: ± lines plus
/// the changed files with their post-image blob OIDs. `Ok(None)` when there
/// is no comparable base — no default resolved, or no merge base (an orphan /
/// unrelated-history branch): that is a legitimate absence of a signal, not a
/// failure to hide. A genuine diff failure on comparable refs propagates.
fn branch_diff(
    repo: &git2::Repository,
    base: Option<&str>,
    branch: &str,
) -> Result<Option<BranchDiff>, StageError> {
    let Some(base) = base else { return Ok(None) };
    let Ok(base_commit) = repo.revparse_single(base).and_then(|o| o.peel_to_commit()) else {
        return Ok(None); // default base not resolvable in this clone
    };
    let head_commit = repo.revparse_single(branch)?.peel_to_commit()?;
    let merge_base = match repo.merge_base(base_commit.id(), head_commit.id()) {
        Ok(oid) => oid,
        Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(None),
        Err(e) => return Err(StageError::Git(e)),
    };
    let base_tree = repo.find_commit(merge_base)?.tree()?;
    let head_tree = head_commit.tree()?;
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), None)?;
    let stats = diff.stats()?;
    let mut files = Vec::with_capacity(diff.deltas().len());
    for delta in diff.deltas() {
        // Post-image path when it exists (a deletion falls back to the old
        // path); post-image OID is zero for deletions — the same sentinel the
        // viewed marks use (`ABSENT_POST_IMAGE`).
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .ok_or_else(|| {
                StageError::Invalid(format!(
                    "branch_diff: delta without a path in '{branch}' vs '{base}'"
                ))
            })?;
        files.push((
            path.to_string_lossy().into_owned(),
            delta.new_file().id().to_string(),
        ));
    }
    Ok(Some(BranchDiff {
        signal: ReviewSignal {
            added: stats.insertions() as u32,
            removed: stats.deletions() as u32,
        },
        files: Arc::new(files),
    }))
}

/// Working-tree entry count (staged + unstaged + untracked, ignored excluded)
/// for the worktree at `path`. Fail loud: a worktree we can't inspect is an
/// error, never a fake 0.
pub(crate) fn uncommitted_count(path: &Path) -> Result<u32, StageError> {
    let repo = git2::Repository::open(path)?;
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .exclude_submodules(true);
    let statuses = repo.statuses(Some(&mut opts))?;
    Ok(statuses.iter().filter(|e| !e.status().is_ignored()).count() as u32)
}

/// `origin/HEAD`'s target shorthand (e.g. `main`), matching `base_options`'s
/// derivation; `None` when origin/HEAD isn't set (e.g. no remote).
fn default_branch_name(repo: &git2::Repository) -> Option<String> {
    let reference = repo.find_reference("refs/remotes/origin/HEAD").ok()?;
    let target = reference.symbolic_target()?;
    target.rsplit('/').next().map(str::to_string)
}

/// All local branches, most-recently-committed first. Fail-loud like the
/// existing branch listing (CLAUDE.md): one unreadable ref fails the call
/// naming the offender — never a silently shorter list.
fn local_branches(repo: &git2::Repository) -> Result<Vec<LocalBranch>, StageError> {
    let mut out = Vec::new();
    for entry in repo.branches(Some(git2::BranchType::Local))? {
        let (branch, _) = entry.map_err(StageError::Git)?;
        let name = branch
            .name()
            .map_err(StageError::Git)?
            .map(str::to_string)
            .ok_or_else(|| {
                StageError::Invalid("local_branches: non-UTF-8 branch name in repository".into())
            })?;
        let is_head = branch.is_head();
        let commit = branch.get().peel_to_commit().map_err(|e| {
            StageError::Invalid(format!(
                "local_branches: branch '{name}' has unreadable commit: {e}"
            ))
        })?;
        out.push(LocalBranch {
            name,
            is_head,
            tip_sha: commit.id().to_string(),
            updated_at: commit.time().seconds(),
            last_commit: commit.summary().map(str::to_string),
        });
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::GitHub;
    use crate::review_folder::{scoped_commit, write_review, ReviewMeta, StageReview};
    use std::path::Path;
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

    #[cfg(unix)]
    fn write_script(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    fn key() -> RepoKey {
        RepoKey {
            repo_owner: "octo".into(),
            repo_name: "stage".into(),
            branch: "main".into(),
        }
    }

    /// A repo with `main`, a published branch (committed `.stage`), a plain PR
    /// branch, a draft branch, and a spare local branch nothing references.
    fn setup_repo(root: &Path) {
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.email", "t@e.com"]);
        git(root, &["config", "user.name", "t"]);
        std::fs::write(root.join("base.rs"), "fn base() {}\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "init"]);

        git(root, &["checkout", "-q", "-b", "feat/published-stage"]);
        let review = StageReview {
            meta: ReviewMeta {
                title: "Published".into(),
                base_ref: "main".into(),
                head_ref: "feat/published-stage".into(),
                pr_number: Some(1),
            },
            steps: vec![],
        };
        write_review(root, &review).unwrap();
        scoped_commit(root, "feat/published-stage", "stage: publish").unwrap();

        git(root, &["checkout", "-q", "main"]);
        git(root, &["checkout", "-q", "-b", "feat/plain-pr"]);
        std::fs::write(root.join("plain.rs"), "fn plain() {}\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "plain change"]);

        git(root, &["checkout", "-q", "main"]);
        git(root, &["checkout", "-q", "-b", "feat/draft"]);
        std::fs::write(root.join("draft.rs"), "fn draft() {}\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "draft change"]);

        git(root, &["checkout", "-q", "main"]);
        git(root, &["branch", "-q", "feat/spare"]);
    }

    /// Mirrors the dashboard's fake `gh` (see `dashboard.rs::tests`).
    ///
    /// Dispatches on both axes the real query varies: the role filter and the
    /// `--state` tier. Every PR here is open, so the `--state all` tier adds
    /// nothing the detail tier didn't already carry — see
    /// [`archived_pr_absorbs_its_branch_and_stays_hidden`] for the tier that does.
    #[cfg(unix)]
    fn fake_gh(dir: &Path) -> std::path::PathBuf {
        let authored = r#"[
          {"number":1,"title":"Published","state":"OPEN","url":"https://gh/1","headRefName":"feat/published-stage","baseRefName":"main","additions":5,"deletions":2,"reviewDecision":"APPROVED","author":{"login":"me"}}
        ]"#;
        let reviewer = r#"[
          {"number":3,"title":"Their PR","state":"OPEN","url":"https://gh/3","headRefName":"feat/their-pr","baseRefName":"main","additions":7,"deletions":1,"reviewDecision":"","author":{"login":"them"}}
        ]"#;
        let states = r#"[
          {"number":1,"state":"OPEN","headRefName":"feat/published-stage","url":"https://gh/1"}
        ]"#;
        let reviewer_states = r#"[
          {"number":3,"state":"OPEN","headRefName":"feat/their-pr","url":"https://gh/3"}
        ]"#;
        fake_gh_with(dir, authored, reviewer, states, reviewer_states)
    }

    /// The fake `gh` behind [`fake_gh`], with each of the four PR-list
    /// responses supplied explicitly: (authored, reviewer) × (detail, state).
    #[cfg(unix)]
    fn fake_gh_with(
        dir: &Path,
        authored: &str,
        reviewer: &str,
        authored_states: &str,
        reviewer_states: &str,
    ) -> std::path::PathBuf {
        let write = |name: &str, body: &str| {
            std::fs::write(dir.join(name), body).unwrap();
            dir.join(name).to_string_lossy().into_owned()
        };
        let a_detail = write("authored-open.json", authored);
        let r_detail = write("reviewer-open.json", reviewer);
        let a_state = write("authored-all.json", authored_states);
        let r_state = write("reviewer-all.json", reviewer_states);
        let body = format!(
            "#!/usr/bin/env bash\n\
             if [ \"$1\" = auth ] && [ \"$2\" = status ]; then exit 0; fi\n\
             if [ \"$1\" = api ] && [ \"$2\" = user ]; then echo '{{\"login\":\"me\",\"id\":1,\"name\":\"Me\"}}'; exit 0; fi\n\
             case \"$*\" in\n\
               *\"--state all\"*review-requested*) cat {r_state:?} ;;\n\
               *\"--state all\"*) cat {a_state:?} ;;\n\
               *review-requested*) cat {r_detail:?} ;;\n\
               *) cat {a_detail:?} ;;\n\
             esac\n\
             exit 0\n",
        );
        write_script(dir, "gh", &body)
    }

    fn by_branch<'a>(view: &'a OverviewView, b: &str) -> &'a OverviewRow {
        view.rows
            .iter()
            .find(|r| r.branch == b)
            .unwrap_or_else(|| panic!("no row for {b}: {:#?}", view.rows))
    }

    /// A PR surfaced by both searches keeps one entry, with the Author role
    /// (authored ordering wins over review-requested).
    #[cfg(unix)]
    #[test]
    fn fetch_overview_github_dedupes_authored_over_review_requested() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        // The same PR #1 comes back from both searches (e.g. self-requested
        // review); #3 is review-requested only.
        let authored = r#"[
          {"number":1,"title":"Mine","state":"OPEN","url":"https://gh/1","headRefName":"feat/mine","baseRefName":"main","additions":5,"deletions":2,"reviewDecision":"","author":{"login":"me"}}
        ]"#;
        let reviewer = r#"[
          {"number":1,"title":"Mine","state":"OPEN","url":"https://gh/1","headRefName":"feat/mine","baseRefName":"main","additions":5,"deletions":2,"reviewDecision":"","author":{"login":"me"}},
          {"number":3,"title":"Their PR","state":"OPEN","url":"https://gh/3","headRefName":"feat/their","baseRefName":"main","additions":7,"deletions":1,"reviewDecision":"","author":{"login":"them"}}
        ]"#;
        // Both PRs are open, so the state tier re-reports them; the detail
        // tier must win, leaving the archived remainder empty.
        let states = r#"[
          {"number":1,"state":"OPEN","headRefName":"feat/mine","url":"https://gh/1"}
        ]"#;
        let reviewer_states = r#"[
          {"number":1,"state":"OPEN","headRefName":"feat/mine","url":"https://gh/1"},
          {"number":3,"state":"OPEN","headRefName":"feat/their","url":"https://gh/3"}
        ]"#;
        let gh = GitHub::with_bins(
            fake_gh_with(dir, authored, reviewer, states, reviewer_states),
            "git",
        );

        let data = fetch_overview_github(&gh, &key()).unwrap();
        assert_eq!(data.me.as_deref(), Some("me"));
        assert_eq!(data.prs.len(), 2, "PR #1 deduped: {:#?}", data.prs);
        let one = data.prs.iter().find(|(p, _)| p.number == 1).unwrap();
        assert_eq!(one.1, ReviewRole::Author, "authored wins the role");
        let three = data.prs.iter().find(|(p, _)| p.number == 3).unwrap();
        assert_eq!(three.1, ReviewRole::Reviewer);
        assert!(
            data.pr_states.is_empty(),
            "every PR came back at full detail, so the cheap tier adds nothing: {:#?}",
            data.pr_states
        );
    }

    /// The regression the two-tier split exists to prevent: a merged PR is no
    /// longer fetched at detail, but its `state` still has to absorb the local
    /// branch and hide it — otherwise every finished-but-undeleted branch
    /// reappears in the default view.
    #[cfg(unix)]
    #[test]
    fn archived_pr_absorbs_its_branch_and_stays_hidden() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        setup_repo(root);
        let store = Store::open(&root.join("store.sqlite3")).unwrap();
        // No open PRs. `feat/spare` exists locally and its PR #9 is merged, so
        // it comes back from the state tier only.
        let empty = "[]";
        let states = r#"[
          {"number":9,"state":"MERGED","headRefName":"feat/spare","url":"https://gh/9"}
        ]"#;
        let gh = GitHub::with_bins(fake_gh_with(root, empty, empty, states, empty), "git");

        // include_archived: the row is built, carries the PR, and is flagged.
        let all = assemble_overview(&store, Some(&gh), root, &key(), true).unwrap();
        let spare = by_branch(&all, "feat/spare");
        assert!(spare.archived, "merged PR ⇒ archived: {spare:#?}");
        assert_eq!(spare.status, Some(ReviewStatus::Merged));
        assert_eq!(spare.pr_number, Some(9), "branch menu still resolves #9");
        assert_eq!(spare.url.as_deref(), Some("https://gh/9"));
        assert_eq!(
            spare.signal, None,
            "the cheap tier fetched no diff stats, so none are claimed"
        );
        assert_eq!(
            all.rows.iter().filter(|r| r.branch == "feat/spare").count(),
            1,
            "the PR row absorbs the branch — no duplicate Branch row: {:#?}",
            all.rows
        );

        // Default view: the DB-5 filter hides it, as it did when the detail
        // tier still fetched merged PRs.
        let view = assemble_overview(&store, Some(&gh), root, &key(), false).unwrap();
        assert!(
            !view.rows.iter().any(|r| r.branch == "feat/spare"),
            "a merged PR's branch must stay hidden: {:#?}",
            view.rows
        );
    }

    /// The signal memo never serves a stale diff: a new commit moves the
    /// branch tip (a new cache key), so the recomputed signal reflects it —
    /// while an untouched branch's signal stays identical across recomputes.
    #[test]
    fn signal_cache_recomputes_when_the_tip_moves() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        setup_repo(root);
        let store = Store::open(&root.join("store.sqlite3")).unwrap();
        store
            .create_review_draft(
                &RepoKey {
                    repo_owner: "octo".into(),
                    repo_name: "stage".into(),
                    branch: "feat/draft".into(),
                },
                "Draft work",
                "main",
            )
            .unwrap();

        let mut cache = SignalCache::default();
        let first = assemble_overview_with(&store, root, &key(), None, false, &mut cache).unwrap();
        let s1 = by_branch(&first, "feat/draft").signal.unwrap();

        // Grow the draft branch: the tip moves, the cache key changes.
        git(root, &["checkout", "-q", "feat/draft"]);
        std::fs::write(root.join("more.rs"), "fn more() {}\nfn lines() {}\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "grow"]);
        git(root, &["checkout", "-q", "main"]);

        let second = assemble_overview_with(&store, root, &key(), None, false, &mut cache).unwrap();
        let s2 = by_branch(&second, "feat/draft").signal.unwrap();
        assert!(
            s2.added > s1.added,
            "the new commit must show up, never a stale cached signal: {s1:?} → {s2:?}"
        );

        // And a third pass with nothing changed serves the same values.
        let third = assemble_overview_with(&store, root, &key(), None, false, &mut cache).unwrap();
        assert_eq!(second, third);
    }

    #[test]
    fn local_only_view_lists_branches_drafts_and_committed_reviews() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        setup_repo(root);
        let store = Store::open(&root.join("store.sqlite3")).unwrap();
        store
            .create_review_draft(
                &RepoKey {
                    repo_owner: "octo".into(),
                    repo_name: "stage".into(),
                    branch: "feat/draft".into(),
                },
                "Draft work",
                "main",
            )
            .unwrap();

        let view = assemble_overview(&store, None, root, &key(), false).unwrap();
        assert!(!view.github_included);

        // Draft: kind Draft, status Draft, signal from the local diff.
        let draft = by_branch(&view, "feat/draft");
        assert_eq!(draft.kind, OverviewKind::Draft);
        assert_eq!(draft.status, Some(ReviewStatus::Draft));
        assert!(draft.signal.is_some_and(|s| s.added > 0));
        assert_eq!(draft.author_login, None, "no gh consulted");
        assert!(draft.branch_meta.is_some(), "local branch meta rides along");

        // Committed `.stage` without gh: Published, pr_number from review.toml,
        // status honestly absent.
        let published = by_branch(&view, "feat/published-stage");
        assert_eq!(published.kind, OverviewKind::Published);
        assert_eq!(published.title, "Published");
        assert_eq!(published.pr_number, Some(1));
        assert_eq!(published.status, None, "status never invented without gh");
        assert!(published.stage_guided);

        // Plain branches: Branch kind; main (checked out here) is current.
        let spare = by_branch(&view, "feat/spare");
        assert_eq!(spare.kind, OverviewKind::Branch);
        assert_eq!(spare.status, None);
        let main = by_branch(&view, "main");
        assert_eq!(main.kind, OverviewKind::Branch);
        assert!(main.branch_meta.as_ref().unwrap().is_current);
        assert!(
            main.branch_meta.as_ref().unwrap().worktree.is_some(),
            "main is checked out on the root worktree"
        );
        // No origin in this repo → no default branch, no branch signals.
        assert_eq!(view.default_branch, None);
        assert_eq!(spare.signal, None);
    }

    #[cfg(unix)]
    #[test]
    fn github_rows_absorb_their_local_branches() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        setup_repo(root);
        let store = Store::open(&root.join("store.sqlite3")).unwrap();
        store
            .create_review_draft(
                &RepoKey {
                    repo_owner: "octo".into(),
                    repo_name: "stage".into(),
                    branch: "feat/draft".into(),
                },
                "Draft work",
                "main",
            )
            .unwrap();
        let gh = GitHub::with_bins(fake_gh(root), "git");

        let view = assemble_overview(&store, Some(&gh), root, &key(), false).unwrap();
        assert!(view.github_included);

        // PR #1 (Stage-guided, mine): one Published row absorbing the branch —
        // no separate Branch row for feat/published-stage.
        let p1 = by_branch(&view, "feat/published-stage");
        assert_eq!(p1.kind, OverviewKind::Published);
        assert_eq!(p1.status, Some(ReviewStatus::Approved));
        assert_eq!(p1.pr_number, Some(1));
        assert!(
            p1.branch_meta.is_some(),
            "worktree/debrief meta rides along"
        );
        assert_eq!(
            view.rows
                .iter()
                .filter(|r| r.branch == "feat/published-stage")
                .count(),
            1,
            "the PR row absorbs the branch: {:#?}",
            view.rows
        );

        // PR #3: reviewer role, branch not local → plain, no branch meta.
        let p3 = by_branch(&view, "feat/their-pr");
        assert_eq!(p3.kind, OverviewKind::PlainPr);
        assert_eq!(p3.role, ReviewRole::Reviewer);
        assert_eq!(p3.branch_meta, None);

        // The draft still surfaces (its branch has no PR), with my login.
        let draft = by_branch(&view, "feat/draft");
        assert_eq!(draft.kind, OverviewKind::Draft);
        assert_eq!(draft.author_login.as_deref(), Some("me"));

        // Untouched branches stay Branch rows.
        assert_eq!(by_branch(&view, "feat/spare").kind, OverviewKind::Branch);
        assert_eq!(by_branch(&view, "feat/plain-pr").kind, OverviewKind::Branch);
    }

    #[test]
    fn worktree_annotations_and_debrief_flags() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        setup_repo(&root);
        let linked = tmp.path().join("repo-draft");
        git(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                linked.to_str().unwrap(),
                "feat/draft",
            ],
        );

        let store = Store::open(&root.join("store.sqlite3")).unwrap();
        store
            .set_debrief(
                &RepoKey {
                    repo_owner: "octo".into(),
                    repo_name: "stage".into(),
                    branch: "feat/draft".into(),
                },
                "main",
                vec![],
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )
            .unwrap();

        let view = assemble_overview(&store, None, &root, &key(), false).unwrap();

        let main = by_branch(&view, "main");
        let main_wt = main
            .branch_meta
            .as_ref()
            .unwrap()
            .worktree
            .as_ref()
            .unwrap();
        assert!(main_wt.is_root);

        let draft = by_branch(&view, "feat/draft");
        let meta = draft.branch_meta.as_ref().unwrap();
        assert!(meta.has_debrief);
        let wt = meta.worktree.as_ref().unwrap();
        assert!(!wt.is_root);
        // Compare canonicalized: git reports `/private/var/...` on macOS where
        // the tempdir handle says `/var/...` (a symlink).
        assert_eq!(
            std::fs::canonicalize(&wt.path).unwrap(),
            std::fs::canonicalize(&linked).unwrap()
        );

        let spare = by_branch(&view, "feat/spare");
        assert_eq!(spare.branch_meta.as_ref().unwrap().worktree, None);
    }

    /// v6-light L2: uncommitted count (Some only with a working tree), changed
    /// file count, debrief freshness, and content-anchored viewed progress +
    /// SHA-bound done state — all derived in the assembly, invalidated by a
    /// moved tip / edited content, never stored as flags.
    #[test]
    fn enrichment_fields_flow_from_store_and_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.email", "t@e.com"]);
        git(&root, &["config", "user.name", "t"]);
        std::fs::write(root.join("base.rs"), "fn base() {}\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "init"]);
        git(&root, &["checkout", "-q", "-b", "feat/enrich"]);
        std::fs::write(root.join("f.rs"), "fn one() {}\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "feat work"]);
        git(&root, &["checkout", "-q", "main"]);
        // Wire origin/HEAD so the assembly has a signal base (origin/main).
        git(&root, &["update-ref", "refs/remotes/origin/main", "main"]);
        git(
            &root,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );

        // The store lives OUTSIDE the repo — its sqlite/-wal/-shm files must
        // not count as untracked entries in the worktree.
        let store = Store::open(&tmp.path().join("store.sqlite3")).unwrap();
        let repo = git2::Repository::open(&root).unwrap();
        let feat_key = RepoKey {
            repo_owner: "octo".into(),
            repo_name: "stage".into(),
            branch: "feat/enrich".into(),
        };
        let feat_tip = repo
            .revparse_single("feat/enrich")
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id()
            .to_string();

        // Debrief at the feat tip; viewed mark anchored to f.rs's tip blob.
        store
            .set_debrief(&feat_key, "main", vec![], &feat_tip)
            .unwrap();
        let f_oid =
            crate::viewed::current_post_image_oid(&repo, None, "feat/enrich", "f.rs").unwrap();
        store.set_viewed(&feat_key, "f.rs", &f_oid).unwrap();
        // Dirty the root worktree (main): one modified tracked file, one
        // untracked file.
        std::fs::write(root.join("base.rs"), "fn base() { /* edited */ }\n").unwrap();
        std::fs::write(root.join("junk.txt"), "scratch\n").unwrap();

        let mut cache = SignalCache::default();
        let view = assemble_overview_with(&store, &root, &key(), None, false, &mut cache).unwrap();

        let main_meta = by_branch(&view, "main").branch_meta.clone().unwrap();
        assert_eq!(main_meta.uncommitted_count, Some(2), "modified + untracked");
        assert_eq!(
            main_meta.changed_file_count, None,
            "the default branch has no base to compare against"
        );
        assert_eq!(main_meta.self_review, None);
        assert_eq!(main_meta.debrief_freshness, None);
        assert!(!main_meta.has_debrief);

        let feat_meta = by_branch(&view, "feat/enrich").branch_meta.clone().unwrap();
        assert_eq!(
            feat_meta.uncommitted_count, None,
            "no working tree — absent, never a fake 0"
        );
        assert_eq!(feat_meta.changed_file_count, Some(1));
        assert_eq!(feat_meta.debrief_freshness, Some(DebriefFreshness::New));
        assert!(feat_meta.has_debrief);
        assert_eq!(
            feat_meta.self_review,
            Some(SelfReviewProgress {
                viewed: 1,
                total: 1,
                notes: 0,
            })
        );

        // Seen flips the chip.
        store.mark_debrief_seen(&feat_key).unwrap();
        let view = assemble_overview_with(&store, &root, &key(), None, false, &mut cache).unwrap();
        assert_eq!(
            by_branch(&view, "feat/enrich")
                .branch_meta
                .as_ref()
                .unwrap()
                .debrief_freshness,
            Some(DebriefFreshness::Seen)
        );

        // Move the tip with new content for f.rs: the debrief goes outdated,
        // the viewed anchor no longer matches (F2b).
        git(&root, &["checkout", "-q", "feat/enrich"]);
        std::fs::write(root.join("f.rs"), "fn one() {}\nfn two() {}\n").unwrap();
        // Only f.rs — the dirty main-worktree files ride along the checkout
        // and must stay uncommitted.
        git(&root, &["add", "f.rs"]);
        git(&root, &["commit", "-q", "-m", "more work"]);
        git(&root, &["checkout", "-q", "main"]);

        let view = assemble_overview_with(&store, &root, &key(), None, false, &mut cache).unwrap();
        let feat_meta = by_branch(&view, "feat/enrich").branch_meta.clone().unwrap();
        assert_eq!(
            feat_meta.debrief_freshness,
            Some(DebriefFreshness::Outdated)
        );
        assert_eq!(
            feat_meta.self_review,
            Some(SelfReviewProgress {
                viewed: 0,
                total: 1,
                notes: 0,
            }),
            "edited content invalidates the mark"
        );

        // A note is the other "started" signal: no file is viewed any more,
        // but the branch has been worked on and the row must say so.
        store
            .create_note(&feat_key, "n1", None, "needs a second look")
            .unwrap();
        let view = assemble_overview_with(&store, &root, &key(), None, false, &mut cache).unwrap();
        assert_eq!(
            by_branch(&view, "feat/enrich")
                .branch_meta
                .as_ref()
                .unwrap()
                .self_review,
            Some(SelfReviewProgress {
                viewed: 0,
                total: 1,
                notes: 1,
            }),
            "a note counts as started even with nothing viewed"
        );
    }
}
