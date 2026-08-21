import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { FetchButton } from '../../components/FetchButton';
import { GitStepsDialog } from '../../components/GitStepsDialog';
import { Icon } from '../../components/Icon';
import { RepoMenu } from '../../components/RepoMenu';
import { TitleBar } from '../../components/TitleBar';
import type { SwitchPlanOutcome } from '../../generated/SwitchPlanOutcome';
import { RELOAD } from '../../lib/shortcuts';
import { useShortcut } from '../../lib/useShortcut';
import {
  type GitHubUser,
  type OverviewRow,
  type PrRef,
  type ReviewStatus,
  type SyncStatus,
  branchSwitchExecute,
  branchSwitchPlan,
  getActiveRepo,
  ghIdentity,
  gitFetch,
  gitRemoteBranches,
  onSyncUpdated,
  openUrl,
  overview,
  repoSummary,
  reviewDraftCreate,
  reviewDraftDiscard,
  setFocusedWorktree,
  syncNow,
  syncStatus,
} from '../../tauri';
import { relativeTime, relativeTimeFromEpoch } from '../../time';

/**
 * The unified per-repo overview — the app's home screen. One board combining
 * what git + `.stage` know locally with what GitHub knows (design v3 §1
 * "Workspaces", restyled to the Review vocabulary of ADR-0022 §8): local
 * branches, per-machine drafts, published Reviews, and plain PRs, bucketed
 * into an "Authored by you" / "Awaiting your review" two-column board.
 *
 * A **pure renderer** (ADR-0022 §7): Rust assembles every row with its state
 * already derived (`overview`); this screen only filters/buckets for display.
 * The separate local-branches screen is gone — its rows (worktree badges,
 * Self-Review entry) live in the Self-Review bucket here.
 */

type Show = 'all' | 'yours' | 'review';
type Kind = 'self-review' | 'ready-to-share' | 'in-review' | 'open-prs';

const RAIL_MIN = 160;
const RAIL_MAX = 360;
const RAIL_DEFAULT = 200;
const RAIL_KEY = 'overview:rail-width';

function clampRail(w: number): number {
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, w));
}

/** Persisted, draggable width for the left filter rail (px, not %). */
function useRailWidth() {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(RAIL_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampRail(saved) : RAIL_DEFAULT;
  });
  useEffect(() => {
    localStorage.setItem(RAIL_KEY, String(width));
  }, [width]);
  return [width, setWidth] as const;
}

function slugFromRemote(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/[:/]([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Parse `{owner}/{name}#{number}` out of a PR's github.com URL. Null on any
 *  shape we don't recognise — the row then falls back to the external link. */
function prRefFromUrl(url: string | null): PrRef | null {
  if (!url) return null;
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], name: m[2], number: Number(m[3]) };
}

export function Overview({
  onChangeRepo,
  onStartSelfReview,
  onOpenStoryline,
  onOpenReview,
  onOpenSettings,
}: {
  onChangeRepo: () => void;
  onStartSelfReview: () => void;
  onOpenStoryline: () => void;
  onOpenReview: (pr: PrRef) => void;
  onOpenSettings: () => void;
}) {
  const [repoSlug, setRepoSlug] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [githubIncluded, setGithubIncluded] = useState(true);
  // The sync engine's status: freshness timestamps + the loud, verbatim causes
  // of a degraded GitHub poll / failed local assembly / failed auto-fetch.
  const [sync, setSync] = useState<SyncStatus | null>(null);
  // Even the local assembly failed: nothing renders but this banner.
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [me, setMe] = useState<GitHubUser | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [kind, setKind] = useState<Kind | null>(null);
  const [query, setQuery] = useState('');
  // Archived (closed/merged-PR) reviews are hidden by default (DB-5 #88); this
  // toggle re-asks Rust with the filter flipped (never stored).
  const [showArchived, setShowArchived] = useState(false);
  const [railWidth, setRailWidth] = useRailWidth();
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [newReviewOpen, setNewReviewOpen] = useState(false);
  const [newReviewBranch, setNewReviewBranch] = useState<string | undefined>(undefined);
  const [discardTarget, setDiscardTarget] = useState<OverviewRow | null>(null);
  // The explicit "Switch to branch…" flow (v6-light L3, ADR-0027 as amended):
  // a planned outcome opens the command-listing confirmation; planning errors
  // land in the banner like every other loud failure.
  const [switchTarget, setSwitchTarget] = useState<{
    branch: string;
    outcome: SwitchPlanOutcome;
  } | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const openNewReview = useCallback((branch?: string) => {
    setNewReviewBranch(branch);
    setNewReviewOpen(true);
  }, []);

  // One load in flight at a time. Loads are snapshot reads (the sync engine
  // owns freshness — `gh` is never on this path), so this guard only drops
  // redundant event-driven reloads; the next event reloads.
  const loadInFlight = useRef(false);
  const load = useCallback(async (withArchived: boolean) => {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    try {
      const view = await overview(withArchived);
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

  // Boot: rail slug/path, identity (best-effort — the overview call surfaces
  // any real gh failure), and the assembled overview.
  useEffect(() => {
    (async () => {
      const repo = await getActiveRepo();
      if (!repo) return;
      setRepoPath(repo.path);
      try {
        const sum = await repoSummary(repo.path);
        setRepoSlug(slugFromRemote(sum.remoteUrl));
      } catch (e) {
        // Non-fatal: the rail just shows the folder name.
        console.warn('overview_repo_summary_failed', e);
      }
    })();
    ghIdentity()
      .then(setMe)
      .catch(() => setMe(null));
    // Seed the freshness/degraded chips; live values ride on `sync-updated`.
    syncStatus()
      .then(setSync)
      .catch((e) => console.warn('sync_status_failed', e));
  }, []);

  useEffect(() => {
    void load(showArchived);
  }, [load, showArchived]);

  // Live refresh: the sync engine pings whenever the snapshot changed (a local
  // commit/branch/worktree/draft change, or a GitHub poll landing new rows).
  // Every event carries the current SyncStatus for the chips.
  useEffect(() => {
    const off = onSyncUpdated((u) => {
      setSync(u.status);
      if (u.scope === 'overview') void load(showArchived);
    });
    return () => {
      void off.then((f) => f());
    };
  }, [load, showArchived]);

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

  const railProps = useRailResize(setRailWidth);

  // Focus the branch's worktree (observe-only — no checkout), then enter
  // Self-Review (which reads the focused worktree from app state).
  const startSelfReviewAt = useCallback(
    async (worktreePath: string) => {
      try {
        await setFocusedWorktree(worktreePath);
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
    setSwitchError(null);
    try {
      const outcome = await branchSwitchPlan(branch);
      setSwitchTarget({ branch, outcome });
    } catch (e) {
      console.warn('branch_switch_plan_failed', e);
      setSwitchError(String(e));
    }
  }, []);

  // Focus the row's worktree, then open the storyline composer (cwd-bound: the
  // composer reads the focused worktree's branch).
  const openStorylineAt = useCallback(
    async (row: OverviewRow) => {
      const wt = row.branchMeta?.worktree;
      if (!wt) return;
      try {
        await setFocusedWorktree(wt.path);
        onOpenStoryline();
      } catch (e) {
        console.warn('overview_focus_worktree_failed', e);
      }
    },
    [onOpenStoryline],
  );

  // --- Buckets (display grouping only — every row's state came derived) ------
  // Self-Review = plain local branches. The default branch is excluded: you
  // don't review it against itself, and sharing it would make a degenerate
  // head==base review Publish can't open a PR for.
  const branchRows = rows.filter((r) => r.kind === 'branch' && !r.branchMeta?.isDefault);
  const draftRows = rows.filter((r) => r.kind === 'draft');
  const publishedMine = rows.filter((r) => r.kind === 'published' && r.role === 'author');
  const yoursReadyToShare = [...draftRows, ...publishedMine.filter((r) => r.prNumber === null)];
  const yoursInReview = publishedMine.filter((r) => r.prNumber !== null);
  const reviewInReview = rows.filter((r) => r.kind === 'published' && r.role === 'reviewer');
  const openAuthor = rows.filter((r) => r.kind === 'plain_pr' && r.role === 'author');
  const openReviewer = rows.filter((r) => r.kind === 'plain_pr' && r.role === 'reviewer');
  const archivedShown = rows.filter((r) => r.archived).length;

  const q = query.trim().toLowerCase();
  const matchRow = (r: OverviewRow) =>
    !q ||
    r.title.toLowerCase().includes(q) ||
    r.branch.toLowerCase().includes(q) ||
    (r.authorLogin?.toLowerCase().includes(q) ?? false) ||
    (r.prNumber !== null && `#${r.prNumber}`.includes(q)) ||
    (r.branchMeta?.lastCommit?.toLowerCase().includes(q) ?? false);

  const kindCounts = {
    'self-review': branchRows.length,
    'ready-to-share': yoursReadyToShare.length,
    'in-review': yoursInReview.length + reviewInReview.length,
    'open-prs': openAuthor.length + openReviewer.length,
  };
  const yoursCount =
    branchRows.length + yoursReadyToShare.length + yoursInReview.length + openAuthor.length;
  const reviewCount = reviewInReview.length + openReviewer.length;

  const showKind = (k: Kind) => kind === null || kind === k;
  const toggleKind = (k: Kind) => setKind((cur) => (cur === k ? null : k));

  const showYours = show !== 'review';
  const showReview = show !== 'yours';

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage" />
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Left filter rail */}
          <div
            ref={railProps.railRef}
            style={{
              width: railWidth,
              flex: `0 0 ${railWidth}px`,
              padding: '14px 10px',
              background: '#fbfaf8',
              display: 'flex',
              flexDirection: 'column',
              minWidth: 0,
            }}
          >
            <div className="section-label" style={{ padding: '0 6px' }}>
              Show
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <FilterRow
                label="Everything"
                count={yoursCount + reviewCount}
                active={show === 'all'}
                onClick={() => setShow('all')}
              />
              <FilterRow
                label="Authored by you"
                count={yoursCount}
                dot="var(--blue)"
                active={show === 'yours'}
                onClick={() => setShow('yours')}
              />
              <FilterRow
                label="Awaiting your review"
                count={reviewCount}
                dot="var(--orange)"
                active={show === 'review'}
                onClick={() => setShow('review')}
              />
            </div>

            <div className="section-label" style={{ marginTop: 14, padding: '0 6px' }}>
              Filter by kind
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <FilterRow
                icon={<Icon name="eye" size={11} />}
                label="Self-Review"
                count={kindCounts['self-review']}
                sub="no review"
                active={kind === 'self-review'}
                onClick={() => toggleKind('self-review')}
              />
              <FilterRow
                icon={<Icon name="branch" size={11} />}
                label="Ready to share"
                count={kindCounts['ready-to-share']}
                sub="not on GitHub"
                active={kind === 'ready-to-share'}
                onClick={() => toggleKind('ready-to-share')}
              />
              <FilterRow
                icon={<Icon name="doc-stack" size={11} />}
                label="In review"
                count={kindCounts['in-review']}
                sub="review + PR"
                active={kind === 'in-review'}
                onClick={() => toggleKind('in-review')}
              />
              <FilterRow
                icon={<Icon name="gh" size={11} />}
                label="Open PRs"
                count={kindCounts['open-prs']}
                sub="no review"
                active={kind === 'open-prs'}
                onClick={() => toggleKind('open-prs')}
              />
            </div>

            <div style={{ flex: 1 }} />

            <div className="section-label" style={{ marginTop: 14, padding: '0 6px' }}>
              Repository
            </div>
            <RepoMenu
              slug={repoSlug}
              path={repoPath}
              onChangeRepo={onChangeRepo}
              onOpenSettings={onOpenSettings}
            />
          </div>

          {/* Resizable divider */}
          <button
            type="button"
            ref={railProps.handleRef}
            className="rail-resize"
            onPointerDown={railProps.startResize}
            onKeyDown={railProps.onResizeKey}
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            role="separator"
            aria-valuenow={railWidth}
            aria-valuemin={RAIL_MIN}
            aria-valuemax={RAIL_MAX}
          />

          {/* Main */}
          <div
            style={{
              flex: 1,
              padding: '14px 18px',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 12,
              }}
            >
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
                  style={{ paddingLeft: 28 }}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <SyncedAgo status={sync} />
              <FetchButton onFetch={runFetch} fetching={fetching} />
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => openNewReview()}
              >
                <Icon name="plus" size={12} color="#fff" /> New review
              </button>
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
            {switchError && <ErrorNote>Couldn't plan the switch: {switchError}</ErrorNote>}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: showYours && showReview ? '1fr 1fr' : '1fr',
                gap: 16,
                flex: 1,
                minHeight: 0,
              }}
            >
              {showYours && (
                <Column
                  icon={<Avatar name={me?.name || me?.login || 'You'} size="lg" />}
                  title="Authored by you"
                  count={yoursCount}
                  tint="rgba(0,122,255,0.04)"
                  border="rgba(0,122,255,0.16)"
                  accent="var(--blue)"
                >
                  {showKind('self-review') && branchRows.filter(matchRow).length > 0 && (
                    <Bucket
                      color="var(--orange)"
                      title="Self-Review"
                      hint="no review"
                      count={branchRows.length}
                    >
                      {branchRows.filter(matchRow).map((r) => (
                        <BranchRowCompact
                          key={r.branch}
                          r={r}
                          onStartSelfReview={startSelfReviewAt}
                          onReadyToShare={openNewReview}
                          onSwitchTo={openSwitchDialog}
                        />
                      ))}
                    </Bucket>
                  )}
                  {showKind('ready-to-share') && yoursReadyToShare.filter(matchRow).length > 0 && (
                    <Bucket
                      color="var(--blue)"
                      title="Ready to share"
                      hint="not on GitHub"
                      count={yoursReadyToShare.length}
                    >
                      {yoursReadyToShare.filter(matchRow).map((r) => (
                        <ReviewRowCompact
                          key={r.prNumber !== null ? `#${r.prNumber}` : r.branch}
                          r={r}
                          onBackToSelfReview={r.kind === 'draft' ? setDiscardTarget : undefined}
                          onOpenStoryline={openStorylineAt}
                        />
                      ))}
                    </Bucket>
                  )}
                  {showKind('in-review') && yoursInReview.filter(matchRow).length > 0 && (
                    <Bucket
                      color="var(--purple)"
                      title="In review"
                      hint="review + PR"
                      count={yoursInReview.length}
                    >
                      {yoursInReview.filter(matchRow).map((r) => (
                        <ReviewRowCompact
                          key={r.prNumber !== null ? `#${r.prNumber}` : r.branch}
                          r={r}
                          onOpenStoryline={r.branchMeta?.worktree ? openStorylineAt : undefined}
                          onOpenReview={onOpenReview}
                        />
                      ))}
                    </Bucket>
                  )}
                  {showKind('open-prs') && openAuthor.filter(matchRow).length > 0 && (
                    <Bucket
                      color="var(--gray-400)"
                      title="Open PRs"
                      hint="on GitHub, no review"
                      count={openAuthor.length}
                    >
                      {openAuthor.filter(matchRow).map((r) => (
                        <OpenPrRowCompact key={r.prNumber} r={r} onOpenReview={onOpenReview} />
                      ))}
                    </Bucket>
                  )}
                </Column>
              )}

              {showReview && (
                <Column
                  icon={
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        background: 'rgba(255,149,0,0.18)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Icon name="eye" size={14} color="var(--orange)" />
                    </div>
                  }
                  title="Awaiting your review"
                  count={reviewCount}
                  tint="rgba(255,149,0,0.04)"
                  border="rgba(255,149,0,0.18)"
                  accent="var(--orange)"
                >
                  {!githubIncluded && (
                    <div style={{ fontSize: 11.5, color: 'var(--gray-500)', padding: '2px 2px' }}>
                      GitHub wasn't consulted — fix `gh` (see the banner above) and Fetch to see the
                      PRs awaiting your review.
                    </div>
                  )}
                  {showKind('in-review') && reviewInReview.filter(matchRow).length > 0 && (
                    <Bucket
                      color="var(--purple)"
                      title="In review"
                      hint="review + PR"
                      count={reviewInReview.length}
                    >
                      {reviewInReview.filter(matchRow).map((r) => (
                        <ReviewRowCompact
                          key={r.prNumber !== null ? `#${r.prNumber}` : r.branch}
                          r={r}
                          reviewing
                          onOpenReview={onOpenReview}
                        />
                      ))}
                    </Bucket>
                  )}
                  {/* Archived (closed/merged-PR) reviews are hidden by default —
                      they're done. Reveal on demand; Rust re-derives the list. */}
                  {showKind('in-review') && githubIncluded && (
                    <button
                      type="button"
                      onClick={() => setShowArchived((v) => !v)}
                      style={{
                        alignSelf: 'flex-start',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        background: 'none',
                        border: 'none',
                        padding: '2px 2px',
                        cursor: 'pointer',
                        fontSize: 11.5,
                        color: 'var(--gray-500)',
                      }}
                    >
                      <Icon name="eye" size={11} color="var(--gray-500)" />
                      {showArchived ? `Hide archived (${archivedShown})` : 'Show archived'}
                    </button>
                  )}
                  {showKind('open-prs') && openReviewer.filter(matchRow).length > 0 && (
                    <Bucket
                      color="var(--gray-400)"
                      title="Open PRs"
                      hint="on GitHub, no review"
                      count={openReviewer.length}
                    >
                      {openReviewer.filter(matchRow).map((r) => (
                        <OpenPrRowCompact
                          key={r.prNumber}
                          r={r}
                          reviewing
                          onOpenReview={onOpenReview}
                        />
                      ))}
                    </Bucket>
                  )}
                </Column>
              )}
            </div>
          </div>
        </div>
        {newReviewOpen && (
          <NewReviewModal
            branchRows={branchRows}
            prefillBranch={newReviewBranch}
            onClose={() => setNewReviewOpen(false)}
            onCreated={onOpenStoryline}
          />
        )}
        {discardTarget && (
          <ConfirmDialog
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
              await load(showArchived);
            }}
            onClose={() => setDiscardTarget(null)}
          />
        )}
        {switchTarget && switchTarget.outcome.kind === 'plan' && (
          <GitStepsDialog
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
              await load(showArchived);
            }}
            onClose={() => setSwitchTarget(null)}
          />
        )}
        {switchTarget &&
          switchTarget.outcome.kind === 'checkedOutElsewhere' &&
          (() => {
            const { worktreePath } = switchTarget.outcome;
            return (
              <ConfirmDialog
                title={`Already checked out — ${switchTarget.branch}`}
                body={
                  <>
                    <span className="mono">{switchTarget.branch}</span> is checked out in another
                    worktree (<span className="mono">{worktreePath}</span>) — git forbids a second
                    checkout. Focus that worktree instead.
                  </>
                }
                confirmLabel="Focus that worktree"
                onConfirm={async () => {
                  await setFocusedWorktree(worktreePath);
                  await load(showArchived);
                }}
                onClose={() => setSwitchTarget(null)}
              />
            );
          })()}
      </div>
    </div>
  );
}

/** Pointer-drag + keyboard resize for the rail (extracted so the component body
 *  above stays readable; behaviour identical to the reference screen). */
function useRailResize(setRailWidth: (fn: (w: number) => number) => void) {
  const railRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const left = railRef.current?.getBoundingClientRect().left ?? 0;
    handleRef.current?.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: PointerEvent) => setRailWidth(() => clampRail(ev.clientX - left));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      handleRef.current?.classList.remove('dragging');
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const onResizeKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setRailWidth((w) => clampRail(w - 16));
    else if (e.key === 'ArrowRight') setRailWidth((w) => clampRail(w + 16));
  };
  return { railRef, handleRef, startResize, onResizeKey };
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

function FilterRow({
  label,
  count,
  active,
  dot,
  sub,
  icon,
  onClick,
}: {
  label: string;
  count: number;
  active?: boolean;
  dot?: string;
  sub?: string;
  icon?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 5,
        border: 'none',
        textAlign: 'left',
        cursor: 'default',
        background: active ? 'rgba(0,0,0,0.06)' : 'transparent',
        color: 'var(--gray-800)',
        fontSize: 12.5,
        fontFamily: 'inherit',
        fontWeight: active ? 600 : 500,
      }}
    >
      {dot && (
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            background: dot,
            flex: '0 0 7px',
          }}
        />
      )}
      {icon && <span style={{ color: 'var(--gray-500)', display: 'flex' }}>{icon}</span>}
      {!dot && !icon && <span style={{ width: 7, height: 7, flex: '0 0 7px' }} />}
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {sub && (
        <span style={{ fontSize: 10.5, color: 'var(--gray-400)', fontWeight: 500 }}>{sub}</span>
      )}
      <span
        style={{
          color: 'var(--gray-500)',
          fontSize: 11.5,
          fontWeight: 500,
          marginLeft: 4,
        }}
      >
        {count}
      </span>
    </button>
  );
}

function Column({
  icon,
  title,
  count,
  tint,
  border,
  accent,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  tint: string;
  border: string;
  accent: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        background: tint,
        border: `1px solid ${border}`,
        borderRadius: 'var(--r-lg)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 14px',
          background: '#fff',
          borderBottom: `1px solid ${border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        {icon}
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: -0.01,
              color: 'var(--gray-900)',
            }}
          >
            {title}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 1 }}>
            {count} item{count === 1 ? '' : 's'}
          </div>
        </div>
        <span style={{ width: 6, height: 24, borderRadius: 3, background: accent }} />
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Bucket({
  color,
  title,
  hint,
  count,
  children,
}: {
  color: string;
  title: string;
  hint: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 6,
          paddingLeft: 2,
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: 4, background: color }} />
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            color: 'var(--gray-800)',
            letterSpacing: 0.02,
          }}
        >
          {title}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--gray-500)' }}>· {hint}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: 'var(--gray-500)', fontWeight: 600 }}>{count}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}

function DiffStat({ signal }: { signal: OverviewRow['signal'] }) {
  if (!signal) return null;
  return (
    <span>
      <span style={{ color: 'var(--green-d)' }}>+{signal.added}</span>{' '}
      <span style={{ color: 'var(--red-d)' }}>−{signal.removed}</span>
    </span>
  );
}

function rowShell(): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: '#fff',
    border: '1px solid var(--hairline)',
    borderRadius: 'var(--r-md)',
    padding: '8px 10px',
    boxShadow: 'var(--sh-1)',
    minWidth: 0,
  };
}

/** A local branch with no Review yet — the Self-Review bucket row, carrying the
 *  worktree badges the old branch-list screen used to show. */
function BranchRowCompact({
  r,
  onStartSelfReview,
  onReadyToShare,
  onSwitchTo,
}: {
  r: OverviewRow;
  onStartSelfReview: (worktreePath: string) => void;
  onReadyToShare: (branch: string) => void;
  onSwitchTo: (branch: string) => void;
}) {
  const meta = r.branchMeta;
  const wt = meta?.worktree ?? null;
  const actionable = wt !== null && !wt.prunable;
  // The explicit switch targets the FOCUSED worktree, so it applies to any
  // local branch that isn't already checked out there — worktree or not.
  const switchable = meta !== null && !meta.isCurrent;
  return (
    // `group` drives the hover-reveal of the action buttons, matching the
    // reference branch rows.
    <div className="group" style={rowShell()}>
      <Icon name="branch" size={12} color="var(--gray-500)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="mono"
          title={r.branch}
          style={{
            fontSize: 12,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {r.branch}
        </div>
        {(meta?.isCurrent || wt || meta?.hasDebrief) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            {meta?.isCurrent && (
              <span className="badge badge-green" style={{ flex: '0 0 auto' }}>
                current
              </span>
            )}
            {wt &&
              (wt.isRoot ? (
                <span className="badge" style={{ flex: '0 0 auto' }}>
                  root
                </span>
              ) : (
                <span className="badge badge-purple" style={{ flex: '0 0 auto' }}>
                  ⌥ worktree
                </span>
              ))}
            {wt?.prunable && (
              <span className="badge badge-orange" style={{ flex: '0 0 auto' }}>
                prunable
              </span>
            )}
            {meta?.hasDebrief && (
              <span className="badge badge-blue" style={{ flex: '0 0 auto' }}>
                debrief
              </span>
            )}
          </div>
        )}
        <div
          style={{
            fontSize: 11,
            color: 'var(--gray-500)',
            marginTop: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            overflow: 'hidden',
          }}
        >
          <DiffStat signal={r.signal} />
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {meta?.lastCommit ? `${meta.lastCommit} · ` : ''}
            {meta ? relativeTimeFromEpoch(meta.updatedAt) : ''}
          </span>
        </div>
      </div>
      {/* Self-Review / Ready-to-share need the branch materialized in a worktree
          (the engine keys the draft off the focused worktree's branch, ADR-0022
          §3). A branch with no worktree renders without actions. Hover-reveal
          (opacity-0 keeps the space so the row doesn't reflow). */}
      {switchable && (
        <button
          type="button"
          className="btn opacity-0 group-hover:opacity-100 focus:opacity-100"
          onClick={() => onSwitchTo(r.branch)}
          style={{ transition: 'opacity 80ms ease' }}
        >
          <Icon name="branch" size={10} color="var(--gray-700)" /> Switch to…
        </button>
      )}
      {actionable && (
        <button
          type="button"
          className="btn opacity-0 group-hover:opacity-100 focus:opacity-100"
          onClick={() => onStartSelfReview(wt.path)}
          style={{ transition: 'opacity 80ms ease' }}
        >
          <Icon name="play" size={10} color="var(--gray-700)" /> Self-Review
        </button>
      )}
      {actionable && (
        <button
          type="button"
          className="btn btn-primary opacity-0 group-hover:opacity-100 focus:opacity-100"
          onClick={() => onReadyToShare(r.branch)}
          style={{ transition: 'opacity 80ms ease' }}
        >
          <Icon name="plus" size={10} color="#fff" /> Ready to share
        </button>
      )}
    </div>
  );
}

/** Status badge label + class per derived status (WS-5). Archived rows show
 *  the reference screen's plain "Archived" badge; a locally-published Review
 *  whose PR state is unknown (GitHub not consulted) says "Published" — absent
 *  state is shown as absent, never guessed. */
function statusBadge(r: OverviewRow): { label: string; cls: string } {
  if (r.archived) return { label: 'Archived', cls: '' };
  if (r.status === null) return { label: 'Published', cls: '' };
  const map: Record<ReviewStatus, { label: string; cls: string }> = {
    draft: { label: 'Draft', cls: '' },
    ready_to_publish: { label: 'Ready to publish', cls: 'badge-blue' },
    open: { label: 'In review', cls: 'badge-blue' },
    changes_requested: { label: 'Changes requested', cls: 'badge-orange' },
    approved: { label: 'Approved', cls: 'badge-green' },
    merged: { label: 'Archived', cls: '' },
    closed: { label: 'Archived', cls: '' },
  };
  return map[r.status];
}

/** A Review row — a per-machine draft or a published (PR-backed) Review. */
function ReviewRowCompact({
  r,
  reviewing,
  onBackToSelfReview,
  onOpenStoryline,
  onOpenReview,
}: {
  r: OverviewRow;
  reviewing?: boolean;
  onBackToSelfReview?: (r: OverviewRow) => void;
  onOpenStoryline?: (r: OverviewRow) => void;
  onOpenReview?: (pr: PrRef) => void;
}) {
  const st = statusBadge(r);
  const pr = prRefFromUrl(r.url);
  const composerReady = r.branchMeta?.worktree != null;
  return (
    <div style={rowShell()}>
      {reviewing && <Avatar name={r.authorLogin ?? '?'} size="sm" />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          title={r.title || r.branch}
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginBottom: 4,
          }}
        >
          {r.title || r.branch}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 4,
          }}
        >
          {r.prNumber !== null && (
            <span className="badge" style={{ background: 'rgba(0,0,0,0.06)', flex: '0 0 auto' }}>
              #{r.prNumber}
            </span>
          )}
          <span className={`badge ${st.cls}`} style={{ flex: '0 0 auto' }}>
            {st.label}
          </span>
        </div>
        {/* Branch on its own row — but only when it isn't already the heading
            (an untitled Review falls back to the branch name above). */}
        {r.title && r.title !== r.branch && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              marginBottom: 2,
              minWidth: 0,
            }}
          >
            <Icon name="branch" size={11} color="var(--gray-400)" />
            <span
              className="mono"
              title={r.branch}
              style={{
                fontSize: 11,
                color: 'var(--gray-500)',
                minWidth: 0,
                overflowWrap: 'anywhere',
              }}
            >
              {r.branch}
            </span>
          </div>
        )}
        <div
          style={{
            fontSize: 11,
            color: 'var(--gray-500)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            overflow: 'hidden',
          }}
        >
          <DiffStat signal={r.signal} />
          {r.storylineCount !== null && r.storylineCount > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="doc-stack" size={9} color="var(--gray-500)" /> {r.storylineCount}
            </span>
          )}
          {r.signal !== null && r.signal.comments > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="comment-fill" size={9} color="var(--gray-400)" /> {r.signal.comments}
            </span>
          )}
        </div>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--gray-500)', flex: '0 0 auto' }}>
        {r.updatedAt
          ? relativeTime(r.updatedAt)
          : r.branchMeta
            ? relativeTimeFromEpoch(r.branchMeta.updatedAt)
            : ''}
      </div>
      {onOpenStoryline && (
        <button
          type="button"
          className="btn"
          onClick={() => onOpenStoryline(r)}
          disabled={!composerReady}
          title={
            composerReady
              ? 'Open the storyline for this review'
              : 'Check the branch out in a worktree to compose its storyline'
          }
          style={{ flex: '0 0 auto', opacity: composerReady ? 1 : 0.5 }}
        >
          <Icon name="doc-stack" size={10} color="var(--gray-700)" /> Storyline
        </button>
      )}
      {reviewing && onOpenReview && pr && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onOpenReview(pr)}
          title="Walk this review's storyline read-only"
          style={{ flex: '0 0 auto' }}
        >
          <Icon name="eye" size={10} color="#fff" /> Review
        </button>
      )}
      {!reviewing && onOpenReview && pr && (
        <button
          type="button"
          className="btn"
          onClick={() => onOpenReview(pr)}
          title="Open this review's PR"
          style={{ flex: '0 0 auto' }}
        >
          <Icon name="eye" size={10} color="var(--gray-700)" /> Open
        </button>
      )}
      {onBackToSelfReview && (
        <button
          type="button"
          className="btn"
          onClick={() => onBackToSelfReview(r)}
          title="Discard this review and return the branch to Self-Review"
          style={{ flex: '0 0 auto' }}
        >
          <Icon name="chevron-left" size={10} color="var(--gray-700)" /> Back to Self-Review
        </button>
      )}
    </div>
  );
}

/** A plain GitHub PR (no Review anywhere we can see, DB-3). Opens in the local
 *  read-only reviewer — a storyline-less PR degrades to the plain diff there. */
function OpenPrRowCompact({
  r,
  reviewing,
  onOpenReview,
}: {
  r: OverviewRow;
  reviewing?: boolean;
  onOpenReview: (pr: PrRef) => void;
}) {
  const pr = prRefFromUrl(r.url);
  const open = () => {
    if (pr) onOpenReview(pr);
    else if (r.url) openUrl(r.url).catch((e) => console.warn('open_url_failed', e));
  };
  return (
    <div style={rowShell()}>
      {reviewing ? (
        <Avatar name={r.authorLogin ?? '?'} size="sm" />
      ) : (
        <Icon name="gh" size={13} color="var(--gray-600)" />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          title={r.title}
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginBottom: 4,
          }}
        >
          {r.title}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 4,
          }}
        >
          <span
            className="badge"
            style={{
              background: 'rgba(0,0,0,0.06)',
              flex: '0 0 auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
            }}
          >
            <Icon name="gh" size={9} color="var(--gray-700)" /> #{r.prNumber}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            marginBottom: 2,
            minWidth: 0,
          }}
        >
          <Icon name="branch" size={11} color="var(--gray-400)" />
          <span
            className="mono"
            title={r.branch}
            style={{
              fontSize: 11,
              color: 'var(--gray-500)',
              minWidth: 0,
              overflowWrap: 'anywhere',
            }}
          >
            {r.branch}
          </span>
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--gray-500)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            overflow: 'hidden',
          }}
        >
          <DiffStat signal={r.signal} />
          {r.updatedAt && <span>{relativeTime(r.updatedAt)}</span>}
        </div>
      </div>
      <button type="button" className="btn" onClick={open} title={r.url ?? undefined}>
        <Icon name="play" size={10} color="var(--gray-700)" /> Review
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in via {children} (select/input), which Biome can't statically associate.
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          color: 'var(--gray-600)',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
    </label>
  );
}

/** "Ready to share" (WS-2 #60): pick a branch (checked out in a worktree — the
 *  engine keys the draft off the focused worktree), a base, and an optional
 *  title; creates the per-machine draft and opens the storyline composer. */
function NewReviewModal({
  branchRows,
  prefillBranch,
  onClose,
  onCreated,
}: {
  branchRows: OverviewRow[];
  prefillBranch?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const withWorktree = branchRows.filter(
    (r) => r.branchMeta?.worktree && !r.branchMeta.worktree.prunable,
  );
  const without = branchRows.filter(
    (r) => !r.branchMeta?.worktree || r.branchMeta.worktree.prunable,
  );
  const [headRef, setHeadRef] = useState(prefillBranch ?? withWorktree[0]?.branch ?? '');
  // Base is the PR merge target, stored remote-tracking (`origin/<name>`) so
  // the diff prefers the remote copy; Publish strips the prefix for gh.
  const [baseRef, setBaseRef] = useState('');
  const [baseOptions, setBaseOptions] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const remote = await gitRemoteBranches();
        const names = remote.map((b) =>
          b.name.startsWith('origin/') ? b.name : `origin/${b.name}`,
        );
        setBaseOptions(names);
        setBaseRef((cur) => cur || names.find((n) => n === 'origin/main') || names[0] || 'main');
      } catch (e) {
        // Additive: without remote branches the field falls back to free text
        // via the lone current value; creation still works (local-first).
        console.warn('new_review_remote_branches_failed', e);
        setBaseRef((cur) => cur || 'main');
      }
    })();
  }, []);

  const submit = async () => {
    if (!headRef) {
      setError('Pick a branch to share.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const row = branchRows.find((r) => r.branch === headRef);
      const wt = row?.branchMeta?.worktree;
      if (!wt || wt.prunable) {
        throw new Error(
          `Branch '${headRef}' isn't checked out in a worktree — check it out first, then mark it Ready to share.`,
        );
      }
      // The draft is keyed off the focused worktree's branch (ADR-0022 §3):
      // focus first, then create.
      await setFocusedWorktree(wt.path);
      await reviewDraftCreate(title.trim() || headRef, baseRef.trim() || 'main');
      onClose();
      onCreated();
    } catch (e) {
      // Fail loud (CLAUDE.md): surface the engine's message verbatim in the
      // modal; never close on a swallowed error.
      console.warn('review_draft_create_failed', e);
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: overlay modal; a styled div with role="dialog" matches the existing RepoMenu pattern rather than a native <dialog>.
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New review"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 420,
          background: '#fff',
          borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--sh-pop)',
          padding: 18,
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: 'var(--gray-900)',
            marginBottom: 14,
          }}
        >
          New review
        </div>

        <Field label="Branch">
          <select
            className="input"
            value={headRef}
            onChange={(e) => setHeadRef(e.target.value)}
            style={{ width: '100%' }}
          >
            {withWorktree.length === 0 && (
              <option value="">No worktree-backed branches without a review</option>
            )}
            {withWorktree.map((r) => (
              <option key={r.branch} value={r.branch}>
                {r.branch}
              </option>
            ))}
            {without.map((r) => (
              <option key={r.branch} value={r.branch} disabled>
                {r.branch} — no worktree
              </option>
            ))}
          </select>
        </Field>

        <Field label="Base">
          <select
            className="input"
            value={baseRef}
            onChange={(e) => setBaseRef(e.target.value)}
            style={{ width: '100%' }}
          >
            {(() => {
              const seen = new Set<string>();
              const opts: string[] = [];
              for (const n of [...baseOptions, baseRef]) {
                if (!n || seen.has(n)) continue;
                seen.add(n);
                opts.push(n);
              }
              return opts.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ));
            })()}
          </select>
        </Field>

        <Field label="Title (optional)">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={headRef || 'Review title'}
            style={{ width: '100%' }}
          />
        </Field>

        {error && (
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--red-d)',
              background: 'rgba(255,59,48,0.08)',
              border: '1px solid rgba(255,59,48,0.20)',
              borderRadius: 'var(--r-sm)',
              padding: '6px 10px',
              marginBottom: 8,
            }}
          >
            Couldn't create the review: {error}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 14,
          }}
        >
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={submitting || !headRef}
            style={{ opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      console.warn('confirm_action_failed', e);
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: overlay modal; a styled div with role="dialog" matches the existing NewReviewModal/RepoMenu pattern rather than a native <dialog>.
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 380,
          background: '#fff',
          borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--sh-pop)',
          padding: 18,
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: 'var(--gray-900)',
            marginBottom: 8,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: 'var(--gray-700)',
            lineHeight: 1.5,
            marginBottom: 14,
          }}
        >
          {body}
        </div>
        {error && (
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--red-d)',
              background: 'rgba(255,59,48,0.08)',
              border: '1px solid rgba(255,59,48,0.20)',
              borderRadius: 'var(--r-sm)',
              padding: '6px 10px',
              marginBottom: 8,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={confirm}
            disabled={submitting}
            style={{ opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
