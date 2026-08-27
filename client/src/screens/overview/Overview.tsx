import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FetchButton } from '../../components/FetchButton';
import { GitDialog } from '../../components/GitDialog';
import { Icon } from '../../components/Icon';
import { RepoMenu } from '../../components/RepoMenu';
import { TitleBar } from '../../components/TitleBar';
import type { SwitchPlanOutcome } from '../../generated/SwitchPlanOutcome';
import { agentSessionsEnabled } from '../../lib/agentSessionsPref';
import { RELOAD } from '../../lib/shortcuts';
import { useShortcut } from '../../lib/useShortcut';
import { materializedWorktree } from '../../lib/worktree';
// Imports used only by the commented-out review surface below:
//   import { Avatar } from '../../components/Avatar';
//   import { gitRemoteBranches, openUrl, reviewDraftCreate, reviewDraftDiscard } from '../../tauri';
//   import { relativeTime } from '../../time';
//   import { statusBadge } from './BranchTable';
//   type PrRef
import {
  type AgentSession,
  type AgentSessionsView,
  type OverviewRow,
  type SyncStatus,
  agentSessions,
  branchSwitchExecute,
  branchSwitchPlan,
  getActiveRepo,
  gitFetch,
  onSyncUpdated,
  overview,
  repoSummary,
  setFocusedWorktree,
  syncNow,
  syncStatus,
} from '../../tauri';
import { relativeTimeFromEpoch } from '../../time';
import { BranchGraph } from './BranchGraph';
import { type BranchActions, BranchMenuProvider } from './BranchMenu';
import { BranchTable } from './BranchTable';
import { AgentSessionPill, selfReviewStarted } from './pills';

/**
 * The branch table — the app's home screen (v6-light L4, design
 * `V6L_Branches`). One dense row per local branch, joining what git + the
 * per-machine store know (worktrees, uncommitted counts, debrief freshness,
 * self-review progress — all derived by Rust, L2). Replaces the bucketed
 * two-column card board. The GitHub half — the PR chip and the "On GitHub · no
 * local branch" section — is commented out with the review surface (below).
 *
 * A **pure renderer** (ADR-0022 §7): Rust assembles every row with its state
 * already derived (`overview`); this screen only filters/sorts for display.
 */

// One stable "nothing running" value so the disabled/failed poll paths can
// keep state identity and skip re-renders.
const NO_AGENTS: AgentSessionsView = { attached: [], unattached: [] };

function slugFromRemote(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/[:/]([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Fed the commented-out "On GitHub" row; commented out with it:
//
// /** Parse `{owner}/{name}#{number}` out of a PR's github.com URL. Null on any
//  *  shape we don't recognise — the row then falls back to the external link. */
// function prRefFromUrl(url: string | null): PrRef | null {
//   if (!url) return null;
//   const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
//   if (!m) return null;
//   return { owner: m[1], name: m[2], number: Number(m[3]) };
// }

// COMMENTED OUT throughout this file: the review surface. This version of Stage
// supports local Self-Review + the agent's Debrief only — everything downstream
// of "Ready to share" (the Review artifact, storyline composition, Publish,
// reviewer entry, GitHub verdicts) works in stage-core but isn't good enough to
// show yet. The `onOpenStoryline` / `onOpenReview` props, the "New review…"
// button and its modal, the discard-draft dialog and the "On GitHub" section are
// commented out rather than deleted, so bringing them back is uncommenting.
export function Overview({
  onChangeRepo,
  onStartSelfReview,
  // onOpenStoryline,
  // onOpenReview,
  onOpenSettings,
}: {
  onChangeRepo: () => void;
  onStartSelfReview: () => void;
  // onOpenStoryline: () => void;
  // onOpenReview: (pr: PrRef) => void;
  onOpenSettings: () => void;
}) {
  const [repoSlug, setRepoSlug] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [rows, setRows] = useState<OverviewRow[]>([]);
  // Only read by the commented-out "On GitHub" section; still set so the load
  // path stays intact.
  const [, setGithubIncluded] = useState(true);
  // The sync engine's status: freshness timestamps + the loud, verbatim causes
  // of a degraded GitHub poll / failed local assembly / failed auto-fetch.
  const [sync, setSync] = useState<SyncStatus | null>(null);
  // Even the local assembly failed: nothing renders but this banner.
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Archived (closed/merged-PR) reviews are hidden by default (DB-5 #88). The
  // load always fetches them (ADR-0028) and this filters the *view*, so the
  // toggle — which lived in the commented-out "On GitHub" section — can come
  // back by uncommenting, with no reload. It stays false meanwhile.
  const [showArchived] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Table ⇄ Graph home choice (v6-light L6), persisted like other view prefs.
  const [homeView, setHomeView] = useState<'table' | 'graph'>(() =>
    localStorage.getItem('home:view') === 'graph' ? 'graph' : 'table',
  );
  const pickHomeView = (v: 'table' | 'graph') => {
    localStorage.setItem('home:view', v);
    setHomeView(v);
  };
  // The composer's single entry point (L7 M4) — the toolbar's "New review" —
  // and the draft-discard confirmation. Both commented out with the review
  // surface (see the note above `Overview`).
  // const [newReviewOpen, setNewReviewOpen] = useState(false);
  // const [discardTarget, setDiscardTarget] = useState<OverviewRow | null>(null);
  // The explicit "Switch to branch…" flow (v6-light L3, ADR-0027 as amended):
  // a planned outcome opens the command-listing confirmation; a
  // checked-out-elsewhere outcome opens the "focus that worktree" variant.
  const [switchTarget, setSwitchTarget] = useState<{
    branch: string;
    outcome: SwitchPlanOutcome;
  } | null>(null);
  // A git action that failed outright (a refused plan, a worktree that couldn't
  // be focused). It answers a click, so it answers in the same dialog the click
  // opened — `GitDialog` tone `error`, the engine's message verbatim.
  const [gitError, setGitError] = useState<{ title: string; message: string } | null>(null);
  // Live Claude Code sessions (opt-in via Settings) — polled; `attached` keys
  // the row pills by branch below, `unattached` feeds the "no worktree yet"
  // tail. Empty when the feature is off, nothing runs, or the probe failed.
  const [liveAgents, setLiveAgents] = useState<AgentSessionsView>(NO_AGENTS);
  // The soft guardrail: self-review was asked for on a branch whose agent is
  // still busy — confirm before entering ("review anyway"), never block.
  const [reviewDespiteAgent, setReviewDespiteAgent] = useState<{
    row: OverviewRow;
    session: AgentSession;
  } | null>(null);

  // const openNewReview = useCallback(() => setNewReviewOpen(true), []);

  // One load in flight at a time. Loads are snapshot reads (the sync engine
  // owns freshness — `gh` is never on this path), so this guard only drops
  // redundant event-driven reloads; the next event reloads.
  const loadInFlight = useRef(false);
  // Always ask for every row, archived included: the branch menu's name→row
  // lookup has to cover every branch git can show, and a merged PR whose
  // branch still exists locally is the ordinary case (ADR-0028). "Show
  // archived" is a view filter applied below — which is what the Rust side
  // always claimed it was.
  const load = useCallback(async () => {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    try {
      const view = await overview(true);
      setRows(view.rows);
      setGithubIncluded(view.githubIncluded);
      setOverviewError(null);
    } catch (e) {
      // Fail loud (CLAUDE.md): only the local assembly can fail this call now
      // (a `gh` outage degrades the sync status chip instead) — say so.
      console.warn('overview_load_failed', e);
      setOverviewError(String(e));
      setRows([]);
    } finally {
      loadInFlight.current = false;
    }
  }, []);

  // Boot: repo slug/path for the footer menu, and the assembled overview.
  useEffect(() => {
    (async () => {
      const repo = await getActiveRepo();
      if (!repo) return;
      setRepoPath(repo.path);
      try {
        const sum = await repoSummary(repo.path);
        setRepoSlug(slugFromRemote(sum.remoteUrl));
      } catch (e) {
        // Non-fatal: the footer menu just shows the folder name.
        console.warn('overview_repo_summary_failed', e);
      }
    })();
    // Seed the freshness/degraded chips; live values ride on `sync-updated`.
    syncStatus()
      .then(setSync)
      .catch((e) => console.warn('sync_status_failed', e));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live refresh: the sync engine pings whenever the snapshot changed (a local
  // commit/branch/worktree/draft change, or a GitHub poll landing new rows).
  // Every event carries the current SyncStatus for the chips.
  useEffect(() => {
    const off = onSyncUpdated((u) => {
      setSync(u.status);
      if (u.scope === 'overview') void load();
    });
    return () => {
      void off.then((f) => f());
    };
  }, [load]);

  // Live Claude Code sessions: a light poll (a handful of tiny local file
  // reads in Rust), only while the Settings opt-in is on. The flag is re-read
  // every tick so flipping it in Settings takes effect without a remount.
  //
  // Best-effort by explicit product decision (the sanctioned exception to
  // fail-loud, documented in `agent_sessions.rs`): a failed probe logs and
  // renders as absence — it must never disturb the overview.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (!agentSessionsEnabled()) {
        if (!cancelled)
          setLiveAgents((cur) =>
            cur.attached.length === 0 && cur.unattached.length === 0 ? cur : NO_AGENTS,
          );
        return;
      }
      try {
        const view = await agentSessions();
        if (!cancelled) setLiveAgents(view);
      } catch (e) {
        console.warn('agent_sessions_failed', e);
        if (!cancelled) setLiveAgents(NO_AGENTS);
      }
    };
    void tick();
    const id = setInterval(tick, 7_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const agentByBranch = useMemo(
    () => new Map(liveAgents.attached.map((s) => [s.branch, s])),
    [liveAgents],
  );

  const runFetch = async () => {
    // Guard re-entry: the Fetch button is disabled while fetching, but ⌘R can
    // fire mid-fetch — don't stack concurrent git fetches.
    if (fetching) return;
    setFetching(true);
    setFetchError(null);
    try {
      try {
        await gitFetch();
        if (repoPath) {
          const sum = await repoSummary(repoPath);
          setRepoSlug(slugFromRemote(sum.remoteUrl));
        }
      } catch (e) {
        setFetchError(String(e));
        return;
      }
      // The fetched refs land via the watcher; this also re-polls GitHub now.
      // Row updates arrive through `sync-updated` — nothing to await here.
      await syncNow();
    } finally {
      setFetching(false);
    }
  };

  // ⌘R / Ctrl+R — keyboard alias for Fetch (git fetch + reload the overview).
  useShortcut(RELOAD, runFetch);

  // Focus the branch's worktree (observe-only — no checkout), then enter the
  // review shell in Self-Review mode (it reads the focused worktree from app
  // state).
  const startSelfReviewAt = useCallback(
    async (r: OverviewRow) => {
      const wt = materializedWorktree(r.branchMeta);
      if (!wt) return;
      try {
        await setFocusedWorktree(wt.path);
        onStartSelfReview();
      } catch (e) {
        console.warn('overview_focus_worktree_failed', e);
      }
    },
    [onStartSelfReview],
  );

  // Plan an explicit switch of the focused worktree to `branch` and open the
  // command-listing confirmation (ADR-0027). Planning never mutates.
  const openSwitchDialog = useCallback(async (branch: string) => {
    try {
      const outcome = await branchSwitchPlan(branch);
      setSwitchTarget({ branch, outcome });
    } catch (e) {
      console.warn('branch_switch_plan_failed', e);
      setGitError({ title: `Can't switch to ${branch}`, message: String(e) });
    }
  }, []);

  // Focus the row's worktree, then open the storyline composer (cwd-bound: the
  // composer reads the focused worktree's branch). Commented out with the
  // review surface:
  //
  // const openStorylineAt = useCallback(
  //   async (row: OverviewRow) => {
  //     const wt = row.branchMeta?.worktree;
  //     if (!wt) return;
  //     try {
  //       await setFocusedWorktree(wt.path);
  //       onOpenStoryline();
  //     } catch (e) {
  //       // Fail loud (CLAUDE.md): the composer reads the *focused* worktree, so a
  //       // failed focus would have opened it on the wrong branch. Say so instead.
  //       console.warn('overview_focus_worktree_failed', e);
  //       setGitError({ title: "Couldn't open that worktree", message: String(e) });
  //     }
  //   },
  //   [onOpenStoryline],
  // );

  // Soft guardrail in front of `startSelfReviewAt`: when a live Claude Code
  // session is still busy on the branch, confirm first — the worktree's files
  // can change mid-review. Confirming proceeds; nothing is blocked.
  const requestSelfReviewAt = useCallback(
    (r: OverviewRow) => {
      const session = agentByBranch.get(r.branch);
      if (session && session.status === 'busy') {
        setReviewDespiteAgent({ row: r, session });
        return;
      }
      void startSelfReviewAt(r);
    },
    [agentByBranch, startSelfReviewAt],
  );

  // What every branch surface can do — one bundle, shared by the menu provider
  // and the table's own row buttons (ADR-0028).
  const branchActions = useMemo<BranchActions>(
    () => ({
      // One surface (L7 M1): the debrief has no route of its own — it renders
      // inside Self-Review as the chaptered file list. Routed through the soft
      // agent guardrail above.
      onSelfReview: requestSelfReviewAt,
      onSwitchTo: openSwitchDialog,
      onError: (title, message) => setGitError({ title, message }),
      // Commented out with the review surface:
      // onOpenStoryline: openStorylineAt,
      // onOpenReview,
      // onDiscardDraft: setDiscardTarget,
    }),
    [requestSelfReviewAt, openSwitchDialog],
  );

  // --- Row split (display only — every row's state came derived) ------------
  // The table shows every row backed by a local branch (branch, draft,
  // published, or an authored PR whose branch is in this clone). Rows without
  // a local branch — PRs awaiting your review, or your PRs whose branch is
  // gone locally — stay reachable in the compact "On GitHub" section.
  const q = query.trim().toLowerCase();
  const matchRow = (r: OverviewRow) =>
    !q ||
    r.title.toLowerCase().includes(q) ||
    r.branch.toLowerCase().includes(q) ||
    (r.authorLogin?.toLowerCase().includes(q) ?? false) ||
    (r.prNumber !== null && `#${r.prNumber}`.includes(q)) ||
    (r.branchMeta?.lastCommit?.toLowerCase().includes(q) ?? false);

  // Every row backed by a local branch, archived included — what the branch
  // menu resolves names against (ADR-0028).
  const allLocalRows = rows
    .filter((r) => r.branchMeta !== null)
    .sort((a, b) => {
      const am = a.branchMeta;
      const bm = b.branchMeta;
      if (!am || !bm) return 0;
      if (am.isCurrent !== bm.isCurrent) return am.isCurrent ? -1 : 1;
      return bm.updatedAt - am.updatedAt;
    });
  // "Show archived" is a display filter from here down.
  const localRows = allLocalRows.filter((r) => showArchived || !r.archived);
  // Fed the commented-out "On GitHub" section:
  // const ghRows = rows.filter((r) => r.branchMeta === null).filter(visible);
  const defaultBase = localRows.find((r) => r.branchMeta?.isDefault)?.branch ?? null;

  const debriefNew = localRows.filter((r) => r.branchMeta?.debriefFreshness === 'new').length;
  const selfInProgress = localRows.filter((r) =>
    selfReviewStarted(r.branchMeta?.selfReview),
  ).length;

  const filteredLocal = localRows.filter(matchRow);
  // Feed the commented-out "On GitHub" section and the "New review" modal:
  //
  // const filteredGh = ghRows.filter(matchRow);
  // const branchRowsForModal = localRows.filter(
  //   (r) => r.kind === 'branch' && !r.branchMeta?.isDefault,
  // );

  return (
    <BranchMenuProvider rows={allLocalRows} actions={branchActions}>
      <div className="stage">
        <div className="win">
          <TitleBar title="Stage" />
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              padding: '14px 18px 0',
            }}
          >
            {/* Toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <div
                  style={{
                    position: 'absolute',
                    left: 9,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--gray-400)',
                    display: 'flex',
                  }}
                >
                  <Icon name="search" size={13} />
                </div>
                <input
                  className="input lg"
                  placeholder="Search by branch, title, author or PR #…"
                  style={{ paddingLeft: 28, maxWidth: 340 }}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="seg" style={{ height: 26 }}>
                <div
                  className={homeView === 'table' ? 'active' : ''}
                  onClick={() => pickHomeView('table')}
                  onKeyDown={(e) => e.key === 'Enter' && pickHomeView('table')}
                  role="tab"
                  tabIndex={0}
                  aria-selected={homeView === 'table'}
                >
                  Table
                </div>
                <div
                  className={homeView === 'graph' ? 'active' : ''}
                  onClick={() => pickHomeView('graph')}
                  onKeyDown={(e) => e.key === 'Enter' && pickHomeView('graph')}
                  role="tab"
                  tabIndex={0}
                  aria-selected={homeView === 'graph'}
                >
                  Graph
                </div>
              </div>
              <SyncedAgo status={sync} />
              <FetchButton onFetch={runFetch} fetching={fetching} />
              {/* The composer's only entry (L7 M4), commented out with the review
                surface — there is no Review to create in this version:

            <button type="button" className="btn btn-lg" onClick={() => openNewReview()}>
              <Icon name="plus" size={12} color="var(--gray-700)" /> New review…
            </button>
            */}
            </div>

            {fetchError && <ErrorNote>Fetch failed: {fetchError}</ErrorNote>}
            {sync?.githubState === 'degraded' && sync.githubError && (
              <ErrorNote>
                GitHub sync degraded — showing the last synced state: {sync.githubError}
              </ErrorNote>
            )}
            {sync?.autoFetchError && (
              <ErrorNote>Background fetch failed: {sync.autoFetchError}</ErrorNote>
            )}
            {sync?.localError && (
              <ErrorNote>Couldn't refresh the overview: {sync.localError}</ErrorNote>
            )}
            {overviewError && <ErrorNote>Couldn't load the overview: {overviewError}</ErrorNote>}

            {/* Summary strip */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '0 2px 10px' }}>
              <span style={{ fontSize: 12, color: 'var(--gray-600)' }}>
                {localRows.length} {localRows.length === 1 ? 'branch' : 'branches'}
              </span>
              {debriefNew > 0 && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 11.5,
                    color: '#7b2cab',
                  }}
                >
                  <span
                    style={{ width: 5, height: 5, borderRadius: 3, background: 'var(--purple)' }}
                  />
                  {debriefNew} debrief new
                </span>
              )}
              {selfInProgress > 0 && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 11.5,
                    color: 'var(--blue-press)',
                  }}
                >
                  <Icon name="eye" size={10} color="var(--blue)" />
                  {selfInProgress} self-review in progress
                </span>
              )}
            </div>

            {homeView === 'graph' ? (
              /* The graph fills the scroll area; the "On GitHub" tail is a
               table-view companion and stays there. */
              <div style={{ flex: 1, minHeight: 0, display: 'flex', paddingBottom: 14 }}>
                {/* The rail lists every local branch git reports, so join the pills
                  against every local row — not the archived-filtered view. */}
                <BranchGraph rows={allLocalRows} refreshKey={sync?.generation ?? 0} />
              </div>
            ) : (
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingBottom: 14 }}>
                <BranchTable
                  rows={filteredLocal}
                  defaultBase={defaultBase}
                  actions={branchActions}
                  agentSessions={agentByBranch}
                />

                {/* Live sessions with no dedicated worktree yet — an agent that
                    hasn't created one, or a directory git no longer lists. The
                    shape mirrors the "On GitHub · no local branch" tail: work
                    that exists but has no branch row to ride. */}
                {liveAgents.unattached.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 2px 6px' }}
                    >
                      <Icon name="sparkle" size={11} color="var(--gray-500)" />
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: 0.5,
                          textTransform: 'uppercase',
                          color: 'var(--gray-400)',
                        }}
                      >
                        Claude Code · no worktree yet
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {liveAgents.unattached.map((u) => (
                        <div
                          key={u.sessionId}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 10px',
                            background: '#fff',
                            border: '1px solid var(--hairline)',
                            borderRadius: 'var(--r-md)',
                          }}
                        >
                          <AgentSessionPill s={u} />
                          <span
                            className="mono"
                            title={u.dir === '' ? 'the repo root checkout' : u.dir}
                            style={{
                              fontSize: 11,
                              color: 'var(--gray-500)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {u.dir === '' ? 'repo root' : u.dir}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* PRs with no local branch — awaiting your review, or yours with
                  the branch gone locally — plus the archived-Reviews toggle.
                  Commented out with the review surface: every row here exists
                  only to be opened as a Review, and there's no local branch to
                  self-review instead.

              {(filteredGh.length > 0 || !githubIncluded) && (
                <div style={{ marginTop: 16 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      margin: '0 2px 6px',
                    }}
                  >
                    <Icon name="gh" size={11} color="var(--gray-500)" />
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.5,
                        textTransform: 'uppercase',
                        color: 'var(--gray-400)',
                      }}
                    >
                      On GitHub · no local branch
                    </span>
                    {filteredGh.filter((r) => r.role === 'reviewer').length > 0 && (
                      <span className="badge badge-orange">
                        {filteredGh.filter((r) => r.role === 'reviewer').length} awaiting your
                        review
                      </span>
                    )}
                  </div>
                  {!githubIncluded && (
                    <div
                      style={{ fontSize: 11.5, color: 'var(--gray-500)', padding: '2px 2px 6px' }}
                    >
                      GitHub wasn't consulted — fix `gh` (see the banner above) and Fetch to see the
                      PRs awaiting your review.
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {filteredGh.map((r) => (
                      <GhRow
                        key={r.prNumber !== null ? `#${r.prNumber}` : r.branch}
                        r={r}
                        onOpenReview={onOpenReview}
                      />
                    ))}
                  </div>
                  {githubIncluded && (
                    <button
                      type="button"
                      onClick={() => setShowArchived((v) => !v)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        background: 'none',
                        border: 'none',
                        padding: '6px 2px',
                        cursor: 'pointer',
                        fontSize: 11.5,
                        color: 'var(--gray-500)',
                      }}
                    >
                      <Icon name="eye" size={11} color="var(--gray-500)" />
                      {showArchived
                        ? `Hide archived (${rows.filter((r) => r.archived).length})`
                        : 'Show archived'}
                    </button>
                  )}
                </div>
              )}
              */}
              </div>
            )}

            {/* Footer: repo menu + legend */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: '8px 0 10px',
                borderTop: '1px solid var(--hairline-2)',
              }}
            >
              <div style={{ width: 260, flex: '0 0 260px' }}>
                <RepoMenu
                  slug={repoSlug}
                  path={repoPath}
                  onChangeRepo={onChangeRepo}
                  onOpenSettings={onOpenSettings}
                />
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 16,
                  fontSize: 11.5,
                  color: 'var(--gray-500)',
                  alignItems: 'center',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Icon name="worktree" size={12} color="var(--purple)" /> worktree
                </span>
                <span>
                  <span style={{ color: 'var(--orange)', fontWeight: 600 }}>●3</span> uncommitted
                  files
                </span>
                <span>everything stays on this machine</span>
              </div>
            </div>
          </div>

          {/* The "New review" composer modal and the draft-discard confirmation,
            commented out with the review surface:

        {newReviewOpen && (
          <NewReviewModal
            branchRows={branchRowsForModal}
            onClose={() => setNewReviewOpen(false)}
            onCreated={onOpenStoryline}
          />
        )}
        {discardTarget && (
          <GitDialog
            icon="doc-stack"
            title="Discard this review?"
            body={
              <>
                The storyline and title are removed. The branch{' '}
                <span className="mono">{discardTarget.branch}</span> is kept and returns to
                Self-Review.
              </>
            }
            confirmLabel="Discard"
            onConfirm={async () => {
              await reviewDraftDiscard(discardTarget.branch);
              await load();
            }}
            onClose={() => setDiscardTarget(null)}
          />
        )}
        */}
          {switchTarget && switchTarget.outcome.kind === 'plan' && (
            <GitDialog
              title={
                <>
                  Switch to <span className="mono">{switchTarget.branch}</span>?
                </>
              }
              body={
                switchTarget.outcome.plan.uncommittedCount > 0 ? (
                  <>
                    Stage switches this working tree to the branch you picked — your{' '}
                    <span style={{ color: 'var(--orange)', fontWeight: 600 }}>
                      {switchTarget.outcome.plan.uncommittedCount} uncommitted{' '}
                      {switchTarget.outcome.plan.uncommittedCount === 1 ? 'file' : 'files'}
                    </span>{' '}
                    will be stashed and restored automatically.
                  </>
                ) : (
                  <>Stage switches this working tree to the branch you picked.</>
                )
              }
              steps={switchTarget.outcome.plan.steps}
              confirmLabel="Switch branch"
              onConfirm={async () => {
                await branchSwitchExecute(switchTarget.branch);
                await load();
              }}
              onClose={() => setSwitchTarget(null)}
            />
          )}
          {switchTarget &&
            switchTarget.outcome.kind === 'checkedOutElsewhere' &&
            (() => {
              const { worktreePath } = switchTarget.outcome;
              return (
                // Report only: Stage says what git refuses and where the branch
                // already lives, and does nothing. Re-pointing the observed
                // worktree from here was offered once and removed — the switch
                // the user asked for isn't possible, and quietly observing a
                // different tree instead isn't the same thing.
                <GitDialog
                  tone="blocked"
                  icon="folder"
                  title={`Already checked out — ${switchTarget.branch}`}
                  body={
                    <>
                      Git forbids a second checkout of a branch another worktree holds, so this
                      working tree can't switch to{' '}
                      <span className="mono">{switchTarget.branch}</span>. It's already checked out
                      here:
                      {agentByBranch.get(switchTarget.branch)?.status === 'busy' && (
                        <>
                          {' '}
                          <span style={{ color: 'var(--orange)', fontWeight: 600 }}>
                            A Claude Code session ("
                            {agentByBranch.get(switchTarget.branch)?.name}") is still working in
                            that worktree.
                          </span>
                        </>
                      )}
                    </>
                  }
                  details={[{ label: 'Worktree', value: worktreePath }]}
                  onClose={() => setSwitchTarget(null)}
                />
              );
            })()}
          {gitError && (
            <GitDialog
              tone="error"
              title={gitError.title}
              body={gitError.message}
              onClose={() => setGitError(null)}
            />
          )}
          {/* Soft guardrail (never a block): the branch's Claude Code session
              is still busy, so the worktree can change mid-review — say so,
              then let "Review anyway" proceed. */}
          {reviewDespiteAgent && (
            <GitDialog
              tone="blocked"
              title={
                <>
                  Claude Code is still working on{' '}
                  <span className="mono">{reviewDespiteAgent.row.branch}</span>
                </>
              }
              body={
                <>
                  The session "{reviewDespiteAgent.session.name}" is busy in this branch's worktree,
                  so files may change while you review. You can wait for it to finish, or review
                  anyway.
                </>
              }
              confirmLabel="Review anyway"
              onConfirm={() => startSelfReviewAt(reviewDespiteAgent.row)}
              cancelLabel="Not now"
              onClose={() => setReviewDespiteAgent(null)}
            />
          )}
        </div>
      </div>
    </BranchMenuProvider>
  );
}

/** "Updated 12s ago" — when the GitHub side last synced, ticking every 10s so
 *  the relative time stays honest. Quiet until the first poll lands; a
 *  degraded poll gets its own banner instead. */
function SyncedAgo({ status }: { status: SyncStatus | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);
  if (!status?.githubSyncedAt) return null;
  return (
    <span
      title="Last successful GitHub sync"
      style={{ fontSize: 11, color: 'var(--gray-500)', flex: '0 0 auto', whiteSpace: 'nowrap' }}
    >
      Updated {relativeTimeFromEpoch(Math.floor(status.githubSyncedAt / 1000))}
    </span>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11.5,
        color: 'var(--red-d)',
        background: 'rgba(255,59,48,0.08)',
        border: '1px solid rgba(255,59,48,0.20)',
        borderRadius: 'var(--r-sm)',
        padding: '6px 10px',
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}
// COMMENTED OUT with the review surface: the "On GitHub" PR row, the field
// wrapper it shares, and the "New review" composer modal. All three exist only
// to create or open a Review, which this version doesn't support.
//
// /** A compact row for a PR with no local branch: reviewer rows carry the
//  *  author's avatar and a Review entry; authored rows open the PR. */
// function GhRow({ r, onOpenReview }: { r: OverviewRow; onOpenReview: (pr: PrRef) => void }) {
//   const st = statusBadge(r);
//   const pr = prRefFromUrl(r.url);
//   const open = () => {
//     if (pr) onOpenReview(pr);
//     else if (r.url) openUrl(r.url).catch((e) => console.warn('open_url_failed', e));
//   };
//   return (
//     <div
//       style={{
//         display: 'flex',
//         alignItems: 'center',
//         gap: 10,
//         background: '#fff',
//         border: '1px solid var(--hairline)',
//         borderRadius: 'var(--r-md)',
//         padding: '7px 10px',
//         boxShadow: 'var(--sh-1)',
//         minWidth: 0,
//       }}
//     >
//       {r.role === 'reviewer' ? (
//         <Avatar name={r.authorLogin ?? '?'} size="sm" />
//       ) : (
//         <Icon name="gh" size={13} color="var(--gray-600)" />
//       )}
//       <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
//         <span
//           title={r.title || r.branch}
//           style={{
//             fontSize: 12.5,
//             fontWeight: 600,
//             overflow: 'hidden',
//             textOverflow: 'ellipsis',
//             whiteSpace: 'nowrap',
//           }}
//         >
//           {r.title || r.branch}
//         </span>
//         {r.prNumber !== null && (
//           <span
//             className="badge"
//             style={{
//               background: 'rgba(0,0,0,0.06)',
//               flex: '0 0 auto',
//               display: 'inline-flex',
//               alignItems: 'center',
//               gap: 3,
//             }}
//           >
//             <Icon name="gh" size={9} color="var(--gray-700)" /> #{r.prNumber}
//           </span>
//         )}
//         <span className={`badge ${st.cls}`} style={{ flex: '0 0 auto' }}>
//           {st.label}
//         </span>
//         {r.role === 'reviewer' && r.authorLogin && (
//           <span style={{ fontSize: 11, color: 'var(--gray-500)', flex: '0 0 auto' }}>
//             by {r.authorLogin}
//           </span>
//         )}
//       </div>
//       <span style={{ fontSize: 10.5, color: 'var(--gray-500)', flex: '0 0 auto' }}>
//         {r.updatedAt ? relativeTime(r.updatedAt) : ''}
//       </span>
//       <button type="button" className="btn" onClick={open} title={r.url ?? undefined}>
//         <Icon name="eye" size={10} color="var(--gray-700)" />{' '}
//         {r.role === 'reviewer' ? 'Review' : 'Open'}
//       </button>
//     </div>
//   );
// }
//
// function Field({ label, children }: { label: string; children: ReactNode }) {
//   return (
//     // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in via {children} (select/input), which Biome can't statically associate.
//     <label style={{ display: 'block', marginBottom: 10 }}>
//       <div
//         style={{
//           fontSize: 11.5,
//           fontWeight: 600,
//           color: 'var(--gray-600)',
//           marginBottom: 4,
//         }}
//       >
//         {label}
//       </div>
//       {children}
//     </label>
//   );
// }
//
// /** "New review" (WS-2 #60; the composer's single entry per L7 M4): pick a
//  *  branch (checked out in a worktree — the engine keys the draft off the
//  *  focused worktree), a base, and an optional title; creates the per-machine
//  *  draft and opens the storyline composer. */
// function NewReviewModal({
//   branchRows,
//   onClose,
//   onCreated,
// }: {
//   branchRows: OverviewRow[];
//   onClose: () => void;
//   onCreated: () => void;
// }) {
//   const withWorktree = branchRows.filter(
//     (r) => r.branchMeta?.worktree && !r.branchMeta.worktree.prunable,
//   );
//   const without = branchRows.filter(
//     (r) => !r.branchMeta?.worktree || r.branchMeta.worktree.prunable,
//   );
//   const [headRef, setHeadRef] = useState(withWorktree[0]?.branch ?? '');
//   // Base is the PR merge target, stored remote-tracking (`origin/<name>`) so
//   // the diff prefers the remote copy; Publish strips the prefix for gh.
//   const [baseRef, setBaseRef] = useState('');
//   const [baseOptions, setBaseOptions] = useState<string[]>([]);
//   const [title, setTitle] = useState('');
//   const [submitting, setSubmitting] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//
//   useEffect(() => {
//     (async () => {
//       try {
//         const remote = await gitRemoteBranches();
//         const names = remote.map((b) =>
//           b.name.startsWith('origin/') ? b.name : `origin/${b.name}`,
//         );
//         setBaseOptions(names);
//         setBaseRef((cur) => cur || names.find((n) => n === 'origin/main') || names[0] || 'main');
//       } catch (e) {
//         // Additive: without remote branches the field falls back to free text
//         // via the lone current value; creation still works (local-first).
//         console.warn('new_review_remote_branches_failed', e);
//         setBaseRef((cur) => cur || 'main');
//       }
//     })();
//   }, []);
//
//   const submit = async () => {
//     if (!headRef) {
//       setError('Pick a branch to share.');
//       return;
//     }
//     setSubmitting(true);
//     setError(null);
//     try {
//       const row = branchRows.find((r) => r.branch === headRef);
//       const wt = row?.branchMeta?.worktree;
//       if (!wt || wt.prunable) {
//         throw new Error(
//           `Branch '${headRef}' isn't checked out in a worktree — check it out first, then mark it Ready to share.`,
//         );
//       }
//       // The draft is keyed off the focused worktree's branch (ADR-0022 §3):
//       // focus first, then create.
//       await setFocusedWorktree(wt.path);
//       await reviewDraftCreate(title.trim() || headRef, baseRef.trim() || 'main');
//       onClose();
//       onCreated();
//     } catch (e) {
//       // Fail loud (CLAUDE.md): surface the engine's message verbatim in the
//       // modal; never close on a swallowed error.
//       console.warn('review_draft_create_failed', e);
//       setError(String(e));
//     } finally {
//       setSubmitting(false);
//     }
//   };
//
//   return (
//     // biome-ignore lint/a11y/useSemanticElements: overlay modal; a styled div with role="dialog" matches the existing RepoMenu pattern rather than a native <dialog>.
//     <div
//       role="dialog"
//       aria-modal="true"
//       aria-label="New review"
//       style={{
//         position: 'fixed',
//         inset: 0,
//         background: 'rgba(0,0,0,0.28)',
//         display: 'flex',
//         alignItems: 'center',
//         justifyContent: 'center',
//         zIndex: 50,
//       }}
//       onMouseDown={(e) => {
//         if (e.target === e.currentTarget) onClose();
//       }}
//     >
//       <div
//         style={{
//           width: 420,
//           background: '#fff',
//           borderRadius: 'var(--r-lg)',
//           boxShadow: 'var(--sh-pop)',
//           padding: 18,
//         }}
//       >
//         <div
//           style={{
//             fontSize: 15,
//             fontWeight: 700,
//             color: 'var(--gray-900)',
//             marginBottom: 14,
//           }}
//         >
//           New review
//         </div>
//
//         <Field label="Branch">
//           <select
//             className="input"
//             value={headRef}
//             onChange={(e) => setHeadRef(e.target.value)}
//             style={{ width: '100%' }}
//           >
//             {withWorktree.length === 0 && (
//               <option value="">No worktree-backed branches without a review</option>
//             )}
//             {withWorktree.map((r) => (
//               <option key={r.branch} value={r.branch}>
//                 {r.branch}
//               </option>
//             ))}
//             {without.map((r) => (
//               <option key={r.branch} value={r.branch} disabled>
//                 {r.branch} — no worktree
//               </option>
//             ))}
//           </select>
//         </Field>
//
//         <Field label="Base">
//           <select
//             className="input"
//             value={baseRef}
//             onChange={(e) => setBaseRef(e.target.value)}
//             style={{ width: '100%' }}
//           >
//             {(() => {
//               const seen = new Set<string>();
//               const opts: string[] = [];
//               for (const n of [...baseOptions, baseRef]) {
//                 if (!n || seen.has(n)) continue;
//                 seen.add(n);
//                 opts.push(n);
//               }
//               return opts.map((n) => (
//                 <option key={n} value={n}>
//                   {n}
//                 </option>
//               ));
//             })()}
//           </select>
//         </Field>
//
//         <Field label="Title (optional)">
//           <input
//             className="input"
//             value={title}
//             onChange={(e) => setTitle(e.target.value)}
//             placeholder={headRef || 'Review title'}
//             style={{ width: '100%' }}
//           />
//         </Field>
//
//         {error && (
//           <div
//             style={{
//               fontSize: 11.5,
//               color: 'var(--red-d)',
//               background: 'rgba(255,59,48,0.08)',
//               border: '1px solid rgba(255,59,48,0.20)',
//               borderRadius: 'var(--r-sm)',
//               padding: '6px 10px',
//               marginBottom: 8,
//             }}
//           >
//             Couldn't create the review: {error}
//           </div>
//         )}
//
//         <div
//           style={{
//             display: 'flex',
//             justifyContent: 'flex-end',
//             gap: 8,
//             marginTop: 14,
//           }}
//         >
//           <button type="button" className="btn" onClick={onClose} disabled={submitting}>
//             Cancel
//           </button>
//           <button
//             type="button"
//             className="btn btn-primary"
//             onClick={submit}
//             disabled={submitting || !headRef}
//             style={{ opacity: submitting ? 0.6 : 1 }}
//           >
//             {submitting ? 'Creating…' : 'Create'}
//           </button>
//         </div>
//       </div>
//     </div>
//   );
// }
