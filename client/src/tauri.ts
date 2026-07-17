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
import type { BranchMeta } from './generated/BranchMeta';
import type { ChangedFile } from './generated/ChangedFile';
// New-engine DTOs (ADR-0022): identity (C), publish (D), verdict/review (E-RW),
// discussion (E-IC). All generated from the Rust structs; the screens import them
// from here like the rest of the IPC boundary.
import type { CheckResult } from './generated/CheckResult';
import type { CheckStatus } from './generated/CheckStatus';
import type { CommittedDiff } from './generated/CommittedDiff';
import type { Debrief } from './generated/Debrief';
import type { DebriefStep } from './generated/DebriefStep';
import type { DiffStats } from './generated/DiffStats';
import type { DraftLineComment } from './generated/DraftLineComment';
import type { FetchOutcome } from './generated/FetchOutcome';
import type { FileStatus } from './generated/FileStatus';
import type { GitHubUser } from './generated/GitHubUser';
import type { IssueComment } from './generated/IssueComment';
import type { LineComment } from './generated/LineComment';
import type { LocalDefault } from './generated/LocalDefault';
import type { MergeMethod } from './generated/MergeMethod';
import type { NoteAnchor } from './generated/NoteAnchor';
import type { NoteReply } from './generated/NoteReply';
import type { NoteStatus } from './generated/NoteStatus';
import type { OpenIntent } from './generated/OpenIntent';
import type { OpenMode } from './generated/OpenMode';
import type { OverviewKind } from './generated/OverviewKind';
import type { OverviewRow } from './generated/OverviewRow';
import type { OverviewView } from './generated/OverviewView';
import type { PrActivity } from './generated/PrActivity';
import type { PrDiscussion } from './generated/PrDiscussion';
import type { PrRef } from './generated/PrRef';
import type { PublishAction } from './generated/PublishAction';
import type { PublishOutcome } from './generated/PublishOutcome';
import type { PublishReadiness } from './generated/PublishReadiness';
import type { PublishRequest } from './generated/PublishRequest';
import type { PushOutcome } from './generated/PushOutcome';
import type { RecentRepo } from './generated/RecentRepo';
import type { ReplyAuthor } from './generated/ReplyAuthor';
import type { RepoInfo } from './generated/RepoInfo';
import type { RepoSummary } from './generated/RepoSummary';
import type { Review } from './generated/Review';
import type { ReviewRole } from './generated/ReviewRole';
import type { ReviewSignal } from './generated/ReviewSignal';
import type { ReviewStatus } from './generated/ReviewStatus';
import type { ReviewSummary } from './generated/ReviewSummary';
import type { ReviewThread } from './generated/ReviewThread';
import type { ReviewerEntry } from './generated/ReviewerEntry';
import type { ReviewerPr } from './generated/ReviewerPr';
import type { ReviewerStep } from './generated/ReviewerStep';
import type { SelfReviewDiff } from './generated/SelfReviewDiff';
import type { SelfReviewFileChange } from './generated/SelfReviewFileChange';
import type { SelfReviewNote } from './generated/SelfReviewNote';
import type { SelfReviewNoteView } from './generated/SelfReviewNoteView';
import type { SelfReviewScope } from './generated/SelfReviewScope';
import type { SelfReviewStats } from './generated/SelfReviewStats';
import type { Side } from './generated/Side';
import type { StaleReason } from './generated/StaleReason';
import type { StepStaleness } from './generated/StepStaleness';
import type { StepThreads } from './generated/StepThreads';
import type { StorylinePreview } from './generated/StorylinePreview';
import type { StorylineStep } from './generated/StorylineStep';
import type { StorylineStepView } from './generated/StorylineStepView';
import type { SubmittedVerdict } from './generated/SubmittedVerdict';
import type { ThreadComment } from './generated/ThreadComment';
import type { Verdict } from './generated/Verdict';
import type { WorktreeInfo } from './generated/WorktreeInfo';
import type { WorktreeMeta } from './generated/WorktreeMeta';

export type {
  ActivityLogEntry,
  ActivityLogLevel,
  ActivityLogPill,
  BaseOptions,
  BranchInfo,
  BranchMeta,
  ChangedFile,
  CommittedDiff,
  Debrief,
  DebriefStep,
  DiffStats,
  FetchOutcome,
  FileStatus,
  LocalDefault,
  NoteAnchor,
  NoteReply,
  NoteStatus,
  OpenIntent,
  OpenMode,
  OverviewKind,
  OverviewRow,
  OverviewView,
  PrRef,
  PushOutcome,
  RecentRepo,
  ReplyAuthor,
  RepoInfo,
  RepoSummary,
  Review,
  ReviewRole,
  ReviewSignal,
  ReviewStatus,
  ReviewerEntry,
  ReviewerPr,
  ReviewerStep,
  SelfReviewNote,
  SelfReviewNoteView,
  SelfReviewDiff,
  SelfReviewFileChange,
  SelfReviewScope,
  SelfReviewStats,
  Side,
  StaleReason,
  StepStaleness,
  StorylinePreview,
  StorylineStep,
  StorylineStepView,
  WorktreeInfo,
  WorktreeMeta,
  CheckResult,
  CheckStatus,
  DraftLineComment,
  GitHubUser,
  IssueComment,
  LineComment,
  MergeMethod,
  PrActivity,
  PrDiscussion,
  PublishAction,
  PublishOutcome,
  PublishReadiness,
  PublishRequest,
  ReviewSummary,
  ReviewThread,
  StepThreads,
  SubmittedVerdict,
  ThreadComment,
  Verdict,
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
 *  The only valid PR base targets — sourced by the base picker. */
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

/**
 * The unified per-repo overview (DB-1..5 + the local branch list, ADR-0022
 * §6/§7): local branches with worktree annotations, per-machine drafts,
 * published Reviews, and my GitHub PRs — one row list, every row's state
 * derived in Rust (this is the pure-render boundary; the screen only buckets
 * by `kind` and displays).
 * `includeArchived` flips the DB-5 view filter (closed/merged PRs hidden by
 * default). `includeGithub: false` asks for the purely-local view — used after
 * a loud `gh` failure so local rows still render next to the error (ID-3 #56).
 */
export const overview = (includeArchived: boolean, includeGithub: boolean) =>
  invoke<OverviewView>('overview', { includeArchived, includeGithub });

/**
 * The unified storyline-staleness check (ST-1, ADR-0022 §7) for the active
 * repo+branch: each step's anchor vs. the current committed diff, with a per-step
 * reason. An empty array means there is no storyline to check. Nothing
 * auto-fixes — the author re-anchors by hand.
 */
export const storylineStaleness = () => invoke<StepStaleness[]>('storyline_staleness');

export const openInFinder = (path: string) => invoke<void>('open_in_finder', { path });

export const openUrl = (url: string) => invoke<void>('open_url', { url });

// --- Local storyline (no auth/sign-in; ADR-0022 §1/§3, milestone B) ---
// The author's pre-publish storyline lives in the local store, keyed by the
// active repo + branch. No `gh`/network here — Publish (milestone D) is what
// reaches GitHub. All derived state (the diff overlay, stale flags) is computed
// in Rust; these calls only ferry view-ready DTOs to the screen (ADR-0022 §7).

/** The draft Review for the active repo + branch, or null if "Ready to share"
 *  hasn't been triggered on this machine for this branch (WS-2 #60). */
export const reviewDraftGet = () => invoke<Review | null>('review_draft_get');

/** "Ready to share" (WS-2 #60): create the per-machine draft Review. Fails loud
 *  if one already exists — it's a one-time transition, not an upsert. */
export const reviewDraftCreate = (title: string, baseRef: string) =>
  invoke<Review>('review_draft_create', { title, baseRef });

/** Rename the draft Review's human-readable title (WS-3 #61). */
export const reviewDraftSetTitle = (title: string) =>
  invoke<Review>('review_draft_set_title', { title });

/** Discard the draft Review and its storyline steps (GAP-1 #91). Idempotent.
 *  `branch` targets a draft other than the focused worktree's (the overview's
 *  discard action); omitted, the focused branch's draft is discarded. */
export const reviewDraftDiscard = (branch?: string) =>
  invoke<boolean>('review_draft_discard', { branch: branch ?? null });

/** Change the draft's base (target) branch pre-publish (GAP-2 #92). Once
 *  published the base is the PR's merge target — changed on GitHub, not here. */
export const reviewDraftSetBase = (baseRef: string) =>
  invoke<Review>('review_draft_set_base', { baseRef });

/** The draft storyline steps for the active repo + branch, in author order. */
export const storylineSteps = () => invoke<StorylineStep[]>('storyline_steps');

/** Compose a step (SL-1/SL-2): append one anchored to `anchor`. Fails loud if
 *  `anchor` isn't in the committed diff or a step already anchors it. */
export const storylineStepAdd = (anchor: string, title: string | null, intro: string) =>
  invoke<StorylineStep>('storyline_step_add', { anchor, title, intro });

/** Edit a step's title + intro (SL-2/SL-3). `title: null` clears the heading. */
export const storylineStepEdit = (id: string, title: string | null, intro: string) =>
  invoke<StorylineStep>('storyline_step_edit', { id, title, intro });

/** Remove a step from the draft storyline (SL-3). */
export const storylineStepRemove = (id: string) => invoke<void>('storyline_step_remove', { id });

/** Reorder the draft storyline to exactly `orderedIds` (SL-3). Fails loud unless
 *  the list is a permutation of the current step ids. */
export const storylineStepsReorder = (orderedIds: string[]) =>
  invoke<StorylineStep[]>('storyline_steps_reorder', { orderedIds });

/** The author-side local storyline preview (SL-4 author side + GAP-4): the full
 *  tree-to-tree diff, the ordered steps with `stale` flags, and the un-anchored
 *  paths still reachable as an overlay. Fails loud if there's no draft. */
export const storylinePreview = () => invoke<StorylinePreview>('storyline_preview');

// --- Reviewer entry (open a PR read-only; ADR-0022 §6, milestone F) ---
// The local-first reviewer flow: `stage open <pr-url>` resolves the PR to this
// clone (origin match) and lands here. All derived state (the tree-to-tree diff,
// the storyline overlay, stale flags) is computed in Rust; the screen only
// renders the DTO (ADR-0022 §7). No `.stage`/`gh`/`git` is read from TS.

/** Open `pr` for review against the active repo's clone, **read-only**: resolve
 *  the PR via `gh`, `git fetch` its head, and render the tree-to-tree committed
 *  diff plus the author's storyline read from the committed `.stage/<branch>/` —
 *  with no working-tree mutation. Fails loud with `gh`/`git`'s real cause (e.g.
 *  `gh auth login` needed), which the caller renders in a red banner. */
export const reviewOpen = (pr: PrRef) => invoke<ReviewerEntry>('review_open', { pr });

/** Check out the PR's `branch` (`git checkout -B`) — **the lone working-tree
 *  mutation the reviewer flow performs** (ADR-0022 §6), so the reviewer can
 *  build/run. The screen gates this behind an explicit "Check out this branch"
 *  confirmation; everything else stays read-only. Fails loud (git's stderr) on a
 *  dirty tree or a missing fetched head. */
export const reviewCheckoutBranch = (pr: PrRef, branch: string) =>
  invoke<void>('review_checkout_branch', { pr, branch });

// --- Identity (ADR-0022 §5, milestone C) ---
// Stage holds no account/session. "Who am I" is just the local `gh` token owner.

/** The `gh` token owner — Stage's whole identity (no account, no session, no
 *  sign-in). Rejects with `gh`'s message verbatim if `gh` is absent or
 *  unauthenticated (the caller renders it and points at `gh auth login`). */
export const ghIdentity = () => invoke<GitHubUser>('gh_identity');

// --- Publish (PUB-1..7, ADR-0022 §3/§7, milestone D) ---
// The one-action publish: serialize the local draft into `.stage/<branch>/`,
// commit, push, and create/update/reopen the PR via `gh`. All derived in Rust.

/** Whether the active repo+branch draft is ready to publish (≥1 step, every step
 *  has a non-empty intro). Render `ready` plus `stepsMissingIntro` as the gaps. */
export const publishReadiness = () => invoke<PublishReadiness>('publish_readiness');

/** Publish/re-publish the draft Review to GitHub: write `.stage/<branch>/`, scoped
 *  commit, push (user's own git creds), and create/update/reopen the PR via `gh`
 *  (auto-posting the one "Open in Stage" comment on first create). Rejects with the
 *  fail-loud message (not-ready draft, or gh/git failure) for the caller's banner. */
export const reviewPublish = (req: PublishRequest) =>
  invoke<PublishOutcome>('review_publish', { req });

// --- Native GitHub review & verdict (RW-1..5, ADR-0022 §4/§8, milestone E) ---
// The reviewer's write-through to GitHub via the user's own `gh`. All take the PR
// number; the active repo's clone is resolved on the Rust side.

/** Read a PR's existing activity in one shot (RW-4): state, verdict decision,
 *  reviews, conversation + line comments, and CI checks. */
export const prActivity = (prNumber: number) => invoke<PrActivity>('pr_activity', { prNumber });

/** Submit the overall review verdict (RW-3): `approve` / `requestChanges` /
 *  `comment`, with a summary body and an optional batch of line comments.
 *  `requestChanges`/`comment` require a non-empty body (Rust-enforced). */
export const prSubmitVerdict = (
  prNumber: number,
  verdict: Verdict,
  body: string,
  comments: DraftLineComment[],
) => invoke<SubmittedVerdict>('pr_submit_verdict', { prNumber, verdict, body, comments });

/** Post a single inline review comment anchored to a diff line (RW-2). */
export const prCommentOnLine = (prNumber: number, comment: DraftLineComment) =>
  invoke<LineComment>('pr_comment_on_line', { prNumber, comment });

/** Post a file-level review comment (RW-2) — not anchored to a specific line. */
export const prCommentOnFile = (prNumber: number, path: string, body: string) =>
  invoke<LineComment>('pr_comment_on_file', { prNumber, path, body });

/** Merge the PR (RW-5) with the given method. */
export const prMerge = (prNumber: number, method: MergeMethod) =>
  invoke<void>('pr_merge', { prNumber, method });

/** Close the PR without merging (RW-5). */
export const prClose = (prNumber: number) => invoke<void>('pr_close', { prNumber });

/** Flip the PR's draft status (RW-5): true → mark draft, false → ready. */
export const prSetDraft = (prNumber: number, draft: boolean) =>
  invoke<void>('pr_set_draft', { prNumber, draft });

// --- Per-step PR discussion (IC-1..3, ADR-0022 §4, milestone E) ---
// Step discussion is GitHub PR review threads, code-anchored to each step's diff
// location (IntroComment is removed). Pass the steps' anchors (already known to
// the screen) to group threads by step; threads elsewhere come back `unanchored`.

/** The PR's review threads mapped onto the storyline (IC-1). `stepAnchors` are the
 *  steps' diff paths the screen already holds (reviewer entry / draft storyline). */
export const prDiscussion = (prNumber: number, stepAnchors: string[]) =>
  invoke<PrDiscussion>('pr_discussion', { prNumber, stepAnchors });

/** Start a code-anchored discussion thread on a step (IC-1): a line comment when
 *  `line` is set, else a file-level comment. `anchor` is the step's diff path. */
export const prStartThread = (
  prNumber: number,
  anchor: string,
  line: number | null,
  side: Side | null,
  body: string,
) => invoke<LineComment>('pr_start_thread', { prNumber, anchor, line, side, body });

/** Reply to a thread (IC-1), addressing its root comment id. */
export const prReplyThread = (prNumber: number, inReplyTo: number, body: string) =>
  invoke<ThreadComment>('pr_reply_thread', { prNumber, inReplyTo, body });

/** Resolve a review thread (IC-2) by its GraphQL node id. */
export const prResolveThread = (threadId: string) =>
  invoke<boolean>('pr_resolve_thread', { threadId });

/** Reopen a resolved review thread (IC-2) by its GraphQL node id. */
export const prReopenThread = (threadId: string) =>
  invoke<boolean>('pr_reopen_thread', { threadId });

/** Edit one's own thread comment (IC-3) by its REST id (gated by `viewerCanUpdate`). */
export const prEditComment = (commentId: number, body: string) =>
  invoke<ThreadComment>('pr_edit_comment', { commentId, body });

/** Delete one's own thread comment (IC-3) by its REST id (gated by `viewerCanDelete`). */
export const prDeleteComment = (commentId: number) =>
  invoke<void>('pr_delete_comment', { commentId });

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
