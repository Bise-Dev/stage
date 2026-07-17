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

use serde::Serialize;
use ts_rs::TS;

use crate::diff::diff_stats;
use crate::domain::Review;
use crate::error::StageError;
use crate::github::{GitHub, PrFilter};
use crate::repo_key::RepoKey;
use crate::review_folder::{read_review_from_tree, StageReview};
use crate::status::{is_archived, status_from_pr, ReviewRole, ReviewSignal, ReviewStatus};
use crate::store::Store;
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
    /// ± lines (+ comments). `None` when there is no comparable base (e.g. the
    /// default branch itself, or no merge base) — absent, not `0/0`.
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
    updated_at: i64,
    last_commit: Option<String>,
}

/// Assemble the unified overview. With `github: Some`, any `gh` failure fails
/// the whole call (fail loud — the caller may re-ask with `None` and surface
/// the error next to the local view). `include_archived` flips the DB-5 filter.
pub fn assemble_overview(
    store: &Store,
    github: Option<&GitHub>,
    repo_root: &Path,
    repo_key: &RepoKey,
    include_archived: bool,
) -> Result<OverviewView, StageError> {
    let repo = git2::Repository::discover(repo_root)
        .map_err(|_| StageError::NotARepo(repo_root.to_path_buf()))?;

    // Local facts first: branches, worktrees, debriefs, the default base.
    let branches = local_branches(&repo)?;
    let worktrees = list_worktrees(repo_root)?;
    let debriefs: HashSet<String> = store
        .list_debrief_branches(&repo_key.repo_owner, &repo_key.repo_name)?
        .into_iter()
        .collect();
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
        meta_by_branch.insert(
            b.name.clone(),
            BranchMeta {
                is_current: b.is_head,
                is_default: default_branch.as_deref() == Some(b.name.as_str()),
                has_debrief: debriefs.contains(&b.name),
                updated_at: b.updated_at,
                last_commit: b.last_commit.clone(),
                worktree: wt,
            },
        );
    }

    let mut rows: Vec<OverviewRow> = Vec::new();

    // --- Source 2 (when included): my PRs via `gh` search --------------------
    let mut pr_heads: HashSet<String> = HashSet::new();
    if let Some(gh) = github {
        let repo_slug = format!("{}/{}", repo_key.repo_owner, repo_key.repo_name);
        let authored = gh.list_repo_prs(&repo_slug, PrFilter::Authored)?;
        let review_requested = gh.list_repo_prs(&repo_slug, PrFilter::ReviewRequested)?;

        let mut seen_numbers: HashSet<u32> = HashSet::new();
        for (pr, role) in authored
            .iter()
            .map(|p| (p, ReviewRole::Author))
            .chain(review_requested.iter().map(|p| (p, ReviewRole::Reviewer)))
        {
            if !seen_numbers.insert(pr.number) {
                continue; // deduped — authored ordering wins over review-requested
            }
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
                    comments: pr.comments,
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
    }

    // --- Source 1: pre-publish drafts (this machine) -------------------------
    let me = github
        .map(|gh| gh.current_user())
        .transpose()?
        .map(|u| u.login);
    let mut draft_heads: HashSet<String> = HashSet::new();
    for draft in store.list_review_drafts(&repo_key.repo_owner, &repo_key.repo_name)? {
        if pr_heads.contains(&draft.head_ref) {
            continue; // published — the PR row subsumes it
        }
        // Accepted DB-1 risk: a draft only appears for a branch present in this
        // clone (documented per-machine behaviour, mirrors the dashboard).
        let Some(signal) = draft_signal(repo_root, &draft)? else {
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
                signal: branch_signal(&repo, signal_base.as_deref(), &b.name)?,
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
                branch_signal(&repo, signal_base.as_deref(), &b.name)?
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
/// the overview or fake a size. Comment count is 0 — a draft has no PR thread.
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

/// ± lines for a plain branch vs. the repo's default base. `Ok(None)` when there
/// is no comparable base — no default resolved, or no merge base (an orphan /
/// unrelated-history branch): that is a legitimate absence of a signal, not a
/// failure to hide. A genuine diff failure on comparable refs propagates.
fn branch_signal(
    repo: &git2::Repository,
    base: Option<&str>,
    branch: &str,
) -> Result<Option<ReviewSignal>, StageError> {
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
    Ok(Some(ReviewSignal {
        added: stats.insertions() as u32,
        removed: stats.deletions() as u32,
        comments: 0,
    }))
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
    #[cfg(unix)]
    fn fake_gh(dir: &Path) -> std::path::PathBuf {
        let authored = r#"[
          {"number":1,"title":"Published","state":"OPEN","url":"https://gh/1","headRefName":"feat/published-stage","baseRefName":"main","isDraft":false,"additions":5,"deletions":2,"reviewDecision":"APPROVED","author":{"login":"me"},"comments":[{}]}
        ]"#;
        let reviewer = r#"[
          {"number":3,"title":"Their PR","state":"OPEN","url":"https://gh/3","headRefName":"feat/their-pr","baseRefName":"main","isDraft":false,"additions":7,"deletions":1,"reviewDecision":"","author":{"login":"them"},"comments":[{},{}]}
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

    fn by_branch<'a>(view: &'a OverviewView, b: &str) -> &'a OverviewRow {
        view.rows
            .iter()
            .find(|r| r.branch == b)
            .unwrap_or_else(|| panic!("no row for {b}: {:#?}", view.rows))
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
}
