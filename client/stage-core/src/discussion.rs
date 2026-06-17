//! Per-step PR discussion on GitHub's native comment threads (milestone E —
//! IC-1..3, ADR-0022 §4).
//!
//! Post-publish, a storyline step is discussed on the PR's **review threads** —
//! GitHub's native, code-anchored conversation surface. There is **no
//! Stage-only comment store** (RW-1/§4): every comment, every resolution, every
//! edit is native GitHub activity, and GitHub is authoritative.
//!
//! **IC-1 — discuss a step.** Each storyline step maps to the review thread(s)
//! anchored at the step's **code location** — the step's diff `anchor` (a
//! repo-relative file), *never* the storyline intro paragraph (which has no
//! GitHub home; pre-publish author notes stay local Self-Review notes). Starting
//! a step's discussion reuses the RW-2 primitives ([`GitHub::comment_on_file`] /
//! [`GitHub::comment_on_line`]) via [`GitHub::start_step_thread`]: a review
//! comment on the step's file/line *is* the thread root. Replies go through
//! [`GitHub::reply_to_thread`]. Reading ([`GitHub::read_pr_threads`]) is a single
//! GraphQL query so resolution state and per-comment viewer capabilities arrive
//! together; [`group_threads_by_step`] is the pure Rust mapping from threads to
//! steps by code location (ADR-0022 §7: Rust computes, TS renders).
//!
//! **IC-2 — resolve / reopen.** [`GitHub::resolve_thread`] /
//! [`GitHub::reopen_thread`] drive GitHub's native `resolveReviewThread` /
//! `unresolveReviewThread` mutations. Each [`ReviewThread`] carries `is_resolved`
//! so the webview renders resolved threads visually distinct.
//!
//! **IC-3 — edit / delete own comments.** [`GitHub::edit_comment`] /
//! [`GitHub::delete_comment`] map to the GitHub natives (REST `PATCH` / `DELETE`
//! on `pulls/comments/{id}`). Editing another participant's comment is **not**
//! offered: every [`ThreadComment`] reports `viewer_can_update` /
//! `viewer_can_delete` / `viewer_did_author` (GitHub-computed, permissions
//! included) so the UI hides the affordance, and a native rejection surfaces
//! verbatim if attempted anyway.
//!
//! **Fail loud (CLAUDE.md):** nothing is swallowed or defaulted. `gh` surfaces a
//! failed mutation / a 403 on someone else's comment / a 422 for an off-diff
//! anchor as [`StageError::GhFailed`] carrying GitHub's own message verbatim; a
//! `gh api graphql` response that carries an `errors` array exits non-zero, so it
//! flows through the same path. An unexpectedly-shaped response fails loud rather
//! than defaulting.

use std::path::Path;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::domain::Side;
use crate::error::StageError;
use crate::github::GitHub;
use crate::pr::{DraftLineComment, LineComment};

// ---------------------------------------------------------------------------
// Public DTOs (the ts-rs contract — Rust computes, TS renders)
// ---------------------------------------------------------------------------

/// One comment inside a [`ReviewThread`] (IC-1 read; IC-3 edit/delete target).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadComment {
    /// GitHub's REST comment id (`databaseId`) — the handle [`GitHub::edit_comment`]
    /// / [`GitHub::delete_comment`] / [`GitHub::reply_to_thread`] address (IC-3).
    /// Crosses the JSON IPC boundary as a JS `number` (ts-rs would otherwise emit
    /// `bigint` for a 64-bit int).
    #[ts(type = "number")]
    pub id: u64,
    /// The comment body (markdown).
    pub body: String,
    /// The comment author's GitHub login.
    pub author: String,
    /// The comment's URL on github.com.
    pub url: String,
    /// When the comment was created (ISO 8601), if known.
    pub created_at: Option<String>,
    /// Whether the `gh` token owner authored this comment.
    pub viewer_did_author: bool,
    /// Whether the viewer may edit it (GitHub-computed, permissions included). The
    /// UI shows the edit affordance only when true — "cannot edit others'" (IC-3).
    pub viewer_can_update: bool,
    /// Whether the viewer may delete it (GitHub-computed). Gates the delete
    /// affordance the same way.
    pub viewer_can_delete: bool,
}

/// One GitHub PR **review thread** — a code-anchored discussion (IC-1). Read via
/// GraphQL so resolution state (IC-2) and per-comment viewer capabilities (IC-3)
/// come in one shot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewThread {
    /// GitHub's GraphQL node id — the handle [`GitHub::resolve_thread`] /
    /// [`GitHub::reopen_thread`] address (IC-2).
    pub id: String,
    /// The thread's code location: the repo-relative diff path it is anchored to.
    /// This is the join key against a storyline step's `anchor`. `None` only for a
    /// thread GitHub reports without a path.
    pub path: Option<String>,
    /// The anchored line, if the thread still maps to one (`None` once outdated).
    pub line: Option<u32>,
    /// GitHub's native resolution state (IC-2). Resolved threads render distinct.
    pub is_resolved: bool,
    /// Whether the thread's anchor is outdated (the line moved/disappeared since).
    pub is_outdated: bool,
    /// The thread's comments, oldest first (the root comment followed by replies).
    pub comments: Vec<ThreadComment>,
}

/// One storyline step paired with the review threads anchored at its code
/// location (IC-1). Built by [`group_threads_by_step`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StepThreads {
    /// The step's code location (its diff `anchor`) — the file the threads hang
    /// off of.
    pub anchor: String,
    /// The review threads anchored at `anchor`, in GitHub's order.
    pub threads: Vec<ReviewThread>,
}

/// The PR's discussion, mapped onto the storyline (IC-1, ADR-0022 §7). Each step
/// gets the threads anchored at its code location; threads anchored elsewhere
/// (plain inline review comments, off-step) are surfaced in `unanchored` rather
/// than hidden.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PrDiscussion {
    /// One entry per storyline step, in step order.
    pub steps: Vec<StepThreads>,
    /// Threads not anchored to any storyline step — still browsable, never
    /// dropped.
    pub unanchored: Vec<ReviewThread>,
}

/// Group review `threads` onto storyline steps by **code location** (IC-1).
/// Pure (no git, no `gh`): a thread joins the step whose `anchor` equals the
/// thread's `path`; everything else lands in [`PrDiscussion::unanchored`]. Steps
/// are emitted in the given `step_anchors` order, each with its threads in
/// GitHub's order. A step with no threads yet gets an empty `threads` list (the
/// discussion section still renders, ready for a first comment).
///
/// `step_anchors` are the steps' diff anchors (from the committed Review's steps
/// or the draft storyline); v1 is one step per file, so the join is unambiguous.
pub fn group_threads_by_step(step_anchors: &[String], threads: Vec<ReviewThread>) -> PrDiscussion {
    use std::collections::HashMap;

    // anchor path -> its index in step order.
    let index: HashMap<&str, usize> = step_anchors
        .iter()
        .enumerate()
        .map(|(i, a)| (a.as_str(), i))
        .collect();

    let mut buckets: Vec<Vec<ReviewThread>> = (0..step_anchors.len()).map(|_| Vec::new()).collect();
    let mut unanchored: Vec<ReviewThread> = Vec::new();

    for thread in threads {
        match thread.path.as_deref().and_then(|p| index.get(p)).copied() {
            Some(i) => buckets[i].push(thread),
            None => unanchored.push(thread),
        }
    }

    let steps = step_anchors
        .iter()
        .cloned()
        .zip(buckets)
        .map(|(anchor, threads)| StepThreads { anchor, threads })
        .collect();

    PrDiscussion { steps, unanchored }
}

// ---------------------------------------------------------------------------
// Feature commands (built on the `gh` runners in `github.rs`)
// ---------------------------------------------------------------------------

impl GitHub {
    /// Start a discussion on a storyline step (IC-1): post a review comment at the
    /// step's **code location** — `anchor` is the step's diff file. A `line`
    /// targets a specific line ([`GitHub::comment_on_line`]); `None` anchors the
    /// whole file ([`GitHub::comment_on_file`]). The returned root comment opens a
    /// new GitHub review thread; read it back with [`GitHub::read_pr_threads`] to
    /// get the thread id for resolve/reopen.
    ///
    /// The discussion is always code-anchored, never tied to the storyline intro
    /// (ADR-0022 §4). GitHub validates the path/line against the PR diff and a
    /// miss surfaces verbatim (fail loud) — Stage does not pre-judge it.
    pub fn start_step_thread(
        &self,
        repo_dir: &Path,
        pr: u32,
        anchor: &str,
        line: Option<u32>,
        side: Option<Side>,
        body: &str,
    ) -> Result<LineComment, StageError> {
        match line {
            Some(line) => self.comment_on_line(
                repo_dir,
                pr,
                &DraftLineComment {
                    path: anchor.to_string(),
                    line,
                    side,
                    start_line: None,
                    start_side: None,
                    body: body.to_string(),
                },
            ),
            None => self.comment_on_file(repo_dir, pr, anchor, body),
        }
    }

    /// Reply within an existing review thread (IC-1): append a comment under the
    /// thread whose root review comment is `in_reply_to`
    /// (`POST …/pulls/{pr}/comments/{id}/replies`). The reply is the viewer's own,
    /// so the returned [`ThreadComment`] reports the viewer owns it.
    pub fn reply_to_thread(
        &self,
        repo_dir: &Path,
        pr: u32,
        in_reply_to: u64,
        body: &str,
    ) -> Result<ThreadComment, StageError> {
        let endpoint =
            format!("repos/{{owner}}/{{repo}}/pulls/{pr}/comments/{in_reply_to}/replies");
        let raw: RawRestComment = self.run_gh_json(
            &[
                "api",
                "-X",
                "POST",
                endpoint.as_str(),
                "-f",
                format!("body={body}").as_str(),
            ],
            Some(repo_dir),
        )?;
        Ok(raw.into_own_comment())
    }

    /// Read every review thread on PR `pr` (IC-1), with resolution state (IC-2)
    /// and per-comment viewer capabilities (IC-3) in one GraphQL query. Threads
    /// are paginated (no silent cap — CLAUDE.md): the cursor loop runs until
    /// GitHub reports no next page. A thread with more than [`COMMENTS_PER_THREAD`]
    /// comments is logged loudly rather than silently clipped.
    ///
    /// `repo_dir` scopes `gh` to the right repo; the PR's GraphQL node id is
    /// resolved first so the query needs no owner/name parsing.
    pub fn read_pr_threads(
        &self,
        repo_dir: &Path,
        pr: u32,
    ) -> Result<Vec<ReviewThread>, StageError> {
        let pr_id = self.pr_node_id(repo_dir, pr)?;
        let mut threads: Vec<ReviewThread> = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let query_arg = format!("query={REVIEW_THREADS_QUERY}");
            let pr_id_arg = format!("prId={pr_id}");
            let mut args: Vec<&str> = vec![
                "api",
                "graphql",
                "-f",
                query_arg.as_str(),
                "-f",
                pr_id_arg.as_str(),
            ];
            // First page: omit `cursor` so the nullable `$cursor` defaults to null
            // (i.e. `after: null` → from the start). Later pages pass the cursor.
            let cursor_arg;
            if let Some(c) = &cursor {
                cursor_arg = format!("cursor={c}");
                args.push("-f");
                args.push(cursor_arg.as_str());
            }

            let resp: GqlThreadsResp = self.run_gh_json(&args, Some(repo_dir))?;
            let conn = resp
                .data
                .node
                .ok_or_else(|| {
                    tracing::error!(pr = pr, "pr_node_missing_in_graphql_response");
                    StageError::GhFailed(format!(
                        "GitHub returned no pull request for the resolved node of PR #{pr}."
                    ))
                })?
                .review_threads;

            for raw in conn.nodes {
                if raw.comments.page_info.has_next_page
                    || raw.comments.total_count > COMMENTS_PER_THREAD
                {
                    tracing::warn!(
                        thread_id = %raw.id,
                        total = raw.comments.total_count,
                        shown = COMMENTS_PER_THREAD,
                        "review_thread_comments_truncated: thread has more comments than one page"
                    );
                }
                threads.push(raw.into());
            }

            if conn.page_info.has_next_page {
                match conn.page_info.end_cursor {
                    Some(c) => cursor = Some(c),
                    // hasNextPage with no cursor would loop forever — fail loud.
                    None => {
                        tracing::error!(pr = pr, "review_threads_next_page_without_cursor");
                        return Err(StageError::GhFailed(format!(
                            "GitHub reported more review-thread pages for PR #{pr} but no cursor to fetch them."
                        )));
                    }
                }
            } else {
                break;
            }
        }
        Ok(threads)
    }

    /// Resolve a review thread (IC-2): GitHub's native `resolveReviewThread`
    /// mutation. `thread_id` is the GraphQL node id from [`ReviewThread::id`].
    /// Returns the thread's resulting `is_resolved` (always `true` on success).
    pub fn resolve_thread(&self, repo_dir: &Path, thread_id: &str) -> Result<bool, StageError> {
        self.set_thread_resolution(repo_dir, thread_id, true)
    }

    /// Reopen a resolved review thread (IC-2): GitHub's native
    /// `unresolveReviewThread` mutation. Returns the resulting `is_resolved`
    /// (always `false` on success).
    pub fn reopen_thread(&self, repo_dir: &Path, thread_id: &str) -> Result<bool, StageError> {
        self.set_thread_resolution(repo_dir, thread_id, false)
    }

    /// Shared tail of [`resolve_thread`]/[`reopen_thread`]: run the GraphQL
    /// resolve/unresolve mutation and return the thread's new `is_resolved`.
    fn set_thread_resolution(
        &self,
        repo_dir: &Path,
        thread_id: &str,
        resolve: bool,
    ) -> Result<bool, StageError> {
        let query = if resolve {
            RESOLVE_MUTATION
        } else {
            UNRESOLVE_MUTATION
        };
        let query_arg = format!("query={query}");
        let thread_arg = format!("threadId={thread_id}");
        let resp: GqlResolveResp = self.run_gh_json(
            &[
                "api",
                "graphql",
                "-f",
                query_arg.as_str(),
                "-f",
                thread_arg.as_str(),
            ],
            Some(repo_dir),
        )?;
        resp.data.resolved_state().ok_or_else(|| {
            tracing::error!(thread_id = %thread_id, "thread_resolution_response_malformed");
            StageError::GhFailed(format!(
                "GitHub did not report the resolution state for thread {thread_id}."
            ))
        })
    }

    /// Edit a comment **you authored** (IC-3): GitHub's native review-comment
    /// update (`PATCH …/pulls/comments/{id}`). Editing another participant's
    /// comment is rejected by GitHub and the message surfaces verbatim — the UI
    /// gates this on [`ThreadComment::viewer_can_update`] so it is never offered.
    /// Returns the updated comment.
    pub fn edit_comment(
        &self,
        repo_dir: &Path,
        comment_id: u64,
        body: &str,
    ) -> Result<ThreadComment, StageError> {
        let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/comments/{comment_id}");
        let raw: RawRestComment = self.run_gh_json(
            &[
                "api",
                "-X",
                "PATCH",
                endpoint.as_str(),
                "-f",
                format!("body={body}").as_str(),
            ],
            Some(repo_dir),
        )?;
        Ok(raw.into_own_comment())
    }

    /// Delete a comment **you authored** (IC-3): GitHub's native review-comment
    /// delete (`DELETE …/pulls/comments/{id}`). Gated by
    /// [`ThreadComment::viewer_can_delete`] in the UI; a native rejection surfaces
    /// verbatim.
    pub fn delete_comment(&self, repo_dir: &Path, comment_id: u64) -> Result<(), StageError> {
        let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/comments/{comment_id}");
        self.run_gh(&["api", "-X", "DELETE", endpoint.as_str()], Some(repo_dir))?;
        Ok(())
    }

    /// Resolve the PR's GraphQL node id (`gh pr view {pr} --json id`) — the handle
    /// the review-threads query navigates from, avoiding owner/name parsing. Read
    /// as JSON (not via gh's `--jq`) so it parses without a jq runtime, mirroring
    /// [`crate::pr`]'s head-OID resolution.
    fn pr_node_id(&self, repo_dir: &Path, pr: u32) -> Result<String, StageError> {
        let pr_s = pr.to_string();
        let node: RawPrNode =
            self.run_gh_json(&["pr", "view", &pr_s, "--json", "id"], Some(repo_dir))?;
        if node.id.trim().is_empty() {
            return Err(StageError::GhFailed(format!(
                "GitHub returned no node id for PR #{pr}."
            )));
        }
        Ok(node.id)
    }
}

/// Page size for a thread's comments. GraphQL caps a connection page at 100;
/// a thread with more is logged loudly rather than silently clipped (CLAUDE.md:
/// no silent caps). Threads rarely exceed this.
const COMMENTS_PER_THREAD: u32 = 100;

/// Read the PR's review threads with resolution + viewer fields in one query.
/// Navigated from the PR node id so no owner/name is needed; threads are
/// paginated by `$cursor`.
const REVIEW_THREADS_QUERY: &str = "\
query($prId: ID!, $cursor: String) {
  node(id: $prId) {
    ... on PullRequest {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            totalCount
            pageInfo { hasNextPage }
            nodes {
              databaseId
              body
              url
              createdAt
              author { login }
              viewerDidAuthor
              viewerCanUpdate
              viewerCanDelete
            }
          }
        }
      }
    }
  }
}";

/// Resolve a review thread (IC-2).
const RESOLVE_MUTATION: &str = "\
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}";

/// Reopen (unresolve) a review thread (IC-2).
const UNRESOLVE_MUTATION: &str = "\
mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}";

// ---------------------------------------------------------------------------
// Raw `gh`/REST/GraphQL JSON shapes (normalized into the public DTOs above)
// ---------------------------------------------------------------------------

/// `gh pr view {pr} --json id` — the PR's GraphQL node id.
#[derive(Deserialize)]
struct RawPrNode {
    #[serde(default)]
    id: String,
}

/// A `{ "login": … }` actor; `null` for a deleted account.
#[derive(Deserialize)]
struct RawActor {
    #[serde(default)]
    login: String,
}

/// A missing/`null`/empty actor maps to GitHub's "ghost" placeholder, so the UI
/// never renders a blank author.
fn login(actor: Option<RawActor>) -> String {
    actor
        .map(|a| a.login)
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "ghost".to_string())
}

/// A REST pull-comment object (the reply / edit response — snake_case keys).
#[derive(Deserialize)]
struct RawRestComment {
    id: u64,
    #[serde(default)]
    body: String,
    user: Option<RawActor>,
    #[serde(default)]
    html_url: String,
    created_at: Option<String>,
}

impl RawRestComment {
    /// Map a comment the viewer just created or edited. Such a comment is by
    /// definition the viewer's own (GitHub only permits editing/replying as the
    /// author), so the viewer-capability flags are all true.
    fn into_own_comment(self) -> ThreadComment {
        ThreadComment {
            id: self.id,
            body: self.body,
            author: login(self.user),
            url: self.html_url,
            created_at: self.created_at,
            viewer_did_author: true,
            viewer_can_update: true,
            viewer_can_delete: true,
        }
    }
}

/// `gh api graphql` review-threads response.
#[derive(Deserialize)]
struct GqlThreadsResp {
    data: GqlThreadsData,
}

#[derive(Deserialize)]
struct GqlThreadsData {
    /// `null` if the node id didn't resolve to a PR (handled fail-loud upstream).
    node: Option<GqlPrNode>,
}

#[derive(Deserialize)]
struct GqlPrNode {
    #[serde(rename = "reviewThreads")]
    review_threads: GqlThreadConn,
}

#[derive(Deserialize)]
struct GqlThreadConn {
    #[serde(rename = "pageInfo")]
    page_info: GqlPageInfo,
    nodes: Vec<GqlThread>,
}

#[derive(Deserialize)]
struct GqlPageInfo {
    #[serde(rename = "hasNextPage")]
    has_next_page: bool,
    #[serde(rename = "endCursor")]
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
struct GqlThread {
    id: String,
    #[serde(rename = "isResolved")]
    is_resolved: bool,
    #[serde(rename = "isOutdated")]
    is_outdated: bool,
    path: Option<String>,
    line: Option<u32>,
    comments: GqlCommentConn,
}

#[derive(Deserialize)]
struct GqlCommentConn {
    #[serde(rename = "totalCount")]
    total_count: u32,
    #[serde(rename = "pageInfo")]
    page_info: GqlCommentPageInfo,
    nodes: Vec<GqlComment>,
}

#[derive(Deserialize)]
struct GqlCommentPageInfo {
    #[serde(rename = "hasNextPage")]
    has_next_page: bool,
}

#[derive(Deserialize)]
struct GqlComment {
    /// GitHub's REST id for this review comment. Always populated for a persisted
    /// comment; a missing value fails loud (we cannot edit/delete without it).
    #[serde(rename = "databaseId")]
    database_id: u64,
    #[serde(default)]
    body: String,
    #[serde(default)]
    url: String,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
    author: Option<RawActor>,
    #[serde(rename = "viewerDidAuthor", default)]
    viewer_did_author: bool,
    #[serde(rename = "viewerCanUpdate", default)]
    viewer_can_update: bool,
    #[serde(rename = "viewerCanDelete", default)]
    viewer_can_delete: bool,
}

impl From<GqlThread> for ReviewThread {
    fn from(t: GqlThread) -> Self {
        ReviewThread {
            id: t.id,
            path: t.path,
            line: t.line,
            is_resolved: t.is_resolved,
            is_outdated: t.is_outdated,
            comments: t.comments.nodes.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<GqlComment> for ThreadComment {
    fn from(c: GqlComment) -> Self {
        ThreadComment {
            id: c.database_id,
            body: c.body,
            author: login(c.author),
            url: c.url,
            created_at: c.created_at,
            viewer_did_author: c.viewer_did_author,
            viewer_can_update: c.viewer_can_update,
            viewer_can_delete: c.viewer_can_delete,
        }
    }
}

/// `gh api graphql` resolve/unresolve response. The mutation key differs by
/// direction; whichever is present carries the resulting thread state.
#[derive(Deserialize)]
struct GqlResolveResp {
    data: GqlResolveData,
}

#[derive(Deserialize)]
struct GqlResolveData {
    #[serde(rename = "resolveReviewThread")]
    resolve: Option<GqlThreadPayload>,
    #[serde(rename = "unresolveReviewThread")]
    unresolve: Option<GqlThreadPayload>,
}

impl GqlResolveData {
    /// The new `is_resolved` from whichever mutation ran; `None` if the response
    /// carried neither payload (malformed → fail loud upstream).
    fn resolved_state(&self) -> Option<bool> {
        self.resolve
            .as_ref()
            .or(self.unresolve.as_ref())
            .map(|p| p.thread.is_resolved)
    }
}

#[derive(Deserialize)]
struct GqlThreadPayload {
    thread: GqlThreadState,
}

#[derive(Deserialize)]
struct GqlThreadState {
    #[serde(rename = "isResolved")]
    is_resolved: bool,
}

// The tests drive every command against a fake `gh` (a bash dispatcher) so they
// run fully offline — no network, no real GitHub. bash is unix-only; CI and dev
// are macOS/Linux (mirrors `github.rs` / `pr.rs`).
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
    /// (`calls`, `last_args`) under `rec`, and answers every IC command with
    /// canned JSON. The review-threads read is paginated across two pages so the
    /// cursor loop is exercised; the resolve/unresolve mutations echo the matching
    /// state.
    fn fake_gh_body(rec: &Path) -> String {
        const TEMPLATE: &str = r#"#!/usr/bin/env bash
set -euo pipefail
REC="__REC__"
args="$*"
if [ "${1:-}" = auth ] && [ "${2:-}" = status ]; then exit 0; fi
echo "$args" >> "$REC/calls"
echo "$args" > "$REC/last_args"

if [ "${1:-}" = pr ] && [ "${2:-}" = view ]; then
  if [[ "$args" == *headRefOid* ]]; then
    echo '{"headRefOid":"deadbeefcafe0000000000000000000000000000"}'
    exit 0
  fi
  if [[ "$args" == *"--json id"* ]]; then
    echo '{"id":"PR_node_42"}'
    exit 0
  fi
fi

if [ "${1:-}" = api ]; then
  if [[ "$args" == *graphql* ]]; then
    # Order matters: unresolve contains "resolveReviewThread" as a substring.
    if [[ "$args" == *unresolveReviewThread* ]]; then
      echo '{"data":{"unresolveReviewThread":{"thread":{"id":"PRRT_1","isResolved":false}}}}'
      exit 0
    fi
    if [[ "$args" == *resolveReviewThread* ]]; then
      echo '{"data":{"resolveReviewThread":{"thread":{"id":"PRRT_1","isResolved":true}}}}'
      exit 0
    fi
    if [[ "$args" == *reviewThreads* ]]; then
      if [[ "$args" == *cursor=CUR2* ]]; then
        cat <<'JSON'
{"data":{"node":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[
  {"id":"PRRT_bar","isResolved":true,"isOutdated":true,"path":"src/bar.rs","line":null,"comments":{"totalCount":1,"pageInfo":{"hasNextPage":false},"nodes":[
    {"databaseId":2100,"body":"resolved one","url":"https://e/2100","createdAt":"2026-06-16T09:30:00Z","author":{"login":"octocat"},"viewerDidAuthor":true,"viewerCanUpdate":true,"viewerCanDelete":true}
  ]}},
  {"id":"PRRT_other","isResolved":false,"isOutdated":false,"path":"docs/readme.md","line":3,"comments":{"totalCount":1,"pageInfo":{"hasNextPage":false},"nodes":[
    {"databaseId":2200,"body":"off-step note","url":"https://e/2200","createdAt":"2026-06-16T09:40:00Z","author":{"login":"hubot"},"viewerDidAuthor":false,"viewerCanUpdate":false,"viewerCanDelete":false}
  ]}}
]}}}}
JSON
        exit 0
      fi
      cat <<'JSON'
{"data":{"node":{"reviewThreads":{"pageInfo":{"hasNextPage":true,"endCursor":"CUR2"},"nodes":[
  {"id":"PRRT_foo","isResolved":false,"isOutdated":false,"path":"src/foo.rs","line":42,"comments":{"totalCount":2,"pageInfo":{"hasNextPage":false},"nodes":[
    {"databaseId":2001,"body":"mine","url":"https://e/2001","createdAt":"2026-06-16T09:00:00Z","author":{"login":"octocat"},"viewerDidAuthor":true,"viewerCanUpdate":true,"viewerCanDelete":true},
    {"databaseId":2002,"body":"theirs","url":"https://e/2002","createdAt":"2026-06-16T09:05:00Z","author":{"login":"hubot"},"viewerDidAuthor":false,"viewerCanUpdate":false,"viewerCanDelete":false}
  ]}}
]}}}}
JSON
      exit 0
    fi
  fi
  if [[ "$args" == *replies* ]]; then
    echo '{"id":3100,"body":"thanks","user":{"login":"octocat"},"html_url":"https://e/3100","created_at":"2026-06-16T12:00:00Z"}'
    exit 0
  fi
  if [[ "$args" == *PATCH* ]] && [[ "$args" == *pulls/comments/* ]]; then
    echo '{"id":2001,"body":"edited body","user":{"login":"octocat"},"html_url":"https://e/2001","created_at":"2026-06-16T09:00:00Z"}'
    exit 0
  fi
  if [[ "$args" == *DELETE* ]] && [[ "$args" == *pulls/comments/* ]]; then
    exit 0
  fi
  # start_step_thread roots a review comment (comment_on_file / comment_on_line).
  if [[ "$args" == *comments* ]] && [[ "$args" == *POST* ]]; then
    echo '{"id":1001,"path":"src/foo.rs","line":null,"side":null,"body":"lets discuss","user":{"login":"octocat"},"html_url":"https://e/1001"}'
    exit 0
  fi
fi
echo "fake gh: unhandled invocation: $args" >&2
exit 1
"#;
        TEMPLATE.replace("__REC__", rec.to_str().unwrap())
    }

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

    // ---- IC-1: discuss a step (anchored to code, not the intro) -----------

    #[test]
    fn start_step_thread_anchors_a_file_comment_to_the_step_code_location() {
        let (gh, dir) = fake();
        // No line → a whole-file review comment on the step's anchor file.
        let root = gh
            .start_step_thread(dir.path(), 42, "src/foo.rs", None, None, "lets discuss")
            .expect("start thread");
        assert_eq!(root.id, 1001);
        assert_eq!(root.path, "src/foo.rs");

        let args = last_args(dir.path());
        // The thread is rooted at the step's code location, not an intro paragraph.
        assert!(args.contains("pulls/42/comments"), "{args}");
        assert!(args.contains("path=src/foo.rs"), "{args}");
        assert!(args.contains("subject_type=file"), "{args}");
    }

    #[test]
    fn start_step_thread_can_anchor_to_a_specific_line() {
        let (gh, dir) = fake();
        gh.start_step_thread(
            dir.path(),
            42,
            "src/foo.rs",
            Some(42),
            Some(Side::Right),
            "here",
        )
        .expect("start line thread");
        let args = last_args(dir.path());
        assert!(args.contains("path=src/foo.rs"), "{args}");
        assert!(args.contains("-F line=42"), "{args}");
        assert!(args.contains("side=RIGHT"), "{args}");
        // A line-anchored thread is not a whole-file comment.
        assert!(!args.contains("subject_type=file"), "{args}");
    }

    #[test]
    fn reply_to_thread_posts_under_the_root_comment() {
        let (gh, dir) = fake();
        let reply = gh
            .reply_to_thread(dir.path(), 42, 1001, "thanks")
            .expect("reply");
        assert_eq!(reply.id, 3100);
        assert_eq!(reply.author, "octocat");
        // A reply is the viewer's own comment.
        assert!(reply.viewer_did_author);
        assert!(reply.viewer_can_update);

        let args = last_args(dir.path());
        assert!(args.contains("POST"), "{args}");
        assert!(args.contains("pulls/42/comments/1001/replies"), "{args}");
        assert!(args.contains("body=thanks"), "{args}");
    }

    // ---- IC-1 read + IC-2 state + IC-3 capability, paginated --------------

    #[test]
    fn read_pr_threads_paginates_and_surfaces_resolution_and_viewer_flags() {
        let (gh, dir) = fake();
        let threads = gh.read_pr_threads(dir.path(), 42).expect("threads");

        // Three threads across two pages (the cursor loop ran).
        assert_eq!(threads.len(), 3);
        assert!(
            calls(dir.path()).contains("cursor=CUR2"),
            "the second page must be fetched with the returned cursor"
        );
        // The PR node id was resolved first.
        assert!(calls(dir.path()).contains("--json id"));

        let foo = threads.iter().find(|t| t.id == "PRRT_foo").unwrap();
        assert_eq!(foo.path.as_deref(), Some("src/foo.rs"));
        assert_eq!(foo.line, Some(42));
        assert!(!foo.is_resolved);
        assert_eq!(foo.comments.len(), 2);
        // IC-3: the viewer can edit their own comment, not the other participant's.
        let mine = &foo.comments[0];
        assert_eq!(mine.id, 2001);
        assert!(mine.viewer_did_author && mine.viewer_can_update && mine.viewer_can_delete);
        let theirs = &foo.comments[1];
        assert_eq!(theirs.author, "hubot");
        assert!(
            !theirs.viewer_did_author && !theirs.viewer_can_update && !theirs.viewer_can_delete
        );

        // IC-2: the resolved thread is flagged distinct, and reports outdated.
        let bar = threads.iter().find(|t| t.id == "PRRT_bar").unwrap();
        assert!(bar.is_resolved);
        assert!(bar.is_outdated);
        assert_eq!(bar.path.as_deref(), Some("src/bar.rs"));
        assert_eq!(bar.line, None);
    }

    #[test]
    fn group_threads_by_step_maps_threads_to_steps_by_code_location() {
        let (gh, dir) = fake();
        let threads = gh.read_pr_threads(dir.path(), 42).expect("threads");

        let anchors = vec!["src/foo.rs".to_string(), "src/bar.rs".to_string()];
        let discussion = group_threads_by_step(&anchors, threads);

        // Each step gets the threads anchored at its code location, in step order.
        assert_eq!(discussion.steps.len(), 2);
        assert_eq!(discussion.steps[0].anchor, "src/foo.rs");
        assert_eq!(discussion.steps[0].threads.len(), 1);
        assert_eq!(discussion.steps[0].threads[0].id, "PRRT_foo");
        assert_eq!(discussion.steps[1].anchor, "src/bar.rs");
        assert_eq!(discussion.steps[1].threads.len(), 1);
        assert!(discussion.steps[1].threads[0].is_resolved);

        // A thread off any step's code location stays browsable, never dropped.
        assert_eq!(discussion.unanchored.len(), 1);
        assert_eq!(
            discussion.unanchored[0].path.as_deref(),
            Some("docs/readme.md")
        );
    }

    #[test]
    fn group_threads_by_step_is_pure_and_leaves_empty_steps_renderable() {
        // A step with no threads still appears, ready for a first comment.
        let anchors = vec!["a.rs".to_string(), "b.rs".to_string()];
        let threads = vec![ReviewThread {
            id: "T1".into(),
            path: Some("b.rs".into()),
            line: Some(1),
            is_resolved: false,
            is_outdated: false,
            comments: vec![],
        }];
        let d = group_threads_by_step(&anchors, threads);
        assert_eq!(d.steps[0].anchor, "a.rs");
        assert!(d.steps[0].threads.is_empty());
        assert_eq!(d.steps[1].anchor, "b.rs");
        assert_eq!(d.steps[1].threads.len(), 1);
        assert!(d.unanchored.is_empty());
    }

    // ---- IC-2: resolve / reopen round-trip --------------------------------

    #[test]
    fn resolve_and_reopen_drive_the_native_mutations() {
        let (gh, dir) = fake();

        let resolved = gh.resolve_thread(dir.path(), "PRRT_1").expect("resolve");
        assert!(resolved, "resolve returns the new resolved state");
        assert!(last_args(dir.path()).contains("resolveReviewThread"));
        assert!(last_args(dir.path()).contains("threadId=PRRT_1"));

        let reopened = gh.reopen_thread(dir.path(), "PRRT_1").expect("reopen");
        assert!(!reopened, "reopen returns the new (unresolved) state");
        assert!(last_args(dir.path()).contains("unresolveReviewThread"));
    }

    // ---- IC-3: edit / delete own comments ---------------------------------

    #[test]
    fn edit_comment_patches_the_review_comment() {
        let (gh, dir) = fake();
        let edited = gh
            .edit_comment(dir.path(), 2001, "edited body")
            .expect("edit");
        assert_eq!(edited.id, 2001);
        assert_eq!(edited.body, "edited body");
        // A comment you just edited is yours — capability flags reflect that.
        assert!(edited.viewer_did_author && edited.viewer_can_update);

        let args = last_args(dir.path());
        assert!(args.contains("PATCH"), "{args}");
        assert!(args.contains("pulls/comments/2001"), "{args}");
        assert!(args.contains("body=edited body"), "{args}");
    }

    #[test]
    fn delete_comment_issues_a_native_delete() {
        let (gh, dir) = fake();
        gh.delete_comment(dir.path(), 2001).expect("delete");
        let args = last_args(dir.path());
        assert!(args.contains("DELETE"), "{args}");
        assert!(args.contains("pulls/comments/2001"), "{args}");
    }

    // ---- fail loud: GitHub's own message surfaces verbatim ----------------

    #[test]
    fn editing_anothers_comment_surfaces_github_message_verbatim() {
        // IC-3: editing a comment you don't own is rejected natively; the message
        // is surfaced verbatim (the UI also hides the affordance via viewer flags).
        let dir = tempfile::tempdir().unwrap();
        let body = r#"#!/usr/bin/env bash
if [ "${1:-}" = auth ] && [ "${2:-}" = status ]; then exit 0; fi
echo 'gh: You can only edit your own comments. (HTTP 403)' >&2
exit 1
"#;
        let fake = write_script(dir.path(), "gh", body);
        let gh = GitHub::with_bins(fake, "git");
        let err = gh
            .edit_comment(dir.path(), 999, "nope")
            .expect_err("editing another's comment must fail");
        match err {
            StageError::GhFailed(msg) => {
                assert_eq!(msg, "gh: You can only edit your own comments. (HTTP 403)")
            }
            other => panic!("expected GhFailed, got {other:?}"),
        }
    }

    #[test]
    fn resolve_failure_surfaces_github_message_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        // `gh api graphql` exits non-zero when the response carries GraphQL errors.
        let body = r#"#!/usr/bin/env bash
if [ "${1:-}" = auth ] && [ "${2:-}" = status ]; then exit 0; fi
echo 'gh: Could not resolve to a node with the global id of '\''BAD'\''. (errors)' >&2
exit 1
"#;
        let fake = write_script(dir.path(), "gh", body);
        let gh = GitHub::with_bins(fake, "git");
        let err = gh
            .resolve_thread(dir.path(), "BAD")
            .expect_err("a bad thread id must fail");
        match err {
            StageError::GhFailed(msg) => {
                assert!(msg.contains("Could not resolve to a node"), "{msg}")
            }
            other => panic!("expected GhFailed, got {other:?}"),
        }
    }
}
