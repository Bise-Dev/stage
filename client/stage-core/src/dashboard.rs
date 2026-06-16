//! The per-repo dashboard (DB-1..5 #84–88, WS-5 #63) — ADR-0022 §6/§7.
//!
//! One view-ready list assembled from **two sources**, entirely in Rust (TS only
//! renders):
//!
//! 1. a scan of the local store for **pre-publish drafts** (this machine only,
//!    [`Store::list_review_drafts`]), and
//! 2. a **`gh` search** for my open/closed/merged PRs — authored or
//!    review-requested ([`GitHub::list_repo_prs`]).
//!
//! Every row carries **derived** state (WS-5): status, signal, the Stage-vs-plain
//! flag, and whether it is archived — none of it stored. Access is whatever the
//! user's `gh` + local clones already grant (DB-4); there is no separate ACL.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;
use ts_rs::TS;

use crate::diff::diff_stats;
use crate::domain::Review;
use crate::error::StageError;
use crate::github::{GhPullRequest, GitHub, PrFilter};
use crate::repo_key::RepoKey;
use crate::review_folder::review_committed_for_branch;
use crate::store::Store;

/// The derived status of a dashboard entry (WS-5 #63). Computed from real state —
/// a local draft, the PR's `state`, its `reviewDecision` — and **never stored**.
/// There is no manual "archive": a closed/merged PR reflects automatically, and
/// reopening it restores the active status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ReviewStatus {
    /// A pre-publish local draft (Ready-to-share); no PR exists yet.
    Draft,
    /// PR open, no review decision yet.
    Open,
    /// PR open, a reviewer approved.
    Approved,
    /// PR open, a reviewer requested changes.
    ChangesRequested,
    /// PR merged.
    Merged,
    /// PR closed without merging.
    Closed,
}

/// Whether an entry is mine or waiting on my review (DB-1 #84 / DB-3 #86).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ReviewRole {
    /// I opened it (or it's my local draft).
    Author,
    /// My review was requested — surfaced even if the author skipped Stage (DB-3).
    Reviewer,
}

/// The at-a-glance signal for a row (DB-2 #85): diff size + comment volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewSignal {
    pub added: u32,
    pub removed: u32,
    pub comments: u32,
}

/// One dashboard entry — a per-machine pre-publish draft or a GitHub PR I author
/// or am asked to review, with all of its state already derived (ADR-0022 §7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DashboardRow {
    /// Review title — the draft title, or the PR title once published.
    pub title: String,
    /// The branch the change rides on — the Review's authoritative identity.
    pub branch: String,
    /// The branch it's composed against (e.g. `origin/main`).
    pub base_ref: String,
    /// Derived status (WS-5) — never stored.
    pub status: ReviewStatus,
    /// Mine vs. awaiting my review.
    pub role: ReviewRole,
    /// Diff size + comment count.
    pub signal: ReviewSignal,
    /// `true` for a Stage-guided change — a local draft, or a PR whose head
    /// carries a committed `.stage/<branch>/` — vs. a plain PR (DB-2 #85).
    pub stage_guided: bool,
    /// `true` for a closed/merged PR (DB-5 #88). Hidden by the default view; a
    /// computed view-property, not stored state.
    pub archived: bool,
    /// The GitHub PR number once published; `None` for a pre-publish draft.
    pub pr_number: Option<u32>,
    /// The PR's GitHub URL; `None` for a pre-publish draft (no PR yet).
    pub url: Option<String>,
    /// The change author's GitHub login.
    pub author_login: String,
}

/// The assembled per-repo dashboard (DB-1 #84): the local-store draft scan merged
/// with the `gh` PR search, every row's state derived in Rust. TS only renders
/// this (ADR-0022 §7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DashboardView {
    pub rows: Vec<DashboardRow>,
}

/// Assemble the per-repo dashboard (DB-1..5, WS-5). Merges the local draft scan
/// with the `gh` PR search and derives every row's state. With `include_archived`
/// false (the default view, DB-5) closed/merged PRs are dropped; flip it to see
/// them — the filter is computed here, never persisted.
///
/// Fail loud: a missing/unauthenticated `gh`, a failed `gh`/`git` call, or an
/// unreadable local diff fail the whole call (the real cause surfaced) — never a
/// partial list that hides which rows are missing.
pub fn assemble_dashboard(
    store: &Store,
    github: &GitHub,
    repo_root: &Path,
    repo_key: &RepoKey,
    include_archived: bool,
) -> Result<DashboardView, StageError> {
    let repo_slug = format!("{}/{}", repo_key.repo_owner, repo_key.repo_name);

    // Identity: the `gh` token owner. Also the author of every local draft —
    // drafts are single-writer, this machine, this user (ADR-0022 §3/§5).
    let me = github.current_user()?.login;

    // --- Source 2: my PRs in this repo (gh search) ----------------------------
    // Two queries (authored, review-requested), merged by PR number; the Author
    // role wins when a PR is both mine and assigned to me to review.
    let authored = github.list_repo_prs(&repo_slug, PrFilter::Authored)?;
    let review_requested = github.list_repo_prs(&repo_slug, PrFilter::ReviewRequested)?;

    let mut pr_rows: Vec<DashboardRow> = Vec::new();
    let mut pr_head_refs: HashSet<String> = HashSet::new();
    let mut seen_numbers: HashSet<u32> = HashSet::new();
    for (pr, role) in authored
        .iter()
        .map(|p| (p, ReviewRole::Author))
        .chain(review_requested.iter().map(|p| (p, ReviewRole::Reviewer)))
    {
        if !seen_numbers.insert(pr.number) {
            continue; // already added — authored ordering wins over review-requested
        }
        pr_head_refs.insert(pr.head_ref_name.clone());
        let status = status_from_pr(pr);
        // Checkout-free probe: is `.stage/<branch>/` committed at the PR head?
        let stage_guided = review_committed_for_branch(repo_root, &pr.head_ref_name)?;
        pr_rows.push(DashboardRow {
            title: pr.title.clone(),
            branch: pr.head_ref_name.clone(),
            base_ref: pr.base_ref_name.clone(),
            archived: is_archived(status),
            status,
            role,
            signal: ReviewSignal {
                added: pr.additions,
                removed: pr.deletions,
                comments: pr.comments,
            },
            stage_guided,
            pr_number: Some(pr.number),
            url: Some(pr.url.clone()),
            author_login: pr.author.login.clone(),
        });
    }

    // --- Source 1: pre-publish drafts in the local store (this machine) -------
    // A draft whose branch already has a PR is subsumed by that PR row (it has
    // been published); only branches with no PR surface as their own Draft row.
    let mut draft_rows: Vec<DashboardRow> = Vec::new();
    for draft in store.list_review_drafts(&repo_key.repo_owner, &repo_key.repo_name)? {
        if pr_head_refs.contains(&draft.head_ref) {
            continue;
        }
        // Accepted risk (DB-1): a draft appears only for a branch present in this
        // clone. If its branch ref is gone, we can't size its diff — skip it (a
        // documented per-machine behaviour) rather than fail the whole dashboard
        // or invent a size.
        let Some(signal) = draft_signal(repo_root, &draft)? else {
            tracing::debug!(
                branch = %draft.head_ref,
                "dashboard_draft_branch_absent: skipped (not present in this clone)"
            );
            continue;
        };
        draft_rows.push(DashboardRow {
            title: draft.title.clone(),
            branch: draft.head_ref.clone(),
            base_ref: draft.base_ref.clone(),
            status: ReviewStatus::Draft,
            role: ReviewRole::Author, // a draft is author-only, on this machine
            signal,
            stage_guided: true, // a draft is inherently a Stage review
            archived: false,    // a draft is never archived
            pr_number: None,
            url: None,
            author_login: me.clone(),
        });
    }

    // Drafts first (your in-progress work), then PRs — "what to act on next".
    let mut rows = draft_rows;
    rows.extend(pr_rows);

    // DB-5 #88: archived (closed/merged) hidden by default; a *view* filter only.
    if !include_archived {
        rows.retain(|r| !r.archived);
    }

    Ok(DashboardView { rows })
}

/// Derive a PR's status (WS-5) from gh's `state` + `reviewDecision`. Merged/closed
/// win over any review decision; an open PR reflects its decision, else `Open`.
fn status_from_pr(pr: &GhPullRequest) -> ReviewStatus {
    match pr.state.as_str() {
        "MERGED" => ReviewStatus::Merged,
        "CLOSED" => ReviewStatus::Closed,
        // "OPEN" (and any unexpected state): reflect the review decision.
        _ => match pr.review_decision.as_str() {
            "APPROVED" => ReviewStatus::Approved,
            "CHANGES_REQUESTED" => ReviewStatus::ChangesRequested,
            // "" (none) or "REVIEW_REQUIRED": open, awaiting a verdict.
            _ => ReviewStatus::Open,
        },
    }
}

/// A closed/merged PR is archived (DB-5) — derived from status, never stored.
fn is_archived(status: ReviewStatus) -> bool {
    matches!(status, ReviewStatus::Merged | ReviewStatus::Closed)
}

/// The ±lines signal for a pre-publish draft, from its branch's committed diff
/// vs. its base. `Ok(None)` when the branch isn't present in this clone (the
/// accepted DB-1 per-machine risk) so the caller skips the row rather than fail
/// the dashboard or fake a size. Comment count is 0 — a draft has no PR thread.
fn draft_signal(repo_root: &Path, draft: &Review) -> Result<Option<ReviewSignal>, StageError> {
    if !branch_present(repo_root, &draft.head_ref)? {
        return Ok(None);
    }
    let stats = diff_stats(repo_root, &draft.base_ref, &draft.head_ref)?;
    Ok(Some(ReviewSignal {
        added: stats.added as u32,
        removed: stats.removed as u32,
        comments: 0,
    }))
}

/// Whether `branch` (or its `origin/<branch>`) resolves in this clone.
fn branch_present(repo_root: &Path, branch: &str) -> Result<bool, StageError> {
    let repo = git2::Repository::discover(repo_root)?;
    Ok([branch.to_string(), format!("origin/{branch}")]
        .iter()
        .any(|r| repo.revparse_single(r).is_ok()))
}

#[cfg(test)]
mod tests {
    use super::*;
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

    /// An executable fake-`gh` script (unix-only — CI/dev are macOS/Linux),
    /// dispatching on its args. Mirrors `github.rs`'s test harness.
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

    /// A repo with: `main` (one commit), `feat/published-stage` (a committed
    /// `.stage/` folder — a Stage-guided PR head), `feat/plain-pr` (a plain code
    /// change, no `.stage`), and `feat/draft` (a code change for a local draft).
    /// `feat/their-pr` is deliberately **absent** (an un-fetched reviewer branch).
    fn setup_repo(root: &Path) {
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.email", "t@e.com"]);
        git(root, &["config", "user.name", "t"]);
        std::fs::write(root.join("base.rs"), "fn base() {}\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "init"]);

        // A published Stage PR head: `.stage/feat-published-stage/` is committed.
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

        // A plain PR head: a code change, no `.stage`.
        git(root, &["checkout", "-q", "main"]);
        git(root, &["checkout", "-q", "-b", "feat/plain-pr"]);
        std::fs::write(root.join("plain.rs"), "fn plain() {}\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "plain change"]);

        // A draft branch: a code change so the draft has a non-zero ±lines signal.
        git(root, &["checkout", "-q", "main"]);
        git(root, &["checkout", "-q", "-b", "feat/draft"]);
        std::fs::write(root.join("draft.rs"), "fn draft() {}\nfn more() {}\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "draft change"]);
        git(root, &["checkout", "-q", "main"]);
    }

    /// A fake `gh` returning fixtures for `api user` and the two `pr list`
    /// queries. PR #1 appears in **both** lists (to exercise the dedupe +
    /// role-precedence). The reviewer branch `feat/their-pr` is not in the repo.
    #[cfg(unix)]
    fn fake_gh(dir: &Path) -> std::path::PathBuf {
        let authored = r#"[
          {"number":1,"title":"Published","state":"OPEN","url":"https://gh/1","headRefName":"feat/published-stage","baseRefName":"main","isDraft":false,"additions":5,"deletions":2,"reviewDecision":"APPROVED","author":{"login":"me"},"comments":[{}]},
          {"number":2,"title":"Plain merged","state":"MERGED","url":"https://gh/2","headRefName":"feat/plain-pr","baseRefName":"main","isDraft":false,"additions":3,"deletions":0,"reviewDecision":"","author":{"login":"me"},"comments":[]}
        ]"#;
        let reviewer = r#"[
          {"number":1,"title":"Published","state":"OPEN","url":"https://gh/1","headRefName":"feat/published-stage","baseRefName":"main","isDraft":false,"additions":5,"deletions":2,"reviewDecision":"APPROVED","author":{"login":"me"},"comments":[{}]},
          {"number":3,"title":"Their PR","state":"OPEN","url":"https://gh/3","headRefName":"feat/their-pr","baseRefName":"main","isDraft":false,"additions":7,"deletions":1,"reviewDecision":"CHANGES_REQUESTED","author":{"login":"them"},"comments":[{},{}]}
        ]"#;
        std::fs::write(dir.join("authored.json"), authored).unwrap();
        std::fs::write(dir.join("reviewer.json"), reviewer).unwrap();
        let authored_path = dir.join("authored.json").to_string_lossy().into_owned();
        let reviewer_path = dir.join("reviewer.json").to_string_lossy().into_owned();
        let body = format!(
            "#!/usr/bin/env bash\n\
             if [ \"$1\" = auth ] && [ \"$2\" = status ]; then exit 0; fi\n\
             if [ \"$1\" = api ] && [ \"$2\" = user ]; then echo '{{\"login\":\"me\",\"id\":1,\"name\":\"Me\"}}'; exit 0; fi\n\
             case \"$*\" in\n\
               *review-requested*) cat {reviewer_path:?} ;;\n\
               *) cat {authored_path:?} ;;\n\
             esac\n\
             exit 0\n",
        );
        write_script(dir, "gh", &body)
    }

    #[cfg(unix)]
    #[test]
    fn assemble_merges_drafts_and_prs_with_derived_state() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        setup_repo(root);

        let store = Store::open(&root.join("store.sqlite3")).unwrap();
        // A local draft on feat/draft (no PR) — should surface as a Draft row.
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

        // Default view (archived hidden): draft + PR #1 (approved) + PR #3
        // (changes requested). PR #2 is merged → hidden.
        let view = assemble_dashboard(&store, &gh, root, &key(), false).unwrap();
        let by_branch = |b: &str| {
            view.rows
                .iter()
                .find(|r| r.branch == b)
                .unwrap_or_else(|| panic!("no row for {b}"))
        };

        assert_eq!(
            view.rows.len(),
            3,
            "merged + archived-hidden: {:#?}",
            view.rows
        );

        // The local draft: Draft status, author role, inherently Stage-guided,
        // ±lines from the local diff, no PR.
        let draft = by_branch("feat/draft");
        assert_eq!(draft.status, ReviewStatus::Draft);
        assert_eq!(draft.role, ReviewRole::Author);
        assert!(draft.stage_guided);
        assert!(!draft.archived);
        assert_eq!(draft.pr_number, None);
        assert_eq!(draft.url, None);
        assert_eq!(draft.author_login, "me");
        assert!(draft.signal.added > 0, "draft signal sized from local diff");
        assert_eq!(draft.signal.comments, 0);

        // PR #1: published Stage PR, approved, mine. Dedup across both queries →
        // one row, Author role wins.
        let p1 = by_branch("feat/published-stage");
        assert_eq!(p1.status, ReviewStatus::Approved);
        assert_eq!(p1.role, ReviewRole::Author);
        assert!(
            p1.stage_guided,
            "committed .stage at the head ⇒ Stage-guided"
        );
        assert!(!p1.archived);
        assert_eq!(p1.pr_number, Some(1));
        assert_eq!(p1.url.as_deref(), Some("https://gh/1"));
        assert_eq!(
            p1.signal,
            ReviewSignal {
                added: 5,
                removed: 2,
                comments: 1
            }
        );
        assert_eq!(
            view.rows.iter().filter(|r| r.pr_number == Some(1)).count(),
            1,
            "PR #1 is deduped across the two queries"
        );

        // PR #3: a reviewer PR for a branch not in this clone, author skipped
        // Stage ⇒ plain. Surfaced anyway (DB-3).
        let p3 = by_branch("feat/their-pr");
        assert_eq!(p3.status, ReviewStatus::ChangesRequested);
        assert_eq!(p3.role, ReviewRole::Reviewer);
        assert!(!p3.stage_guided, "no local .stage ⇒ plain");
        assert_eq!(p3.author_login, "them");
        assert_eq!(p3.signal.comments, 2);

        // PR #2 (merged) is archived → hidden by default.
        assert!(
            !view.rows.iter().any(|r| r.pr_number == Some(2)),
            "archived merged PR hidden by default"
        );
    }

    #[cfg(unix)]
    #[test]
    fn include_archived_surfaces_closed_and_merged() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        setup_repo(root);
        let store = Store::open(&root.join("store.sqlite3")).unwrap();
        let gh = GitHub::with_bins(fake_gh(root), "git");

        let view = assemble_dashboard(&store, &gh, root, &key(), true).unwrap();
        let merged = view
            .rows
            .iter()
            .find(|r| r.pr_number == Some(2))
            .expect("merged PR visible when archived included");
        assert_eq!(merged.status, ReviewStatus::Merged);
        assert!(merged.archived);
        assert!(!merged.stage_guided, "plain merged PR");
    }

    #[test]
    fn status_derivation_covers_each_state() {
        let mk = |state: &str, decision: &str| GhPullRequest {
            number: 1,
            title: "t".into(),
            state: state.into(),
            url: "u".into(),
            head_ref_name: "b".into(),
            base_ref_name: "main".into(),
            is_draft: false,
            additions: 0,
            deletions: 0,
            review_decision: decision.into(),
            author: crate::github::GhAuthor { login: "me".into() },
            comments: 0,
        };
        assert_eq!(status_from_pr(&mk("MERGED", "")), ReviewStatus::Merged);
        assert_eq!(status_from_pr(&mk("CLOSED", "")), ReviewStatus::Closed);
        assert_eq!(
            status_from_pr(&mk("OPEN", "APPROVED")),
            ReviewStatus::Approved
        );
        assert_eq!(
            status_from_pr(&mk("OPEN", "CHANGES_REQUESTED")),
            ReviewStatus::ChangesRequested
        );
        assert_eq!(
            status_from_pr(&mk("OPEN", "REVIEW_REQUIRED")),
            ReviewStatus::Open
        );
        assert_eq!(status_from_pr(&mk("OPEN", "")), ReviewStatus::Open);
        // Merged/closed win even if a decision is present.
        assert_eq!(
            status_from_pr(&mk("MERGED", "APPROVED")),
            ReviewStatus::Merged
        );

        assert!(is_archived(ReviewStatus::Merged));
        assert!(is_archived(ReviewStatus::Closed));
        assert!(!is_archived(ReviewStatus::Approved));
        assert!(!is_archived(ReviewStatus::Draft));
    }
}
