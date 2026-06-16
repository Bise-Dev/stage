import { invoke } from '@tauri-apps/api/core';
import { type UnlistenFn, listen } from '@tauri-apps/api/event';

// --- Generated IPC types (ts-rs) ---------------------------------------------
// These types are GENERATED from the Rust structs in `src-tauri` / `stage-core`
// (`just gen-types`, committed under `src/generated/`) — the single source of
// truth for the Tauri command boundary. Do not hand-edit them. We import them
// here and re-export below so existing call sites keep importing the IPC types
// from `./tauri` (the boundary's one import surface). Tier-2 commands that still
// proxy a raw `serde_json::Value` from the backend keep their hand-written types
// further down — there is no Rust struct to generate those from yet (ADR-0001).
import type { ActivityLogEntry } from './generated/ActivityLogEntry';
import type { ActivityLogLevel } from './generated/ActivityLogLevel';
import type { ActivityLogPill } from './generated/ActivityLogPill';
import type { BaseOptions } from './generated/BaseOptions';
import type { BranchInfo } from './generated/BranchInfo';
import type { ChangedFile } from './generated/ChangedFile';
import type { CommittedDiff } from './generated/CommittedDiff';
import type { Debrief } from './generated/Debrief';
import type { DebriefStep } from './generated/DebriefStep';
import type { DiffStats } from './generated/DiffStats';
import type { FetchOutcome } from './generated/FetchOutcome';
import type { FileStatus } from './generated/FileStatus';
import type { GithubPrSearchItem } from './generated/GithubPrSearchItem';
import type { GithubUserRef } from './generated/GithubUserRef';
import type { LocalDefault } from './generated/LocalDefault';
import type { NoteAnchor } from './generated/NoteAnchor';
import type { NoteReply } from './generated/NoteReply';
import type { NoteStatus } from './generated/NoteStatus';
import type { OpenIntent } from './generated/OpenIntent';
import type { OpenMode } from './generated/OpenMode';
import type { PushOutcome } from './generated/PushOutcome';
import type { RecentRepo } from './generated/RecentRepo';
import type { ReplyAuthor } from './generated/ReplyAuthor';
import type { RepoInfo } from './generated/RepoInfo';
import type { RepoSummary } from './generated/RepoSummary';
import type { SelfReviewDiff } from './generated/SelfReviewDiff';
import type { SelfReviewFileChange } from './generated/SelfReviewFileChange';
import type { SelfReviewNote } from './generated/SelfReviewNote';
import type { SelfReviewNoteView } from './generated/SelfReviewNoteView';
import type { SelfReviewScope } from './generated/SelfReviewScope';
import type { SelfReviewStats } from './generated/SelfReviewStats';
import type { Side } from './generated/Side';
import type { Storyline } from './generated/Storyline';
import type { StorylineFile } from './generated/StorylineFile';
import type { StorylineFileWrite } from './generated/StorylineFileWrite';
import type { User } from './generated/User';
import type { WorktreeInfo } from './generated/WorktreeInfo';

export type {
  ActivityLogEntry,
  ActivityLogLevel,
  ActivityLogPill,
  BaseOptions,
  BranchInfo,
  ChangedFile,
  CommittedDiff,
  Debrief,
  DebriefStep,
  DiffStats,
  FetchOutcome,
  FileStatus,
  GithubPrSearchItem,
  GithubUserRef,
  LocalDefault,
  NoteAnchor,
  NoteReply,
  NoteStatus,
  OpenIntent,
  OpenMode,
  PushOutcome,
  RecentRepo,
  ReplyAuthor,
  RepoInfo,
  RepoSummary,
  SelfReviewNote,
  SelfReviewNoteView,
  SelfReviewDiff,
  SelfReviewFileChange,
  SelfReviewScope,
  SelfReviewStats,
  Side,
  Storyline,
  StorylineFile,
  StorylineFileWrite,
  User,
  WorktreeInfo,
};

// --- `stage open` boot intent (ADR-0014) ---
/**
 * Cold start: drain this launch's pending `stage open` intent, consumed once
 * (cleared on the Rust side). Resolves to `null` for a plain dock/Finder
 * launch. Warm starts arrive via {@link onOpenIntent} instead.
 */
export const takeOpenIntent = () => invoke<OpenIntent | null>('take_open_intent');

/**
 * Warm start: a later `stage open` forwards its intent to the already-running
 * app via the `open-intent` event (ADR-0014). Returns the unlisten handle.
 */
export const onOpenIntent = (cb: (intent: OpenIntent) => void): Promise<UnlistenFn> =>
  listen<OpenIntent>('open-intent', (event) => cb(event.payload));

/**
 * The native app menu's "Settings…" item (⌘,) emits `open-settings`; the webview
 * listens and routes to the Settings view. Returns the unlisten handle.
 */
export const onOpenSettings = (cb: () => void): Promise<UnlistenFn> =>
  listen('open-settings', () => cb());

/** The worktrees git reports for the active Repo, root first. Re-enumerated
 *  from git on every call (Stage holds no registry). */
export const repoWorktrees = () => invoke<WorktreeInfo[]>('repo_worktrees');

/** Focus a different worktree for Self-Review. Observe-only: re-points which
 *  worktree's working tree the diff reads; never checks out. Returns the new
 *  active (focused) repo info. */
export const setFocusedWorktree = (path: string) =>
  invoke<RepoInfo>('set_focused_worktree', { path });

/** Fires when git's worktree set may have changed (e.g. an external tool added
 *  or finished a worktree). Re-fetch {@link repoWorktrees}. Returns the unlisten
 *  handle. */
export const onWorktreesChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen('worktrees-changed', () => cb());

/** Fires on any working-tree / `.git` change in the focused worktree (existing
 *  watcher). Returns the unlisten handle. */
export const onRepoChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen('repo-changed', () => cb());

export const setActiveRepo = (path: string) => invoke<RepoInfo>('set_active_repo', { path });

export const getActiveRepo = () => invoke<RepoInfo | null>('get_active_repo');

export const listRecentRepos = () => invoke<RecentRepo[]>('list_recent_repos');

export const forgetRecentRepo = (path: string) => invoke<void>('forget_recent_repo', { path });

export const gitCurrentBranch = () => invoke<string>('git_current_branch');

export const repoSummary = (path: string) => invoke<RepoSummary>('repo_summary', { path });

export const gitLocalBranches = () => invoke<BranchInfo[]>('git_local_branches');

/** Remote branches (e.g. `origin/main`), recency-sorted, `origin/HEAD` skipped.
 *  The only valid PR base targets — sourced by the New Workspace base picker. */
export const gitRemoteBranches = () => invoke<BranchInfo[]>('git_remote_branches');

export const gitDiffStats = (baseRef: string, headRef: string) =>
  invoke<DiffStats>('git_diff_stats', { baseRef, headRef });

export const gitDiffFiles = (baseRef: string, headRef: string) =>
  invoke<ChangedFile[]>('git_diff_files', { baseRef, headRef });

// --- Self-Review diff (see docs/adr/0010, CONTEXT.md "Self-Review") ---
/**
 * Compute the diff the Self-Review screen renders. `baseRef` is required when
 * `scope === 'base'` and ignored otherwise; the active repo is resolved on
 * the Rust side from app state, not passed from the frontend.
 */
export const selfReviewDiff = (scope: SelfReviewScope, baseRef: string | null) =>
  invoke<SelfReviewDiff>('self_review_diff', { scope, baseRef });

/** The committed diff a storyline composes over and the PR will contain:
 *  `merge_base(base, head) → head`. Reuses the Self-Review file-change shape but
 *  reads no working tree, so it is independent of what is checked out. */
export const storylineDiff = (baseRef: string, headRef: string) =>
  invoke<CommittedDiff>('storyline_diff', { baseRef, headRef });

export const gitFetch = () => invoke<FetchOutcome>('git_fetch');

/** Push `branch` to the primary remote with the user's own git credentials
 *  (ADR-0016), setting upstream. Surfaces git's stderr verbatim on failure
 *  (no write access, protected branch, …). */
export const gitPush = (branch: string) => invoke<PushOutcome>('git_push', { branch });

export const selfReviewBaseOptions = () => invoke<BaseOptions>('self_review_base_options');

// --- Repo overview (Stage + GitHub aggregation; see docs/adr/0009) ---
// Tier 2: `repo_overview` proxies a raw `serde_json::Value` from the backend, so
// these rows have no Rust struct to generate from and stay hand-written here.
export type WorkspaceState =
  | 'draft'
  | 'ready_to_publish'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'archived';

export type OverviewWorkspaceRow = {
  kind: 'workspace';
  id: string;
  title: string;
  repo_owner: string;
  repo_name: string;
  head_ref: string;
  base_ref: string;
  pr_number: number | null;
  created_by: { id: number; github_login: string };
  last_active_at: string;
  storyline_count: number;
  state: WorkspaceState;
  added: number | null;
  removed: number | null;
  comment_count: number | null;
};

export type OverviewOpenPrRow = {
  kind: 'open_pr';
  number: number;
  title: string;
  html_url: string;
  repo_owner: string;
  repo_name: string;
  head_ref: string | null;
  author: { login: string | null; avatar_url: string | null };
  role: 'author' | 'reviewer';
  updated_at: string | null;
  added: number | null;
  removed: number | null;
};

export type OverviewRow = OverviewWorkspaceRow | OverviewOpenPrRow;

/** Structured rejection from `repoOverview` when Stage's GitHub App can't
 *  reach the repo (backend 403, code `github_app_no_access`; see docs/adr/0017).
 *  `install_url` is null when the app slug isn't configured (message-only
 *  fallback). All *other* command failures still reject with a bare string. */
export type RepoAccessError = {
  kind: 'github_app_no_access';
  message: string;
  install_url: string | null;
};

export const repoOverview = (owner: string, repo: string) =>
  invoke<OverviewRow[]>('repo_overview', { owner, repo });

export const openInFinder = (path: string) => invoke<void>('open_in_finder', { path });

export const openUrl = (url: string) => invoke<void>('open_url', { url });

// --- Auth wrappers ---
export const authSignIn = () => invoke<User>('auth_sign_in');
export const authSignInCancel = () => invoke<void>('auth_sign_in_cancel');
export const authMe = () => invoke<User>('auth_me');
/**
 * Validate a persisted session token at boot (ADR-0013). Resolves to the
 * signed-in `User` when a stored token is still valid, or `null` when there's
 * no token / the backend rejected it (dead session — cleared on the Rust side).
 * Rejects on other backend failures.
 */
export const authBootstrap = () => invoke<User | null>('auth_bootstrap');
export const authLogout = () => invoke<void>('auth_logout');

// --- GitHub proxy ---
export const githubPrs = (role: 'author' | 'reviewer') =>
  invoke<GithubPrSearchItem[]>('github_prs', { role });

/** The GitHub file object for one path in a PR, as the backend proxies it
 *  (raw GitHub shape; only the fields the reviewer viewer maps are typed).
 *  `status` is GitHub's vocabulary (`removed`, not `deleted`); `patch` is
 *  absent for binary files and oversize diffs.
 *  Tier 2: backend `serde_json::Value` passthrough — hand-written. */
export type GithubPrFile = {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string;
};

/** Fetch one file's diff from a PR on GitHub, via the backend (ADR-0001). The
 *  reviewer storyline viewer uses this because the reviewer may not have the
 *  branch checked out locally. A path no longer in the PR (a stale step)
 *  rejects with the backend's 404. */
export const prFileDiff = (owner: string, repo: string, prNumber: number, filePath: string) =>
  invoke<GithubPrFile>('pr_file_diff', { owner, repo, prNumber, filePath });

/** Which side of the diff a review comment anchors to (GitHub's vocabulary).
 *  `RIGHT` = the new (head) version, `LEFT` = the old (base) version. */
export type GithubCommentSide = 'LEFT' | 'RIGHT';

/** A PR-level (issue) comment — not anchored to any line. Raw GitHub shape;
 *  only the fields the reviewer viewer renders are typed. */
export type GithubIssueComment = {
  id: number;
  body: string;
  user: GithubUserRef | null;
  created_at: string;
  html_url?: string;
};

/** A review (line-anchored) comment. `line`/`side` place it in the *current*
 *  diff; when the comment has slid off the current diff GitHub nulls `line` and
 *  keeps `original_line`/`original_side` (the viewer falls back to those and, if
 *  the line still isn't in the rendered hunk, lists it as off-diff rather than
 *  dropping it — fail loud). `in_reply_to_id` threads replies under their root. */
export type GithubReviewComment = {
  id: number;
  in_reply_to_id: number | null;
  path: string;
  line: number | null;
  original_line: number | null;
  start_line: number | null;
  side: GithubCommentSide | null;
  original_side: GithubCommentSide | null;
  body: string;
  user: GithubUserRef | null;
  created_at: string;
  html_url?: string;
};

/** The `{ issue, review }` envelope the backend returns for a PR's comments. */
export type PrComments = {
  issue: GithubIssueComment[];
  review: GithubReviewComment[];
};

/** All comments on a PR (issue + review), via the backend (ADR-0001). Includes
 *  activity left by non-Stage participants on github.com (ADR-0003). */
export const prComments = (owner: string, repo: string, prNumber: number) =>
  invoke<PrComments>('pr_comments', { owner, repo, prNumber });

/** All submitted reviews on a PR, via the backend (ADR-0001). */
export const prReviews = (owner: string, repo: string, prNumber: number) =>
  invoke<GithubReview[]>('pr_reviews', { owner, repo, prNumber });

export type GithubReviewState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'DISMISSED'
  | 'PENDING';

/** A submitted review. `state` drives the review-decision banner; `body` is the
 *  review's summary text (may be empty for a bare approval). */
export type GithubReview = {
  id: number;
  user: GithubUserRef | null;
  body: string;
  state: GithubReviewState;
  submitted_at: string | null;
  html_url?: string;
};

/** A review verdict the reviewer can submit (Step 4). GitHub's create-review
 *  `event` vocabulary; maps to the workspace states the overview shows. */
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/** The body for posting a PR comment write-through to GitHub (ADR-0003). A fresh
 *  review *line* comment carries `path`+`line`+`side`+`commit_id`; a reply
 *  carries `in_reply_to`+`body`; a PR-level note is just `kind:'issue'`+`body`.
 *  The backend validates the combination. */
export type PrCommentCreateInput = {
  kind: 'issue' | 'review';
  body: string;
  path?: string | null;
  line?: number | null;
  side?: GithubCommentSide | null;
  commit_id?: string | null;
  in_reply_to?: number | null;
};

/** Post a comment on a PR, write-through to GitHub as the signed-in user
 *  (ADR-0003). Resolves to the created `GithubReviewComment` (or issue comment).
 *  Rejects with the backend message verbatim — incl. `409` for an archived
 *  (closed/merged) workspace — which the caller renders in a red banner. */
export const prCommentCreate = (
  owner: string,
  repo: string,
  prNumber: number,
  payload: PrCommentCreateInput,
) => invoke<GithubReviewComment>('pr_comment_create', { owner, repo, prNumber, payload });

/** Submit a review verdict on a PR, write-through to GitHub (ADR-0003). `body`
 *  must be non-empty (backend contract). `comments` optionally batches line
 *  comments into the review. Resolves to the created `GithubReview`. */
export const prReviewCreate = (
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  event: ReviewEvent,
  comments?: PrCommentCreateInput[],
) => invoke<GithubReview>('pr_review_create', { owner, repo, prNumber, body, event, comments });

// --- IntroComments (Stage-native storyline-intro discussion; ADR-0001) ---
// A threaded discussion on a storyline step's *intro* — Stage's value-add
// narrative layer. Unlike PR comments, these have NO GitHub counterpart and
// never write through. `replies` nests one level only (backend enforces
// depth ≤ 2). `user`/`resolved_by` carry the backend user id (number) +
// GitHub login; `resolved_*` are non-null only on a resolved root.
// Tier 2: backend `serde_json::Value` passthrough — hand-written.
export type IntroComment = {
  id: string;
  user: { id: number; github_login: string };
  body: string;
  parent_id: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: { id: number; github_login: string } | null;
  replies: IntroComment[];
};

/** List a storyline step's intro-comment thread (roots, each with nested
 *  `replies`). `includeResolved` (default false) reveals resolved roots. The
 *  `fileId` is the StorylineFile UUID (`Storyline.files[].id`), not the path. */
export const introCommentsList = (workspaceId: string, fileId: string, includeResolved: boolean) =>
  invoke<IntroComment[]>('intro_comments_list', { workspaceId, fileId, includeResolved });

/** Post an intro-comment — a root, or a reply when `parentId` is set (depth ≤ 2,
 *  backend-enforced). Rejects with the backend message verbatim (incl. `409`
 *  for a frozen workspace), which the caller renders in a red banner. */
export const introCommentCreate = (
  workspaceId: string,
  fileId: string,
  body: string,
  parentId: string | null,
) => invoke<IntroComment>('intro_comment_create', { workspaceId, fileId, body, parentId });

/** Edit an intro-comment's body (author only — backend 403s otherwise). */
export const introCommentUpdate = (commentId: string, body: string) =>
  invoke<IntroComment>('intro_comment_update', { commentId, body });

/** Soft-delete an intro-comment (author only). Resolves to void (backend 204). */
export const introCommentDelete = (commentId: string) =>
  invoke<void>('intro_comment_delete', { commentId });

/** Resolve a root intro-comment (workspace creator only; roots only). */
export const introCommentResolve = (commentId: string) =>
  invoke<IntroComment>('intro_comment_resolve', { commentId });

/** Unresolve a previously-resolved root intro-comment (workspace creator only). */
export const introCommentUnresolve = (commentId: string) =>
  invoke<IntroComment>('intro_comment_unresolve', { commentId });

/** Context for opening a published workspace in the read-only reviewer viewer
 *  (Step 2 of the reviewer flow). Built from an `OverviewWorkspaceRow` whose
 *  `pr_number` is non-null (only published workspaces are reviewable). Carries
 *  the overview row's display fields so the viewer's PR-context subheader
 *  renders without a second fetch. Client-only (assembled in the webview). */
export type ReviewCtx = {
  workspaceId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headRef: string;
  baseRef: string;
  title: string;
  /** GitHub login of the workspace author (whose storyline you're reviewing). */
  author: string;
  state: WorkspaceState;
  /** PR-wide line counts from the overview (GitHub), or null if unavailable. */
  added: number | null;
  removed: number | null;
};

// --- Workspaces ---
// Tier 2: `workspace_*` proxy the backend's `serde_json::Value` — hand-written.
export type WorkspaceCreateInput = {
  repoOwner: string;
  repoName: string;
  headRef: string;
  baseRef: string;
  title: string;
};

// The created workspace (subset of WorkspaceOutputSerializer we use to navigate
// straight into storyline composition). The caller also re-fetches the overview.
export type WorkspaceCreated = {
  id: string;
  repo_owner: string;
  repo_name: string;
  head_ref: string;
  base_ref: string;
  title: string;
};
export const workspaceCreate = (input: WorkspaceCreateInput) =>
  invoke<WorkspaceCreated>('workspace_create', input);

/** Update a pre-publish workspace's refs (only the given fields). The backend
 *  rejects this with 409 once a PR is open — refs are locked post-publish. */
export const workspaceUpdate = (
  workspaceId: string,
  patch: { baseRef?: string; headRef?: string },
) =>
  invoke<WorkspaceCreated>('workspace_update', {
    workspaceId,
    baseRef: patch.baseRef ?? null,
    headRef: patch.headRef ?? null,
  });

export const workspaceDelete = (workspaceId: string) =>
  invoke<void>('workspace_delete', { workspaceId });

/**
 * Publish a workspace to GitHub. Pushes its branch with the user's own git
 * credentials (ADR-0016), then — unless `alreadyPublished` — opens or adopts the
 * PR via the backend. With `alreadyPublished` it only re-pushes ("Push update").
 * The caller re-fetches the overview; the resolved value (the raw backend
 * `{workspace, pr, warnings}` envelope, or `{ pushed: true }` for a push-only
 * update) is not otherwise consumed.
 */
export const workspacePublish = (input: {
  workspaceId: string;
  headRef: string;
  title: string;
  body: string | null;
  alreadyPublished: boolean;
}) => invoke<unknown>('workspace_publish', input);

// --- Storyline ---
export const storylineGet = (workspaceId: string) =>
  invoke<Storyline>('storyline_get', { workspaceId });

export const storylineUpdate = (workspaceId: string, etag: string, files: StorylineFileWrite[]) =>
  invoke<Storyline>('storyline_update', { workspaceId, etag, files });

// --- Self-Review Debrief (cycle 1: local agent↔author loop; see ADR-0011,
// CONTEXT.md "Debrief" / "Review note"). All local + auth-free. ---

/** The stored Debrief for the active repo + branch, or `null` if none. */
export const selfReviewDebriefGet = () => invoke<Debrief | null>('self_review_debrief_get');

/** Branch names that have a stored Debrief for the active repo (branch-agnostic,
 *  repo-wide). Lets the branch list flag which branches carry a Debrief. */
export const repoDebriefBranches = () => invoke<string[]>('repo_debrief_branches');

/** Review notes for the active repo + branch, optionally filtered by status. */
export const selfReviewNotesList = (status?: NoteStatus) =>
  invoke<SelfReviewNoteView[]>('self_review_notes_list', { status: status ?? null });

/** Create an `open` Review note. `anchor` is null for general feedback (UUID
 *  minted in Rust). */
export const selfReviewNoteCreate = (anchor: NoteAnchor | null, body: string) =>
  invoke<SelfReviewNote>('self_review_note_create', { anchor, body });

/** Author action: append an author reply to a note's thread (re-raises an
 *  addressed/resolved note to `open`). */
export const selfReviewNoteReply = (id: string, body: string) =>
  invoke<SelfReviewNote>('self_review_note_reply', { id, body });

/** Author action: close a note (`resolved`). */
export const selfReviewNoteResolve = (id: string) =>
  invoke<SelfReviewNote>('self_review_note_resolve', { id });

/** Author action: reopen a note (`open`). */
export const selfReviewNoteReopen = (id: string) =>
  invoke<SelfReviewNote>('self_review_note_reopen', { id });

/** Author action: permanently delete a note and its thread. */
export const selfReviewNoteDelete = (id: string) => invoke<void>('self_review_note_delete', { id });

// --- Activity log (dev-only debug panel; see client/STACK.md "Activity log").
// The backing commands exist only in debug builds (gated `#[cfg(debug_assertions)]`
// on the Rust side); the webview only ever calls these from dev-gated code
// (`import.meta.env.DEV`), so a release build never invokes a missing command.
// `ActivityLogEntry` + the `ActivityLogLevel`/`ActivityLogPill` unions are
// generated from Rust (see imports above). ---

/** Full ring, oldest first — pulled when the drawer opens. */
export const activityLogSnapshot = () => invoke<ActivityLogEntry[]>('activity_log_snapshot');

/** A webview-sourced row (forwarded `console.*` or an `ErrorBoundary` catch).
 *  The input shape for `activity_log_push`; its Rust counterpart (`WebviewEntry`)
 *  deserializes `fields`/`error` via `#[serde(default)]`, so both are optional
 *  here. `level` reuses the generated `ActivityLogLevel` union. */
export type ActivityLogPushInput = {
  level: ActivityLogLevel;
  message: string;
  fields?: Record<string, string>;
  error?: string | null;
};

export const activityLogPush = (entry: ActivityLogPushInput) =>
  invoke<void>('activity_log_push', { entry });

/** Empty the ring (the drawer's Clear button). */
export const activityLogClear = () => invoke<void>('activity_log_clear');
