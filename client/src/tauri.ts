import { invoke } from '@tauri-apps/api/core';
import { type UnlistenFn, listen } from '@tauri-apps/api/event';

export type RepoInfo = { path: string };

// --- `stage open` boot intent (ADR-0014) ---
/** The screen a `stage open` lands on. Self-Review only today. */
export type OpenMode = 'selfReview';
/** A pending `stage open` request: open the GUI in `mode` for `repo` (the
 *  canonical repo root; the branch is rediscovered from that working tree). */
export type OpenIntent = { repo: string; mode: OpenMode };

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
export type RecentRepo = { path: string; lastOpenedAt: number };
export type RepoSummary = {
  defaultBranch: string | null;
  branchesCount: number;
  remoteUrl: string | null;
};
export type BranchInfo = {
  name: string;
  isHead: boolean;
  /** Last-commit time, epoch seconds (UTC). */
  updatedAt: number;
  lastCommit: string | null;
};
export type FetchOutcome = {
  remote: string;
};
export type PushOutcome = {
  remote: string;
  branch: string;
};

/** One worktree git reports for the active Repo (ADR-0016). Mirrors
 *  `stage_core::worktree::WorktreeInfo` (serde camelCase). */
export type WorktreeInfo = {
  /** Absolute working-directory path as git reports it. */
  path: string;
  /** Checked-out branch shorthand; null when detached or bare. */
  branch: string | null;
  /** HEAD commit id (40-hex); null for a bare entry. */
  head: string | null;
  /** The repo's root (main) worktree. */
  isRoot: boolean;
  /** HEAD is detached (no branch). */
  detached: boolean;
  /** A bare entry (no working directory). */
  bare: boolean;
  /** git reports it locked; the (possibly empty) reason, else null. */
  locked: string | null;
  /** git reports it prunable (dir gone/invalid); the reason, else null. */
  prunable: string | null;
};

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

export type DiffStats = { added: number; removed: number };
export const gitDiffStats = (baseRef: string, headRef: string) =>
  invoke<DiffStats>('git_diff_stats', { baseRef, headRef });

export type ChangedFile = {
  path: string;
  /** "A" added · "M" modified · "D" deleted · "?" other. Rename detection is off,
   * so a rename surfaces as a "D" + "A" pair (see `diff_files` in git.rs). */
  status: string;
  added: number;
  removed: number;
};
export const gitDiffFiles = (baseRef: string, headRef: string) =>
  invoke<ChangedFile[]>('git_diff_files', { baseRef, headRef });

// --- Self-Review diff (see docs/adr/0010, CONTEXT.md "Self-Review") ---
export type SelfReviewScope = 'workdir' | 'base';
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export type SelfReviewFileChange = {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Unified-diff text. Empty when `isBinary`. Clipped at 256 KB when `isTruncated`. */
  patch: string;
  isBinary: boolean;
  isTruncated: boolean;
};

export type SelfReviewStats = {
  added: number;
  removed: number;
  filesChanged: number;
};

export type SelfReviewDiff = {
  currentBranch: string;
  scope: SelfReviewScope;
  /** Only set when `scope === 'base'`. */
  baseRef: string | null;
  /** Short HEAD sha (8 chars). Used by the frontend for stale-anchor detection. */
  headSha: string;
  files: SelfReviewFileChange[];
  stats: SelfReviewStats;
};

/**
 * Compute the diff the Self-Review screen renders. `baseRef` is required when
 * `scope === 'base'` and ignored otherwise; the active repo is resolved on
 * the Rust side from app state, not passed from the frontend.
 */
export const selfReviewDiff = (scope: SelfReviewScope, baseRef: string | null) =>
  invoke<SelfReviewDiff>('self_review_diff', { scope, baseRef });

export const gitFetch = () => invoke<FetchOutcome>('git_fetch');

/** Push `branch` to the primary remote with the user's own git credentials
 *  (ADR-0016), setting upstream. Surfaces git's stderr verbatim on failure
 *  (no write access, protected branch, …). */
export const gitPush = (branch: string) => invoke<PushOutcome>('git_push', { branch });

// --- Repo overview (Stage + GitHub aggregation; see docs/adr/0009) ---
export type WorkspaceState =
  | 'draft'
  | 'ready_to_publish'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'frozen';

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

export const repoOverview = (owner: string, repo: string) =>
  invoke<OverviewRow[]>('repo_overview', { owner, repo });

export const openInFinder = (path: string) => invoke<void>('open_in_finder', { path });

export const openUrl = (url: string) => invoke<void>('open_url', { url });

// --- Auth types ---
export type User = {
  id: number;
  github_login: string;
  display_name: string;
  avatar_url: string;
};

// --- GitHub PR types ---
export type GithubUserRef = {
  login: string;
  avatar_url: string | null;
};

export type GithubPrSearchItem = {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  updated_at: string;
  user: GithubUserRef;
};

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
 *  absent for binary files and oversize diffs. */
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

/** Context for opening a published workspace in the read-only reviewer viewer
 *  (Step 2 of the reviewer flow). Built from an `OverviewWorkspaceRow` whose
 *  `pr_number` is non-null (only published workspaces are reviewable). Carries
 *  the overview row's display fields so the viewer's PR-context subheader
 *  renders without a second fetch. */
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
// Returned by GET/PUT .../storyline/ (snake_case — matches OverviewRow convention).
export type StorylineFile = {
  id: string;
  diff_file_path: string;
  order_index: number;
  intro_text: string;
  stale: boolean;
  stale_reason: string | null;
};
export type Storyline = {
  etag: string;
  head_sha: string | null;
  files: StorylineFile[];
};
// One step sent into storyline_update (camelCase — invoke arg convention).
export type StorylineFileWrite = {
  diffFilePath: string;
  orderIndex: number;
  introText: string;
};

export const storylineGet = (workspaceId: string) =>
  invoke<Storyline>('storyline_get', { workspaceId });

export const storylineUpdate = (workspaceId: string, etag: string, files: StorylineFileWrite[]) =>
  invoke<Storyline>('storyline_update', { workspaceId, etag, files });

// --- Self-Review Debrief (cycle 1: local agent↔author loop; see ADR-0011,
// CONTEXT.md "Debrief" / "Review note"). All local + auth-free. ---

/** One step of a Debrief: an agent-authored markdown intro for a single file. */
export type DebriefStep = {
  file: string;
  /** Agent-authored markdown — its own commentary on what it did to this file. */
  intro: string;
  /** Presentation order, ascending. */
  order: number;
};

/** The agent's ordered, annotated account of its own Base-scope changes. */
export type Debrief = {
  /** Base branch the diff was composed against (e.g. `"main"`). */
  base: string;
  steps: DebriefStep[];
  /** Epoch seconds, preserved across regenerations. */
  createdAt: number;
  /** Epoch seconds. */
  updatedAt: number;
};

export type NoteStatus = 'open' | 'addressed' | 'resolved';

/** Which diff side a line anchor targets: `left` = a deleted line (old file),
 *  `right` = an added/context line (new file). Maps to @git-diff-view's
 *  SplitSide. Only meaningful with a line range. */
export type Side = 'left' | 'right';

/** Where a Review note is anchored: a file path, optionally a line range on a
 *  given side. */
export type NoteAnchor = {
  file: string;
  lineStart: number | null;
  lineEnd: number | null;
  side: Side | null;
};

/** Who authored a thread entry on a Review note. */
export type ReplyAuthor = 'author' | 'agent';

/** A follow-up entry on a Review note's thread, after the opening `body`. */
export type NoteReply = {
  id: string;
  author: ReplyAuthor;
  body: string;
  createdAt: number;
};

/** The author's annotation on a diff location — a threaded conversation
 *  (ADR-0012). `anchor` is null for general (un-anchored) feedback. */
export type ReviewNote = {
  id: string;
  anchor: NoteAnchor | null;
  body: string;
  status: NoteStatus;
  /** Follow-up thread entries, oldest first (author and/or agent). */
  replies: NoteReply[];
  createdAt: number;
  updatedAt: number;
};

/** A ReviewNote plus the app-computed `outdated` flag: its anchor no longer
 *  matches the current Base diff (file gone, or its line range on its side is
 *  gone). Anchorless notes are never outdated. The Stale-step pattern, at line
 *  granularity (ADR-0012). */
export type ReviewNoteView = ReviewNote & { outdated: boolean };

/** The stored Debrief for the active repo + branch, or `null` if none. */
export const selfReviewDebriefGet = () => invoke<Debrief | null>('self_review_debrief_get');

/** Review notes for the active repo + branch, optionally filtered by status. */
export const selfReviewNotesList = (status?: NoteStatus) =>
  invoke<ReviewNoteView[]>('self_review_notes_list', { status: status ?? null });

/** Create an `open` Review note. `anchor` is null for general feedback (UUID
 *  minted in Rust). */
export const selfReviewNoteCreate = (anchor: NoteAnchor | null, body: string) =>
  invoke<ReviewNote>('self_review_note_create', { anchor, body });

/** Author action: append an author reply to a note's thread (re-raises an
 *  addressed/resolved note to `open`). */
export const selfReviewNoteReply = (id: string, body: string) =>
  invoke<ReviewNote>('self_review_note_reply', { id, body });

/** Author action: close a note (`resolved`). */
export const selfReviewNoteResolve = (id: string) =>
  invoke<ReviewNote>('self_review_note_resolve', { id });

/** Author action: reopen a note (`open`). */
export const selfReviewNoteReopen = (id: string) =>
  invoke<ReviewNote>('self_review_note_reopen', { id });

/** Author action: permanently delete a note and its thread. */
export const selfReviewNoteDelete = (id: string) => invoke<void>('self_review_note_delete', { id });

// --- Activity log (dev-only debug panel; see client/STACK.md "Activity log").
// The backing commands exist only in debug builds (gated `#[cfg(debug_assertions)]`
// on the Rust side); the webview only ever calls these from dev-gated code
// (`import.meta.env.DEV`), so a release build never invokes a missing command.
// Mirror of `activity_log::ActivityLogEntry` (Rust serializes; this is the TS
// shape). ---

export type ActivityLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export type ActivityLogPill = 'http' | 'git' | 'cmd' | 'webview' | 'rust';

export type ActivityLogEntry = {
  /** Monotonic, assigned in Rust. Used to de-dup snapshot vs. live stream. */
  id: number;
  /** Unix epoch milliseconds. */
  ts_ms: number;
  level: ActivityLogLevel;
  pill: ActivityLogPill;
  /** Rust module path, or `'console'` for webview rows. */
  target: string;
  message: string;
  fields: Record<string, string>;
  duration_ms: number | null;
  error: string | null;
};

/** Full ring, oldest first — pulled when the drawer opens. */
export const activityLogSnapshot = () => invoke<ActivityLogEntry[]>('activity_log_snapshot');

/** A webview-sourced row (forwarded `console.*` or an `ErrorBoundary` catch). */
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
