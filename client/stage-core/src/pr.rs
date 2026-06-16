//! PR review activity, verdicts & actions (milestone E — RW-1..5, ADR-0022
//! §5/§8).
//!
//! GitHub is the source of truth: review comments, verdicts and PR actions are
//! recorded as **native GitHub activity**, with **no Stage-only copy** of review
//! state (RW-1). Every operation here writes through to GitHub immediately on
//! submit (immediate write-through) — there is no local draft of a verdict.
//!
//! This module is built on the `gh` runners in [`crate::github`]: it adds the
//! typed feature commands the reviewer drives, while [`crate::github`] owns the
//! credential-free primitives, the auth gate and identity. Reads go through
//! `gh pr view --json …` / `gh api`; writes through the GitHub REST API via
//! `gh api` (the Reviews endpoint over stdin for a verdict + bundled comments;
//! the pull-comments endpoint for a standalone line/file comment); PR actions
//! through `gh pr merge|close|ready`.
//!
//! **Fail loud (CLAUDE.md):** nothing is swallowed or defaulted. A `gh` failure
//! surfaces GitHub's own message verbatim ([`StageError::GhFailed`]); a domain
//! rule we can check up front (a request-changes/comment verdict with no body)
//! fails as [`StageError::Invalid`] with a complete, user-facing sentence.
//!
//! **Terminology (ADR-0022 §8):** the approve / request-changes / comment
//! decision is the **verdict**; the bare noun "review" is the Stage artifact
//! (see [`crate::review_folder`]). The PR/diff is assumed already open — the
//! reviewer open-by-PR entry path is milestone F.
//!
//! **Rust computes, TS renders (ADR-0022 §7):** the heterogeneous, wire-shaped
//! `gh`/REST JSON is normalized here into the view-ready DTOs below (e.g. the
//! mixed CheckRun/StatusContext rollup collapses to one [`CheckStatus`]); the
//! webview receives these ts-rs types and only renders them.

use std::path::Path;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::domain::Side;
use crate::error::StageError;
use crate::github::GitHub;

/// The fields read off a PR in one `gh pr view --json …` call (RW-4).
const PR_VIEW_FIELDS: &str = "number,title,url,state,isDraft,reviewDecision,\
                             baseRefName,headRefName,reviews,comments,statusCheckRollup";

// ---------------------------------------------------------------------------
// Public DTOs (the ts-rs contract — Rust computes, TS renders)
// ---------------------------------------------------------------------------

/// The overall review decision the reviewer submits (RW-3, ADR-0022 §8). Maps to
/// the GitHub Reviews API `event`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Verdict {
    /// Approve the PR.
    Approve,
    /// Request changes — requires a body explaining what to change.
    RequestChanges,
    /// Comment without an approval state — requires a body.
    Comment,
}

impl Verdict {
    /// The GitHub Reviews API `event` value.
    fn event(self) -> &'static str {
        match self {
            Verdict::Approve => "APPROVE",
            Verdict::RequestChanges => "REQUEST_CHANGES",
            Verdict::Comment => "COMMENT",
        }
    }

    /// GitHub requires a non-empty body for `REQUEST_CHANGES` and `COMMENT`
    /// (only `APPROVE` may have an empty body). We check this up front so the
    /// user gets a clear message instead of a raw 422.
    fn requires_body(self) -> bool {
        matches!(self, Verdict::RequestChanges | Verdict::Comment)
    }

    /// Human label for the up-front "needs a body" error.
    fn label(self) -> &'static str {
        match self {
            Verdict::Approve => "approve",
            Verdict::RequestChanges => "request changes",
            Verdict::Comment => "comment",
        }
    }
}

/// How a PR is merged (RW-5). Maps to the `gh pr merge` method flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MergeMethod {
    /// `--merge`: a merge commit.
    Merge,
    /// `--squash`: squash the commits into one.
    Squash,
    /// `--rebase`: rebase the commits onto the base.
    Rebase,
}

impl MergeMethod {
    fn flag(self) -> &'static str {
        match self {
            MergeMethod::Merge => "--merge",
            MergeMethod::Squash => "--squash",
            MergeMethod::Rebase => "--rebase",
        }
    }
}

/// A line comment to attach to the diff (RW-2), and the per-comment shape bundled
/// into a verdict (RW-3). Anchored to a diff **line** (file-level comments use
/// [`GitHub::comment_on_file`]); `side` defaults to the new file (`RIGHT`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DraftLineComment {
    /// Repo-relative path of the file in the diff.
    pub path: String,
    /// The line in the diff to anchor to (the end line for a multi-line range).
    pub line: u32,
    /// Which diff side the line is on; `None` → the new file (`RIGHT`).
    #[serde(default)]
    pub side: Option<Side>,
    /// First line of a multi-line range; `None` for a single-line comment.
    #[serde(default)]
    pub start_line: Option<u32>,
    /// Side of `start_line`; `None` → same as `side`. Only used with a range.
    #[serde(default)]
    pub start_side: Option<Side>,
    /// The comment body (markdown).
    pub body: String,
}

/// The result of submitting a verdict (RW-3): GitHub's created review id and the
/// resulting review state (`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SubmittedVerdict {
    /// GitHub's numeric review id. Crosses the JSON IPC boundary as a JS
    /// `number` (ts-rs would otherwise emit `bigint` for a 64-bit int).
    #[ts(type = "number")]
    pub id: u64,
    /// The review state GitHub recorded for this verdict.
    pub state: String,
}

/// A single inline review comment on the PR (RW-2 write result and RW-4 read).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LineComment {
    /// GitHub's numeric comment id.
    #[ts(type = "number")]
    pub id: u64,
    /// Repo-relative path of the commented file.
    pub path: String,
    /// The anchored line, if the comment still maps to one (`None` for a
    /// file-level or outdated comment).
    pub line: Option<u32>,
    /// `LEFT` / `RIGHT`, verbatim from GitHub, when the comment is line-anchored.
    pub side: Option<String>,
    /// The comment body (markdown).
    pub body: String,
    /// The comment author's GitHub login.
    pub author: String,
    /// The comment's URL on github.com.
    pub url: String,
}

/// One overall review (verdict) on the PR (RW-4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewSummary {
    /// The reviewer's GitHub login.
    pub author: String,
    /// `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` / `DISMISSED` / `PENDING`.
    pub state: String,
    /// The review body (markdown), possibly empty.
    pub body: String,
    /// When the review was submitted (ISO 8601), if submitted.
    pub submitted_at: Option<String>,
}

/// A top-level PR (issue) comment — the conversation thread, distinct from inline
/// review comments (RW-4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IssueComment {
    /// The comment author's GitHub login.
    pub author: String,
    /// The comment body (markdown).
    pub body: String,
    /// When the comment was created (ISO 8601), if known.
    pub created_at: Option<String>,
    /// The comment's URL on github.com.
    pub url: String,
    /// Whether the `gh` token owner authored it (powers "edit/delete own",
    /// milestone IC).
    pub viewer_did_author: bool,
}

/// A normalized CI status for one check (RW-4). GitHub's status rollup mixes
/// `CheckRun` (a `status` + `conclusion`) and `StatusContext` (a single `state`);
/// this collapses both into one value the webview renders directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CheckStatus {
    /// Passed (`SUCCESS` / `EXPECTED`).
    Success,
    /// Failed (`FAILURE` / `ERROR` / `TIMED_OUT` / `STARTUP_FAILURE` /
    /// `ACTION_REQUIRED`).
    Failure,
    /// Still running or queued (not yet completed).
    Pending,
    /// Completed with a neutral conclusion.
    Neutral,
    /// Skipped or stale.
    Skipped,
    /// Cancelled.
    Cancelled,
    /// An unrecognized status — surfaced rather than hidden (fail loud).
    Unknown,
}

/// One CI check on the PR head (RW-4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CheckResult {
    /// The check name (a CheckRun `name`, else a StatusContext `context`).
    pub name: String,
    /// The normalized status.
    pub status: CheckStatus,
    /// A link to the check's details, if any.
    pub url: Option<String>,
}

/// Everything the reviewer reads about a PR's existing activity in one shot
/// (RW-4): its state, the review **verdict** decision, the overall reviews, the
/// conversation comments, the inline line comments, and the CI checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PrActivity {
    /// The PR number.
    pub number: u32,
    /// The PR title.
    pub title: String,
    /// The PR's URL on github.com.
    pub url: String,
    /// `OPEN` / `CLOSED` / `MERGED`.
    pub state: String,
    /// Whether the PR is a draft (RW-5 toggles this).
    pub is_draft: bool,
    /// The aggregate review decision: `APPROVED` / `CHANGES_REQUESTED` /
    /// `REVIEW_REQUIRED`, or `None` when GitHub reports none. This is what the UI
    /// shows to reflect the PR's verdict.
    pub review_decision: Option<String>,
    /// The base branch (e.g. `main`).
    pub base_ref: String,
    /// The head branch.
    pub head_ref: String,
    /// Overall reviews (verdicts) in GitHub's order.
    pub reviews: Vec<ReviewSummary>,
    /// Top-level conversation comments.
    pub issue_comments: Vec<IssueComment>,
    /// Inline review (line/file) comments.
    pub line_comments: Vec<LineComment>,
    /// CI checks on the PR head.
    pub checks: Vec<CheckResult>,
}

// ---------------------------------------------------------------------------
// Feature commands (built on the `gh` runners in `github.rs`)
// ---------------------------------------------------------------------------

impl GitHub {
    /// Submit an overall **verdict** on PR `pr`, optionally bundling inline line
    /// comments (RW-3). Recorded immediately as a native GitHub review via the
    /// Reviews API (`POST …/pulls/{n}/reviews`, payload on stdin so the nested
    /// `comments` array round-trips). A request-changes/comment verdict with no
    /// body fails loud up front. `repo_dir` scopes `gh` to the right repo.
    pub fn submit_verdict(
        &self,
        repo_dir: &Path,
        pr: u32,
        verdict: Verdict,
        body: &str,
        comments: &[DraftLineComment],
    ) -> Result<SubmittedVerdict, StageError> {
        if verdict.requires_body() && body.trim().is_empty() {
            return Err(StageError::Invalid(format!(
                "A “{}” verdict needs a comment explaining it.",
                verdict.label()
            )));
        }

        let comment_reqs: Vec<ReviewCommentReq> = comments
            .iter()
            .map(|c| ReviewCommentReq {
                path: &c.path,
                body: &c.body,
                line: c.line,
                side: gh_side(c.side),
                // A multi-line range needs both endpoints; otherwise omit them.
                start_line: c.start_line,
                start_side: c.start_line.map(|_| gh_side(c.start_side.or(c.side))),
            })
            .collect();

        let payload = serde_json::to_string(&ReviewReq {
            event: verdict.event(),
            body,
            comments: comment_reqs,
        })?;

        let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{pr}/reviews");
        let resp: RawReviewResp = self.run_gh_json_stdin(
            &["api", "-X", "POST", endpoint.as_str(), "--input", "-"],
            Some(repo_dir),
            &payload,
        )?;
        Ok(SubmittedVerdict {
            id: resp.id,
            state: resp.state,
        })
    }

    /// Attach a standalone comment to a specific **line** of the diff (RW-2). The
    /// comment is anchored to the PR head commit and appears as a native GitHub
    /// review comment (`POST …/pulls/{n}/comments`).
    pub fn comment_on_line(
        &self,
        repo_dir: &Path,
        pr: u32,
        comment: &DraftLineComment,
    ) -> Result<LineComment, StageError> {
        let commit_id = self.pr_head_oid(repo_dir, pr)?;
        let mut args = vec![
            "api".to_string(),
            "-X".to_string(),
            "POST".to_string(),
            format!("repos/{{owner}}/{{repo}}/pulls/{pr}/comments"),
            "-f".to_string(),
            format!("body={}", comment.body),
            "-f".to_string(),
            format!("commit_id={commit_id}"),
            "-f".to_string(),
            format!("path={}", comment.path),
            // `-F` (typed) so `line` is a JSON number, not a string.
            "-F".to_string(),
            format!("line={}", comment.line),
            "-f".to_string(),
            format!("side={}", gh_side(comment.side)),
        ];
        if let Some(start_line) = comment.start_line {
            args.push("-F".to_string());
            args.push(format!("start_line={start_line}"));
            args.push("-f".to_string());
            args.push(format!(
                "start_side={}",
                gh_side(comment.start_side.or(comment.side))
            ));
        }
        self.create_comment(repo_dir, &args)
    }

    /// Attach a standalone comment to a whole **file** of the diff (RW-2) — a
    /// `subject_type=file` review comment, with no line anchor.
    pub fn comment_on_file(
        &self,
        repo_dir: &Path,
        pr: u32,
        path: &str,
        body: &str,
    ) -> Result<LineComment, StageError> {
        let commit_id = self.pr_head_oid(repo_dir, pr)?;
        let args = vec![
            "api".to_string(),
            "-X".to_string(),
            "POST".to_string(),
            format!("repos/{{owner}}/{{repo}}/pulls/{pr}/comments"),
            "-f".to_string(),
            format!("body={body}"),
            "-f".to_string(),
            format!("commit_id={commit_id}"),
            "-f".to_string(),
            format!("path={path}"),
            "-f".to_string(),
            "subject_type=file".to_string(),
        ];
        self.create_comment(repo_dir, &args)
    }

    /// Shared tail of [`comment_on_line`]/[`comment_on_file`]: run the
    /// `gh api … comments` POST and map GitHub's created comment to [`LineComment`].
    fn create_comment(&self, repo_dir: &Path, args: &[String]) -> Result<LineComment, StageError> {
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let raw: RawLineComment = self.run_gh_json(&argv, Some(repo_dir))?;
        Ok(raw.into())
    }

    /// Read the PR's existing activity (RW-4): its state, verdict decision,
    /// overall reviews, conversation comments and CI checks from
    /// `gh pr view --json …`, plus the inline line comments from
    /// `gh api …/pulls/{n}/comments` (paginated so no comment is silently dropped).
    pub fn read_pr_activity(&self, repo_dir: &Path, pr: u32) -> Result<PrActivity, StageError> {
        let pr_s = pr.to_string();
        let view: RawPrView = self.run_gh_json(
            &["pr", "view", &pr_s, "--json", PR_VIEW_FIELDS],
            Some(repo_dir),
        )?;
        let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{pr}/comments");
        let line_comments: Vec<RawLineComment> =
            self.run_gh_json(&["api", "--paginate", endpoint.as_str()], Some(repo_dir))?;

        Ok(PrActivity {
            number: view.number,
            title: view.title,
            url: view.url,
            state: view.state,
            is_draft: view.is_draft,
            review_decision: nonempty(view.review_decision),
            base_ref: view.base_ref_name,
            head_ref: view.head_ref_name,
            reviews: view.reviews.into_iter().map(Into::into).collect(),
            issue_comments: view.comments.into_iter().map(Into::into).collect(),
            line_comments: line_comments.into_iter().map(Into::into).collect(),
            checks: view
                .status_check_rollup
                .into_iter()
                .map(Into::into)
                .collect(),
        })
    }

    /// Merge PR `pr` with `method` (RW-5). Subject to the user's GitHub
    /// permissions and branch protection — a refusal surfaces gh's message
    /// verbatim.
    pub fn merge_pr(
        &self,
        repo_dir: &Path,
        pr: u32,
        method: MergeMethod,
    ) -> Result<(), StageError> {
        let pr_s = pr.to_string();
        self.run_gh(&["pr", "merge", &pr_s, method.flag()], Some(repo_dir))?;
        Ok(())
    }

    /// Close PR `pr` without merging (RW-5). (Reopen is PUB-5, milestone D.)
    pub fn close_pr(&self, repo_dir: &Path, pr: u32) -> Result<(), StageError> {
        let pr_s = pr.to_string();
        self.run_gh(&["pr", "close", &pr_s], Some(repo_dir))?;
        Ok(())
    }

    /// Toggle PR `pr` between draft and ready-for-review (RW-5): `draft = false`
    /// marks it ready (`gh pr ready`), `draft = true` converts it back to a draft
    /// (`gh pr ready --undo`).
    pub fn set_pr_draft(&self, repo_dir: &Path, pr: u32, draft: bool) -> Result<(), StageError> {
        let pr_s = pr.to_string();
        let mut args = vec!["pr", "ready", pr_s.as_str()];
        if draft {
            args.push("--undo");
        }
        self.run_gh(&args, Some(repo_dir))?;
        Ok(())
    }

    /// Resolve the PR head commit SHA — the `commit_id` a pull-comment anchors
    /// to. Read as JSON (not via gh's `--jq`) so it parses without a jq runtime.
    fn pr_head_oid(&self, repo_dir: &Path, pr: u32) -> Result<String, StageError> {
        let pr_s = pr.to_string();
        let head: RawHeadOid = self.run_gh_json(
            &["pr", "view", &pr_s, "--json", "headRefOid"],
            Some(repo_dir),
        )?;
        if head.head_ref_oid.trim().is_empty() {
            return Err(StageError::GhFailed(format!(
                "GitHub returned no head commit for PR #{pr}."
            )));
        }
        Ok(head.head_ref_oid)
    }
}

/// GitHub's diff side token (`LEFT` / `RIGHT`); `None` defaults to the new file
/// (`RIGHT`), the common case for added/context lines.
fn gh_side(side: Option<Side>) -> &'static str {
    match side.unwrap_or(Side::Right) {
        Side::Left => "LEFT",
        Side::Right => "RIGHT",
    }
}

/// `""` → `None`; otherwise `Some(s)`. GitHub reports "no review decision" as an
/// empty string, which we normalize to `None` for the DTO.
fn nonempty(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

// ---------------------------------------------------------------------------
// Request bodies (serialized to the `gh api --input -` payload)
// ---------------------------------------------------------------------------

/// The `POST …/pulls/{n}/reviews` request body.
#[derive(Serialize)]
struct ReviewReq<'a> {
    event: &'a str,
    /// Always sent; empty is valid for `APPROVE` and rejected up front otherwise.
    body: &'a str,
    /// Omitted entirely when there are no bundled comments.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    comments: Vec<ReviewCommentReq<'a>>,
}

/// One bundled inline comment inside a [`ReviewReq`].
#[derive(Serialize)]
struct ReviewCommentReq<'a> {
    path: &'a str,
    body: &'a str,
    line: u32,
    side: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_side: Option<&'static str>,
}

// ---------------------------------------------------------------------------
// Raw `gh`/REST JSON shapes (normalized into the public DTOs above)
// ---------------------------------------------------------------------------

/// The created-review response from the Reviews API.
#[derive(Deserialize)]
struct RawReviewResp {
    id: u64,
    #[serde(default)]
    state: String,
}

/// `gh pr view --json headRefOid`.
#[derive(Deserialize)]
struct RawHeadOid {
    #[serde(rename = "headRefOid", default)]
    head_ref_oid: String,
}

/// `gh pr view --json …` (camelCase keys).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPrView {
    number: u32,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    review_decision: String,
    #[serde(default)]
    base_ref_name: String,
    #[serde(default)]
    head_ref_name: String,
    #[serde(default)]
    reviews: Vec<RawReview>,
    #[serde(default)]
    comments: Vec<RawIssueComment>,
    #[serde(default)]
    status_check_rollup: Vec<RawCheck>,
}

/// A `{ "login": … }` author object (GraphQL `author` / REST `user`); `null` for
/// a deleted account.
#[derive(Deserialize)]
struct RawActor {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
struct RawReview {
    author: Option<RawActor>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    state: String,
    #[serde(rename = "submittedAt")]
    submitted_at: Option<String>,
}

#[derive(Deserialize)]
struct RawIssueComment {
    author: Option<RawActor>,
    #[serde(default)]
    body: String,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
    #[serde(default)]
    url: String,
    #[serde(rename = "viewerDidAuthor", default)]
    viewer_did_author: bool,
}

/// A heterogeneous status rollup entry: a `CheckRun` carries `status` +
/// `conclusion` + `name`; a `StatusContext` carries a single `state` + `context`.
#[derive(Deserialize)]
struct RawCheck {
    name: Option<String>,
    context: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    state: Option<String>,
    #[serde(rename = "detailsUrl")]
    details_url: Option<String>,
    #[serde(rename = "targetUrl")]
    target_url: Option<String>,
}

/// A REST pull-comment object (snake_case keys).
#[derive(Deserialize)]
struct RawLineComment {
    id: u64,
    #[serde(default)]
    path: String,
    line: Option<u32>,
    side: Option<String>,
    #[serde(default)]
    body: String,
    user: Option<RawActor>,
    #[serde(default)]
    html_url: String,
}

/// A missing/`null` actor maps to GitHub's "ghost" placeholder rather than an
/// empty string, so the UI never renders a blank author.
fn login(actor: Option<RawActor>) -> String {
    actor
        .map(|a| a.login)
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "ghost".to_string())
}

impl From<RawReview> for ReviewSummary {
    fn from(r: RawReview) -> Self {
        ReviewSummary {
            author: login(r.author),
            state: r.state,
            body: r.body,
            submitted_at: r.submitted_at,
        }
    }
}

impl From<RawIssueComment> for IssueComment {
    fn from(c: RawIssueComment) -> Self {
        IssueComment {
            author: login(c.author),
            body: c.body,
            created_at: c.created_at,
            url: c.url,
            viewer_did_author: c.viewer_did_author,
        }
    }
}

impl From<RawLineComment> for LineComment {
    fn from(c: RawLineComment) -> Self {
        LineComment {
            id: c.id,
            path: c.path,
            line: c.line,
            side: c.side,
            body: c.body,
            author: login(c.user),
            url: c.html_url,
        }
    }
}

impl From<RawCheck> for CheckResult {
    fn from(c: RawCheck) -> Self {
        let status = normalize_check(&c);
        CheckResult {
            name: c
                .name
                .or(c.context)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "check".to_string()),
            status,
            url: c.details_url.or(c.target_url).filter(|s| !s.is_empty()),
        }
    }
}

/// Collapse a `CheckRun` (`status`/`conclusion`) or `StatusContext` (`state`)
/// into one [`CheckStatus`]. Anything unrecognized is [`CheckStatus::Unknown`]
/// (surfaced, never hidden).
fn normalize_check(c: &RawCheck) -> CheckStatus {
    // A StatusContext is identified by its `state`; a CheckRun has none.
    if let Some(state) = c.state.as_deref() {
        return match state {
            "SUCCESS" | "EXPECTED" => CheckStatus::Success,
            "FAILURE" | "ERROR" => CheckStatus::Failure,
            "PENDING" => CheckStatus::Pending,
            _ => CheckStatus::Unknown,
        };
    }
    match c.status.as_deref() {
        // Completed: the conclusion is the result.
        Some("COMPLETED") => match c.conclusion.as_deref() {
            Some("SUCCESS") => CheckStatus::Success,
            Some("FAILURE" | "TIMED_OUT" | "STARTUP_FAILURE" | "ACTION_REQUIRED") => {
                CheckStatus::Failure
            }
            Some("NEUTRAL") => CheckStatus::Neutral,
            Some("SKIPPED" | "STALE") => CheckStatus::Skipped,
            Some("CANCELLED") => CheckStatus::Cancelled,
            _ => CheckStatus::Unknown,
        },
        // Not yet completed (QUEUED / IN_PROGRESS / WAITING / REQUESTED / PENDING).
        Some(_) => CheckStatus::Pending,
        None => CheckStatus::Unknown,
    }
}

// The tests drive every command against a fake `gh` (a bash dispatcher) so they
// run fully offline — no network, no real GitHub. bash is unix-only; CI and dev
// are macOS/Linux (mirrors `github.rs`).
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    /// Write an executable script at `dir/name` and return its path.
    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    /// A comprehensive fake `gh`: passes the auth gate, records each call's argv
    /// (`calls`, `last_args`) and any stdin payload (`review_payload.json`) under
    /// `rec`, and answers each command with canned JSON. The verdict's resulting
    /// state is derived from the posted `event`, so one fake serves all three
    /// decisions.
    fn fake_gh_body(rec: &Path) -> String {
        const TEMPLATE: &str = r#"#!/usr/bin/env bash
set -euo pipefail
REC="__REC__"
args="$*"
if [ "${1:-}" = auth ] && [ "${2:-}" = status ]; then exit 0; fi
echo "$args" >> "$REC/calls"
echo "$args" > "$REC/last_args"
if [ "${1:-}" = pr ]; then
  case "${2:-}" in
    view)
      if [[ "$args" == *headRefOid* ]]; then
        echo '{"headRefOid":"deadbeefcafe0000000000000000000000000000"}'
        exit 0
      fi
      cat <<'JSON'
{
  "number": 42,
  "title": "Add the thing",
  "url": "https://github.com/o/r/pull/42",
  "state": "OPEN",
  "isDraft": false,
  "reviewDecision": "CHANGES_REQUESTED",
  "baseRefName": "main",
  "headRefName": "feat/thing",
  "reviews": [
    {"author": {"login": "octocat"}, "authorAssociation": "OWNER", "body": "please fix", "state": "CHANGES_REQUESTED", "submittedAt": "2026-06-16T10:00:00Z"},
    {"author": null, "body": "", "state": "COMMENTED", "submittedAt": null}
  ],
  "comments": [
    {"author": {"login": "octocat"}, "body": "top-level note", "createdAt": "2026-06-16T09:00:00Z", "url": "https://github.com/o/r/pull/42#issuecomment-1", "viewerDidAuthor": true}
  ],
  "statusCheckRollup": [
    {"__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": "https://ci/build"},
    {"__typename": "CheckRun", "name": "test", "status": "IN_PROGRESS", "conclusion": null, "detailsUrl": "https://ci/test"},
    {"__typename": "StatusContext", "context": "legacy/ci", "state": "FAILURE", "targetUrl": "https://ci/legacy"}
  ]
}
JSON
      exit 0
      ;;
    merge|close|ready)
      echo ok
      exit 0
      ;;
  esac
fi
if [ "${1:-}" = api ]; then
  if [[ "$args" == *reviews* ]]; then
    payload="$(cat)"
    printf '%s' "$payload" > "$REC/review_payload.json"
    state=APPROVED
    if [[ "$payload" == *REQUEST_CHANGES* ]]; then state=CHANGES_REQUESTED; fi
    if [[ "$payload" == *'"event":"COMMENT"'* ]]; then state=COMMENTED; fi
    printf '{"id":3001,"state":"%s"}\n' "$state"
    exit 0
  fi
  if [[ "$args" == *comments* ]]; then
    if [[ "$args" == *POST* ]]; then
      echo '{"id":2001,"path":"src/foo.rs","line":42,"side":"RIGHT","body":"x","user":{"login":"octocat"},"html_url":"https://e/2001"}'
      exit 0
    else
      echo '[{"id":1001,"path":"src/foo.rs","line":42,"side":"RIGHT","body":"nit","user":{"login":"octocat"},"html_url":"https://e/1001"},{"id":1002,"path":"src/bar.rs","line":null,"side":null,"body":"file","user":{"login":"hubot"},"html_url":"https://e/1002"}]'
      exit 0
    fi
  fi
fi
echo "fake gh: unhandled invocation: $args" >&2
exit 1
"#;
        TEMPLATE.replace("__REC__", rec.to_str().unwrap())
    }

    /// A `GitHub` wired to the fake `gh`, plus the recording dir. `git` is never
    /// invoked by these commands, so a bogus binary name is fine for it.
    fn fake() -> (GitHub, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let fake = write_script(dir.path(), "gh", &fake_gh_body(dir.path()));
        (GitHub::with_bins(fake, "git"), dir)
    }

    fn last_args(rec: &Path) -> String {
        std::fs::read_to_string(rec.join("last_args")).unwrap_or_default()
    }

    fn calls(rec: &Path) -> String {
        std::fs::read_to_string(rec.join("calls")).unwrap_or_default()
    }

    fn line(path: &str, line: u32, body: &str) -> DraftLineComment {
        DraftLineComment {
            path: path.into(),
            line,
            side: None,
            start_line: None,
            start_side: None,
            body: body.into(),
        }
    }

    // ---- RW-3: verdict submission (each of the three decisions) -----------

    #[test]
    fn verdict_approve_posts_event_and_returns_state() {
        let (gh, dir) = fake();
        let out = gh
            .submit_verdict(dir.path(), 42, Verdict::Approve, "", &[])
            .expect("approve");
        assert_eq!(out.id, 3001);
        assert_eq!(out.state, "APPROVED");

        let payload = std::fs::read_to_string(dir.path().join("review_payload.json")).unwrap();
        assert!(payload.contains(r#""event":"APPROVE""#), "{payload}");
        // No bundled comments → the `comments` key is omitted entirely.
        assert!(!payload.contains("comments"), "{payload}");
    }

    #[test]
    fn verdict_request_changes_maps_decision() {
        let (gh, dir) = fake();
        let out = gh
            .submit_verdict(dir.path(), 42, Verdict::RequestChanges, "needs work", &[])
            .expect("request changes");
        assert_eq!(out.state, "CHANGES_REQUESTED");
        let payload = std::fs::read_to_string(dir.path().join("review_payload.json")).unwrap();
        assert!(
            payload.contains(r#""event":"REQUEST_CHANGES""#),
            "{payload}"
        );
        assert!(payload.contains(r#""body":"needs work""#), "{payload}");
    }

    #[test]
    fn verdict_comment_maps_decision() {
        let (gh, dir) = fake();
        let out = gh
            .submit_verdict(dir.path(), 42, Verdict::Comment, "fyi", &[])
            .expect("comment");
        assert_eq!(out.state, "COMMENTED");
    }

    #[test]
    fn verdict_without_a_body_is_rejected_up_front() {
        let (gh, dir) = fake();
        // request-changes / comment require a body; we fail loud before calling gh.
        for v in [Verdict::RequestChanges, Verdict::Comment] {
            let err = gh
                .submit_verdict(dir.path(), 42, v, "   ", &[])
                .expect_err("empty body must be rejected");
            assert!(matches!(err, StageError::Invalid(_)), "{err:?}");
        }
        // No request reached gh, so no payload was recorded.
        assert!(!dir.path().join("review_payload.json").exists());
        // Approve, by contrast, is allowed with an empty body.
        assert!(gh
            .submit_verdict(dir.path(), 42, Verdict::Approve, "", &[])
            .is_ok());
    }

    #[test]
    fn verdict_bundles_line_comments() {
        let (gh, dir) = fake();
        let single = line("src/foo.rs", 10, "nit");
        let multi = DraftLineComment {
            path: "src/bar.rs".into(),
            line: 12,
            side: Some(Side::Right),
            start_line: Some(8),
            start_side: None,
            body: "range note".into(),
        };
        gh.submit_verdict(dir.path(), 42, Verdict::Approve, "", &[single, multi])
            .expect("approve with comments");

        let payload = std::fs::read_to_string(dir.path().join("review_payload.json")).unwrap();
        assert!(payload.contains(r#""comments":["#), "{payload}");
        assert!(payload.contains(r#""path":"src/foo.rs""#), "{payload}");
        assert!(payload.contains(r#""line":10"#), "{payload}");
        assert!(payload.contains(r#""side":"RIGHT""#), "{payload}");
        // The single-line comment omits the range fields…
        // …and the multi-line comment carries both endpoints (start_side
        // defaulting to the end side).
        assert!(payload.contains(r#""start_line":8"#), "{payload}");
        assert!(payload.contains(r#""start_side":"RIGHT""#), "{payload}");
    }

    // ---- RW-2: line / file comments ---------------------------------------

    #[test]
    fn comment_on_line_anchors_to_the_head_commit() {
        let (gh, dir) = fake();
        let out = gh
            .comment_on_line(dir.path(), 42, &line("src/foo.rs", 42, "a nit"))
            .expect("line comment");
        assert_eq!(out.id, 2001);
        assert_eq!(out.path, "src/foo.rs");
        assert_eq!(out.line, Some(42));
        assert_eq!(out.side.as_deref(), Some("RIGHT"));
        assert_eq!(out.author, "octocat");

        // The POST carried the anchor + the resolved head SHA, and `line` is a
        // typed (`-F`) field.
        let args = last_args(dir.path());
        assert!(args.contains("POST"), "{args}");
        assert!(args.contains("pulls/42/comments"), "{args}");
        assert!(args.contains("path=src/foo.rs"), "{args}");
        assert!(args.contains("-F line=42"), "{args}");
        assert!(args.contains("side=RIGHT"), "{args}");
        assert!(
            args.contains("commit_id=deadbeefcafe0000000000000000000000000000"),
            "{args}"
        );
        // The head SHA was resolved first (a `pr view … headRefOid` call).
        assert!(calls(dir.path()).contains("headRefOid"));
    }

    #[test]
    fn comment_on_file_uses_subject_type_file() {
        let (gh, dir) = fake();
        gh.comment_on_file(dir.path(), 42, "src/bar.rs", "whole-file note")
            .expect("file comment");
        let args = last_args(dir.path());
        assert!(args.contains("subject_type=file"), "{args}");
        assert!(args.contains("path=src/bar.rs"), "{args}");
        // A file-level comment has no line anchor.
        assert!(!args.contains("line="), "{args}");
    }

    // ---- RW-4: read existing comments, reviews, checks --------------------

    #[test]
    fn read_pr_activity_normalizes_reviews_comments_and_checks() {
        let (gh, dir) = fake();
        let act = gh.read_pr_activity(dir.path(), 42).expect("activity");

        assert_eq!(act.number, 42);
        assert_eq!(act.state, "OPEN");
        assert!(!act.is_draft);
        // The verdict decision is surfaced as the PR review decision.
        assert_eq!(act.review_decision.as_deref(), Some("CHANGES_REQUESTED"));
        assert_eq!(act.base_ref, "main");
        assert_eq!(act.head_ref, "feat/thing");

        // Overall reviews (verdicts): a null author becomes "ghost".
        assert_eq!(act.reviews.len(), 2);
        assert_eq!(act.reviews[0].author, "octocat");
        assert_eq!(act.reviews[0].state, "CHANGES_REQUESTED");
        assert_eq!(act.reviews[1].author, "ghost");
        assert_eq!(act.reviews[1].state, "COMMENTED");

        // Conversation comments.
        assert_eq!(act.issue_comments.len(), 1);
        assert_eq!(act.issue_comments[0].author, "octocat");
        assert!(act.issue_comments[0].viewer_did_author);

        // Inline line comments come from the paginated REST read.
        assert_eq!(act.line_comments.len(), 2);
        assert_eq!(act.line_comments[0].id, 1001);
        assert_eq!(act.line_comments[0].line, Some(42));
        assert_eq!(act.line_comments[0].side.as_deref(), Some("RIGHT"));
        assert_eq!(act.line_comments[1].id, 1002);
        assert_eq!(act.line_comments[1].line, None);
        assert_eq!(act.line_comments[1].author, "hubot");

        // The heterogeneous status rollup collapses to one status each.
        assert_eq!(act.checks.len(), 3);
        assert_eq!(act.checks[0].name, "build");
        assert_eq!(act.checks[0].status, CheckStatus::Success);
        assert_eq!(act.checks[0].url.as_deref(), Some("https://ci/build"));
        assert_eq!(act.checks[1].name, "test");
        assert_eq!(act.checks[1].status, CheckStatus::Pending);
        assert_eq!(act.checks[2].name, "legacy/ci");
        assert_eq!(act.checks[2].status, CheckStatus::Failure);

        // The line comments were read with --paginate (no silent cap).
        assert!(calls(dir.path()).contains("--paginate"));
    }

    #[test]
    fn empty_review_decision_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        // A minimal PR with no decision and empty activity arrays.
        let body = r#"#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = auth ] && [ "${2:-}" = status ]; then exit 0; fi
if [ "${1:-}" = pr ]; then
  echo '{"number":7,"title":"t","url":"u","state":"OPEN","isDraft":true,"reviewDecision":"","baseRefName":"main","headRefName":"f","reviews":[],"comments":[],"statusCheckRollup":[]}'
  exit 0
fi
if [ "${1:-}" = api ]; then echo '[]'; exit 0; fi
exit 1
"#;
        let fake = write_script(dir.path(), "gh", body);
        let gh = GitHub::with_bins(fake, "git");
        let act = gh.read_pr_activity(dir.path(), 7).expect("activity");
        assert_eq!(act.review_decision, None);
        assert!(act.is_draft);
        assert!(act.reviews.is_empty());
        assert!(act.line_comments.is_empty());
        assert!(act.checks.is_empty());
    }

    // ---- RW-5: act on the PR ----------------------------------------------

    #[test]
    fn pr_actions_invoke_the_right_gh_commands() {
        let (gh, dir) = fake();

        gh.merge_pr(dir.path(), 42, MergeMethod::Squash)
            .expect("merge");
        assert!(last_args(dir.path()).contains("pr merge 42 --squash"));

        gh.merge_pr(dir.path(), 42, MergeMethod::Merge)
            .expect("merge");
        assert!(last_args(dir.path()).contains("pr merge 42 --merge"));

        gh.merge_pr(dir.path(), 42, MergeMethod::Rebase)
            .expect("merge");
        assert!(last_args(dir.path()).contains("pr merge 42 --rebase"));

        gh.close_pr(dir.path(), 42).expect("close");
        assert!(last_args(dir.path()).contains("pr close 42"));

        // ready-for-review.
        gh.set_pr_draft(dir.path(), 42, false).expect("ready");
        let ready = last_args(dir.path());
        assert!(ready.contains("pr ready 42"), "{ready}");
        assert!(!ready.contains("--undo"), "{ready}");

        // back to draft.
        gh.set_pr_draft(dir.path(), 42, true).expect("to draft");
        assert!(last_args(dir.path()).contains("pr ready 42 --undo"));
    }

    // ---- fail loud: gh's own message surfaces verbatim --------------------

    #[test]
    fn pr_action_failure_surfaces_github_message_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let body = r#"#!/usr/bin/env bash
if [ "$1" = auth ] && [ "$2" = status ]; then exit 0; fi
echo 'Pull request is not mergeable: the base branch requires all conversations to be resolved.' >&2
exit 1
"#;
        let fake = write_script(dir.path(), "gh", body);
        let gh = GitHub::with_bins(fake, "git");
        let err = gh
            .merge_pr(dir.path(), 42, MergeMethod::Squash)
            .expect_err("a protected-branch refusal must fail");
        match err {
            StageError::GhFailed(msg) => assert_eq!(
                msg,
                "Pull request is not mergeable: the base branch requires all conversations to be resolved."
            ),
            other => panic!("expected GhFailed, got {other:?}"),
        }
    }
}
