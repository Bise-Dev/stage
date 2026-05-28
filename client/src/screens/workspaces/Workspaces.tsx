import { listen } from '@tauri-apps/api/event';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { TitleBar } from '../../components/TitleBar';
import {
  type BranchInfo,
  type DiffStats,
  type OverviewOpenPrRow,
  type OverviewRow,
  type OverviewWorkspaceRow,
  type User,
  type WorkspaceState,
  getActiveRepo,
  gitDiffStats,
  gitFetch,
  gitLocalBranches,
  openInFinder,
  openUrl,
  repoOverview,
  repoSummary,
} from '../../tauri';
import { relativeTime, relativeTimeFromEpoch } from './data';

type Show = 'all' | 'yours' | 'review';
type Kind = 'self-review' | 'ready-to-share' | 'in-review' | 'open-prs';

const RAIL_MIN = 160;
const RAIL_MAX = 360;
const RAIL_DEFAULT = 200;
const RAIL_KEY = 'workspaces:rail-width';

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

export function Workspaces({ user, onChangeRepo }: { user: User; onChangeRepo: () => void }) {
  const me = user.github_login;
  const [repoSlug, setRepoSlug] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [ghRepo, setGhRepo] = useState<{ owner: string; repo: string } | null>(null);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [diffStats, setDiffStats] = useState<Record<string, DiffStats>>({});
  const [show, setShow] = useState<Show>('all');
  const [kind, setKind] = useState<Kind | null>(null);
  const [query, setQuery] = useState('');
  const [railWidth, setRailWidth] = useRailWidth();
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);

  const loadBranches = useCallback(async () => {
    try {
      setBranches(await gitLocalBranches());
      setBranchesError(null);
    } catch (e) {
      // Fail loud (see CLAUDE.md "Error handling"): the Rust side names the
      // offending ref, surface that to the user in a red banner instead of
      // silently rendering an empty Self-Review bucket.
      console.warn('workspaces_branches_failed', e);
      const msg =
        typeof e === 'object' && e !== null && 'message' in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setBranchesError(msg);
    }
  }, []);

  const loadOverview = useCallback(async (owner: string, repo: string) => {
    try {
      setRows(await repoOverview(owner, repo));
      setOverviewError(null);
    } catch (e) {
      // Any failure here is a hard fail per the project's error-handling
      // convention (see CLAUDE.md "Error handling"): no silent fallbacks, no
      // half-rendered overviews. Surface the API's message verbatim.
      console.warn('workspaces_overview_failed', e);
      const msg =
        typeof e === 'object' && e !== null && 'message' in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setOverviewError(msg);
    }
  }, []);

  // Active repo → rail slug/path, default branch, and the GitHub overview.
  useEffect(() => {
    (async () => {
      const repo = await getActiveRepo();
      if (!repo) return;
      setRepoPath(repo.path);
      try {
        const sum = await repoSummary(repo.path);
        const slug = slugFromRemote(sum.remoteUrl);
        setRepoSlug(slug);
        setDefaultBranch(sum.defaultBranch);
        if (slug) {
          const [owner, name] = slug.split('/');
          setGhRepo({ owner, repo: name });
          loadOverview(owner, name);
        }
      } catch {
        // Non-fatal: the rail just shows the folder name and no overview.
      }
    })();
  }, [loadOverview]);

  // Branches: initial + live on working-tree / ref changes.
  useEffect(() => {
    loadBranches();
    const unlisten = listen('repo-changed', () => loadBranches());
    return () => {
      unlisten.then((u) => u());
    };
  }, [loadBranches]);

  // Local diff stats for things checked out locally: Self-Review branches
  // (vs default branch) and pre-publish workspaces (head vs base). Published
  // rows + Open PRs already carry GitHub additions/deletions. Branches that
  // already have a Workspace are excluded here — they're rendered by the
  // workspace target instead. Sharing diffStats[head_ref] between the two
  // would race the writes when base differs (default branch vs workspace base).
  useEffect(() => {
    const wsHeads = new Set(
      rows.filter((r): r is OverviewWorkspaceRow => r.kind === 'workspace').map((r) => r.head_ref),
    );
    const targets: { base: string; head: string }[] = [];
    if (defaultBranch) {
      for (const b of branches) {
        if (!wsHeads.has(b.name)) targets.push({ base: defaultBranch, head: b.name });
      }
    }
    for (const r of rows) {
      if (r.kind === 'workspace' && r.pr_number === null) {
        targets.push({ base: r.base_ref, head: r.head_ref });
      }
    }
    if (targets.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        targets.map(async (t) => {
          try {
            return [t.head, await gitDiffStats(t.base, t.head)] as const;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const next: Record<string, DiffStats> = {};
      for (const e of entries) if (e) next[e[0]] = e[1];
      setDiffStats(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [branches, rows, defaultBranch]);

  const runFetch = async () => {
    // Each step routes its failure to its own red banner so the user can
    // tell what actually broke (see CLAUDE.md "Error handling"). gitFetch
    // and repoSummary share the toolbar's fetchError slot; loadBranches /
    // loadOverview set their own dedicated banners.
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
      await loadBranches();
      if (ghRepo) await loadOverview(ghRepo.owner, ghRepo.repo);
    } finally {
      setFetching(false);
    }
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const left = railRef.current?.getBoundingClientRect().left ?? 0;
    handleRef.current?.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: PointerEvent) => setRailWidth(clampRail(ev.clientX - left));
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

  // Split overview rows into buckets.
  const workspaceRows = rows.filter((r): r is OverviewWorkspaceRow => r.kind === 'workspace');
  const openPrRows = rows.filter((r): r is OverviewOpenPrRow => r.kind === 'open_pr');
  // Self-Review = "branch, no workspace" (see docs/NOT-IMPLEMENTED.md). Drop
  // any branch that already has a Workspace — otherwise it would render in
  // both Self-Review and Ready-to-share/In-review.
  const workspaceHeadRefs = new Set(workspaceRows.map((w) => w.head_ref));
  const selfReviewBranches = branches.filter((b) => !workspaceHeadRefs.has(b.name));
  const yoursReadyToShare = workspaceRows.filter(
    (w) => w.pr_number === null && w.created_by.github_login === me,
  );
  const yoursInReview = workspaceRows.filter(
    (w) => w.pr_number !== null && w.created_by.github_login === me,
  );
  const reviewInReview = workspaceRows.filter(
    (w) => w.pr_number !== null && w.created_by.github_login !== me,
  );
  const openAuthor = openPrRows.filter((p) => p.role === 'author');
  const openReviewer = openPrRows.filter((p) => p.role === 'reviewer');

  const q = query.trim().toLowerCase();
  const matchBranch = (b: BranchInfo) =>
    !q || b.name.toLowerCase().includes(q) || (b.lastCommit?.toLowerCase().includes(q) ?? false);
  const matchWorkspace = (w: OverviewWorkspaceRow) =>
    !q ||
    w.title.toLowerCase().includes(q) ||
    w.head_ref.toLowerCase().includes(q) ||
    w.created_by.github_login.toLowerCase().includes(q) ||
    (w.pr_number !== null && `#${w.pr_number}`.includes(q));
  const matchOpenPr = (p: OverviewOpenPrRow) =>
    !q ||
    p.title.toLowerCase().includes(q) ||
    (p.author.login?.toLowerCase().includes(q) ?? false) ||
    (p.head_ref?.toLowerCase().includes(q) ?? false) ||
    `#${p.number}`.includes(q);

  // Local diff for a pre-publish workspace (published rows use GitHub stats).
  const wsStats = (w: OverviewWorkspaceRow): { added: number | null; removed: number | null } => {
    if (w.pr_number !== null) return { added: w.added, removed: w.removed };
    const d = diffStats[w.head_ref];
    return d ? { added: d.added, removed: d.removed } : { added: null, removed: null };
  };

  const kindCounts = {
    'self-review': selfReviewBranches.length,
    'ready-to-share': workspaceRows.filter((w) => w.pr_number === null).length,
    'in-review': workspaceRows.filter((w) => w.pr_number !== null).length,
    'open-prs': openPrRows.length,
  };
  const yoursCount =
    selfReviewBranches.length + yoursReadyToShare.length + yoursInReview.length + openAuthor.length;
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
            ref={railRef}
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
                sub="no workspace"
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
                sub="workspace + PR"
                active={kind === 'in-review'}
                onClick={() => toggleKind('in-review')}
              />
              <FilterRow
                icon={<Icon name="gh" size={11} />}
                label="Open PRs"
                count={kindCounts['open-prs']}
                sub="no workspace"
                active={kind === 'open-prs'}
                onClick={() => toggleKind('open-prs')}
              />
            </div>

            <div style={{ flex: 1 }} />

            <div className="section-label" style={{ marginTop: 14, padding: '0 6px' }}>
              Repository
            </div>
            <RepoMenu slug={repoSlug} path={repoPath} onChangeRepo={onChangeRepo} />
          </div>

          {/* Resizable divider */}
          <button
            type="button"
            ref={handleRef}
            className="rail-resize"
            onPointerDown={startResize}
            onKeyDown={onResizeKey}
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
                  style={{ paddingLeft: 28 }}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn btn-lg"
                onClick={runFetch}
                disabled={fetching}
                style={{ opacity: fetching ? 0.6 : 1 }}
              >
                <Icon name="branch" size={12} color="var(--gray-700)" />{' '}
                {fetching ? 'Fetching…' : 'Fetch'}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => console.info('workspaces_new_stub', 'toolbar')}
              >
                <Icon name="plus" size={12} color="#fff" /> New workspace
              </button>
            </div>

            {fetchError && (
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
                Fetch failed: {fetchError}
              </div>
            )}

            {overviewError && (
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
                Couldn't load workspaces overview: {overviewError}
              </div>
            )}

            {branchesError && (
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
                Couldn't list local branches: {branchesError}
              </div>
            )}

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
                  icon={<Avatar name={user.display_name || me} size="lg" />}
                  title="Authored by you"
                  count={yoursCount}
                  tint="rgba(0,122,255,0.04)"
                  border="rgba(0,122,255,0.16)"
                  accent="var(--blue)"
                >
                  {showKind('self-review') && selfReviewBranches.filter(matchBranch).length > 0 && (
                    <Bucket
                      color="var(--orange)"
                      title="Self-Review"
                      hint="no workspace"
                      count={selfReviewBranches.length}
                    >
                      {selfReviewBranches.filter(matchBranch).map((b) => (
                        <BranchRowCompact key={b.name} b={b} stats={diffStats[b.name]} />
                      ))}
                    </Bucket>
                  )}
                  {showKind('ready-to-share') &&
                    yoursReadyToShare.filter(matchWorkspace).length > 0 && (
                      <Bucket
                        color="var(--blue)"
                        title="Ready to share"
                        hint="not on GitHub"
                        count={yoursReadyToShare.length}
                      >
                        {yoursReadyToShare.filter(matchWorkspace).map((w) => (
                          <WorkspaceRowCompact key={w.id} w={w} stats={wsStats(w)} />
                        ))}
                      </Bucket>
                    )}
                  {showKind('in-review') && yoursInReview.filter(matchWorkspace).length > 0 && (
                    <Bucket
                      color="var(--purple)"
                      title="In review"
                      hint="workspace + PR"
                      count={yoursInReview.length}
                    >
                      {yoursInReview.filter(matchWorkspace).map((w) => (
                        <WorkspaceRowCompact key={w.id} w={w} stats={wsStats(w)} />
                      ))}
                    </Bucket>
                  )}
                  {showKind('open-prs') && openAuthor.filter(matchOpenPr).length > 0 && (
                    <Bucket
                      color="var(--gray-400)"
                      title="Open PRs"
                      hint="on GitHub, no workspace"
                      count={openAuthor.length}
                    >
                      {openAuthor.filter(matchOpenPr).map((p) => (
                        <OpenPrRowCompact key={p.number} p={p} />
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
                  {showKind('in-review') && reviewInReview.filter(matchWorkspace).length > 0 && (
                    <Bucket
                      color="var(--purple)"
                      title="In review"
                      hint="workspace + PR"
                      count={reviewInReview.length}
                    >
                      {reviewInReview.filter(matchWorkspace).map((w) => (
                        <WorkspaceRowCompact key={w.id} w={w} stats={wsStats(w)} reviewing />
                      ))}
                    </Bucket>
                  )}
                  {showKind('open-prs') && openReviewer.filter(matchOpenPr).length > 0 && (
                    <Bucket
                      color="var(--gray-400)"
                      title="Open PRs"
                      hint="on GitHub, no workspace"
                      count={openReviewer.length}
                    >
                      {openReviewer.filter(matchOpenPr).map((p) => (
                        <OpenPrRowCompact key={p.number} p={p} reviewing />
                      ))}
                    </Bucket>
                  )}
                </Column>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

function RepoMenu({
  slug,
  path,
  onChangeRepo,
}: {
  slug: string | null;
  path: string | null;
  onChangeRepo: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = slug ?? (path ? basename(path) : '—');

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          width: '100%',
          textAlign: 'left',
          background: open ? 'rgba(0,0,0,0.05)' : 'none',
          border: 'none',
          borderRadius: 5,
          padding: '4px 10px',
          cursor: 'default',
          fontFamily: 'inherit',
          minWidth: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Icon name="folder" size={13} color="var(--gray-500)" />
          <span
            style={{
              flex: 1,
              fontSize: 12.5,
              fontWeight: 500,
              color: 'var(--gray-800)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
            title={path ?? undefined}
          >
            {label}
          </span>
          <span style={{ display: 'flex', color: 'var(--gray-400)', flex: '0 0 auto' }}>
            <Icon name="chevron-right" size={11} />
          </span>
        </div>
        {path && (
          <div
            className="mono"
            style={{
              paddingLeft: 19,
              marginTop: 1,
              color: 'var(--gray-500)',
              fontSize: 11,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {path}
          </div>
        )}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            right: 0,
            marginBottom: 6,
            background: '#fff',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--sh-pop)',
            padding: 4,
            zIndex: 20,
          }}
        >
          <MenuItem
            onClick={() => {
              setOpen(false);
              onChangeRepo();
            }}
          >
            Change repository…
          </MenuItem>
          <MenuItem
            disabled={!path}
            onClick={() => {
              setOpen(false);
              if (path) openInFinder(path).catch((e) => console.warn('open_in_finder_failed', e));
            }}
          >
            Reveal in Finder
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'none',
        border: 'none',
        borderRadius: 5,
        padding: '6px 8px',
        fontFamily: 'inherit',
        fontSize: 12.5,
        color: disabled ? 'var(--gray-400)' : 'var(--gray-800)',
        cursor: 'default',
      }}
    >
      {children}
    </button>
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
        <span style={{ width: 7, height: 7, borderRadius: 4, background: dot, flex: '0 0 7px' }} />
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
      <span style={{ color: 'var(--gray-500)', fontSize: 11.5, fontWeight: 500, marginLeft: 4 }}>
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

function DiffStat({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null || removed === null) return null;
  return (
    <span>
      <span style={{ color: 'var(--green-d)' }}>+{added}</span>{' '}
      <span style={{ color: 'var(--red-d)' }}>−{removed}</span>
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

function BranchRowCompact({ b, stats }: { b: BranchInfo; stats?: DiffStats }) {
  return (
    <div style={rowShell()}>
      <Icon name="branch" size={12} color="var(--gray-500)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            className="mono"
            style={{
              fontSize: 12,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {b.name}
          </span>
          {b.isHead && (
            <span className="badge badge-green" style={{ flex: '0 0 auto' }}>
              current
            </span>
          )}
        </div>
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
          {stats && <DiffStat added={stats.added} removed={stats.removed} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {b.lastCommit ? `${b.lastCommit} · ` : ''}
            {relativeTimeFromEpoch(b.updatedAt)}
          </span>
        </div>
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => console.info('workspaces_self_review_stub', b.name)}
      >
        <Icon name="play" size={10} color="var(--gray-700)" /> Self-Review
      </button>
    </div>
  );
}

const STATES: Record<WorkspaceState, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: '' },
  ready_to_publish: { label: 'Ready to publish', cls: 'badge-blue' },
  in_review: { label: 'In review', cls: 'badge-blue' },
  changes_requested: { label: 'Changes requested', cls: 'badge-orange' },
  approved: { label: 'Approved', cls: 'badge-green' },
  frozen: { label: 'Frozen', cls: '' },
};

function WorkspaceRowCompact({
  w,
  stats,
  reviewing,
}: {
  w: OverviewWorkspaceRow;
  stats: { added: number | null; removed: number | null };
  reviewing?: boolean;
}) {
  const st = STATES[w.state];
  return (
    <div style={rowShell()}>
      {reviewing && <Avatar name={w.created_by.github_login} size="sm" />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: '0 1 auto',
            }}
          >
            {w.title || w.head_ref}
          </span>
          {w.pr_number !== null && (
            <span className="badge" style={{ background: 'rgba(0,0,0,0.06)', flex: '0 0 auto' }}>
              #{w.pr_number}
            </span>
          )}
          <span className={`badge ${st.cls}`} style={{ flex: '0 0 auto' }}>
            {st.label}
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
          <span
            className="mono"
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '40%',
            }}
          >
            {w.head_ref}
          </span>
          <DiffStat added={stats.added} removed={stats.removed} />
          {w.storyline_count > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="doc-stack" size={9} color="var(--gray-500)" /> {w.storyline_count}
            </span>
          )}
          {w.comment_count !== null && w.comment_count > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="comment-fill" size={9} color="var(--gray-400)" /> {w.comment_count}
            </span>
          )}
        </div>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--gray-500)', flex: '0 0 auto' }}>
        {relativeTime(w.last_active_at)}
      </div>
    </div>
  );
}

function OpenPrRowCompact({ p, reviewing }: { p: OverviewOpenPrRow; reviewing?: boolean }) {
  return (
    <div style={rowShell()}>
      {reviewing ? (
        <Avatar name={p.author.login ?? '?'} size="sm" />
      ) : (
        <Icon name="gh" size={13} color="var(--gray-600)" />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {p.title}
          </span>
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
            <Icon name="gh" size={9} color="var(--gray-700)" /> #{p.number}
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
          {p.head_ref && (
            <span
              className="mono"
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '40%',
              }}
            >
              {p.head_ref}
            </span>
          )}
          <DiffStat added={p.added} removed={p.removed} />
          {p.updated_at && <span>{relativeTime(p.updated_at)}</span>}
        </div>
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => openUrl(p.html_url).catch((e) => console.warn('open_url_failed', e))}
        title={p.html_url}
      >
        <Icon name="play" size={10} color="var(--gray-700)" /> Review
      </button>
    </div>
  );
}
