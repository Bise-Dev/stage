import { useCallback, useEffect, useMemo, useState } from 'react';

import { FetchButton } from '../../components/FetchButton';
import { Icon } from '../../components/Icon';
import { RepoMenu } from '../../components/RepoMenu';
import { TitleBar } from '../../components/TitleBar';
import {
  type BranchInfo,
  type WorktreeInfo,
  getActiveRepo,
  gitFetch,
  gitLocalBranches,
  onRepoChanged,
  onWorktreesChanged,
  repoDebriefBranches,
  repoSummary,
  repoWorktrees,
  setFocusedWorktree,
} from '../../tauri';
import { RepoBranchList, type RepoFilter, buildRepoRows, repoRowCounts } from './RepoBranchList';

/** Owner/name from a remote URL, else the path's basename. Mirrors the Rust
 *  `slug_from_remote`. */
function repoLabel(remoteUrl: string | null, path: string): string {
  if (remoteUrl) {
    const trimmed = remoteUrl.replace(/\/$/, '').replace(/\.git$/, '');
    const segs = trimmed.split(/[/:]/).filter(Boolean);
    if (segs.length >= 2) return `${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
  }
  const parts = path.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || path;
}

/** A row in the left filter rail's "Show" group. */
function FilterRow({
  label,
  count,
  active,
  icon,
  onClick,
}: {
  label: string;
  count: number | string;
  active?: boolean;
  icon?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-default"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 5,
        border: 'none',
        width: '100%',
        textAlign: 'left',
        background: active ? 'rgba(0,0,0,0.06)' : 'transparent',
        color: 'var(--gray-800)',
        fontSize: 12.5,
        fontFamily: 'inherit',
        fontWeight: active ? 600 : 500,
      }}
    >
      {icon ? (
        <span style={{ color: 'var(--gray-500)', display: 'flex' }}>{icon}</span>
      ) : (
        <span style={{ width: 7, flex: '0 0 7px' }} />
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <span style={{ color: 'var(--gray-500)', fontSize: 11.5, fontWeight: 500, marginLeft: 4 }}>
        {count}
      </span>
    </button>
  );
}

/**
 * The local-only landing after opening a repo (ADR-0016), restyled to the
 * Workspaces vocabulary (design v3): a left filter rail, a search/action bar,
 * and card-style branch rows grouped into Worktrees / Repository-root / plain
 * buckets. Self-Review on a worktree-backed branch focuses that worktree then
 * enters the Self-Review screen. Refreshes on repo / worktree changes so an
 * externally-created worktree (e.g. agent-deck) appears live.
 */
export function RepoHome({
  onEnterSelfReview,
  onEnterStoryline,
  onOpenDashboard,
  onChangeRepo,
  onOpenSettings,
}: {
  onEnterSelfReview: () => void;
  onEnterStoryline: () => void;
  onOpenDashboard: () => void;
  onChangeRepo: () => void;
  onOpenSettings: () => void;
}) {
  const [label, setLabel] = useState('…');
  const [repoPath, setRepoPath] = useState('');
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [debriefBranches, setDebriefBranches] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RepoFilter>('all');

  const reload = useCallback(async () => {
    try {
      const [b, w, d] = await Promise.all([
        gitLocalBranches(),
        repoWorktrees(),
        repoDebriefBranches(),
      ]);
      setBranches(b);
      setWorktrees(w);
      setDebriefBranches(new Set(d));
      setError(null);
    } catch (e) {
      console.warn('repo_home_reload_failed', e);
      setError(String(e));
    }
  }, []);

  // Initial load: repo label + default branch (once), then branches + worktrees.
  useEffect(() => {
    (async () => {
      try {
        const r = await getActiveRepo();
        if (!r) {
          setError('No active repository.');
          return;
        }
        setRepoPath(r.path);
        const sum = await repoSummary(r.path);
        setLabel(repoLabel(sum.remoteUrl, r.path));
        setDefaultBranch(sum.defaultBranch);
      } catch (e) {
        console.warn('repo_home_bootstrap_failed', e);
        setError(String(e));
      }
      await reload();
    })();
  }, [reload]);

  // Live refresh on repo / worktree changes. NOTE: `worktrees-changed` is an
  // over-eager signal -- it fires on any common-dir activity (commits, fetches),
  // not only when the worktree set changes. `reload` is therefore idempotent:
  // it re-fetches and reconciles, and a no-op re-list simply re-renders the same
  // rows. Both events share the same debounced reload; coalescing is fine.
  useEffect(() => {
    const offs: Array<Promise<() => void>> = [onRepoChanged(reload), onWorktreesChanged(reload)];
    return () => {
      for (const off of offs) void off.then((f) => f());
    };
  }, [reload]);

  const onFetch = useCallback(async () => {
    setFetching(true);
    setError(null);
    try {
      await gitFetch();
      await reload();
    } catch (e) {
      console.warn('repo_home_fetch_failed', e);
      setError(String(e));
    } finally {
      setFetching(false);
    }
  }, [reload]);

  const onSelfReview = useCallback(
    async (worktreePath: string) => {
      try {
        await setFocusedWorktree(worktreePath);
        onEnterSelfReview();
      } catch (e) {
        console.warn('repo_home_focus_failed', e);
        setError(String(e));
      }
    },
    [onEnterSelfReview],
  );

  const rows = useMemo(
    () => buildRepoRows(branches, worktrees, defaultBranch, debriefBranches),
    [branches, worktrees, defaultBranch, debriefBranches],
  );
  const counts = useMemo(() => repoRowCounts(rows), [rows]);

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title={`Stage — ${label}`} />
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Left filter rail */}
          <div
            style={{
              width: 200,
              flex: '0 0 200px',
              borderRight: '1px solid var(--hairline)',
              padding: '14px 10px',
              background: '#fbfaf8',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 6px 8px',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-700)' }}>
                Branches
              </div>
              <Icon name="branch" size={13} color="var(--gray-500)" />
            </div>

            <div className="section-label" style={{ padding: '0 6px' }}>
              Show
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <FilterRow
                label="All branches"
                count={counts.all}
                active={filter === 'all'}
                onClick={() => setFilter('all')}
              />
              <FilterRow
                label="Worktrees"
                count={counts.worktrees}
                active={filter === 'worktrees'}
                onClick={() => setFilter('worktrees')}
              />
              <FilterRow
                label="Repository root"
                count={counts.root}
                active={filter === 'root'}
                onClick={() => setFilter('root')}
              />
            </div>

            <div style={{ flex: 1 }} />

            <div className="section-label" style={{ marginTop: 14, padding: '0 6px' }}>
              Repository
            </div>
            {/* The repo picker. No sign-in/out item — Stage has no account or
                session (ADR-0022 §5); identity is the local `gh` user, shown
                read-only in Settings. `label` is "owner/repo" or the path
                basename, exactly what RepoMenu renders from `slug`. */}
            <RepoMenu
              slug={label}
              path={repoPath || null}
              onChangeRepo={onChangeRepo}
              onOpenSettings={onOpenSettings}
            />
          </div>

          {/* Main */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              padding: '14px 18px',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
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
                  className="input"
                  placeholder="Filter branches by name or path…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ paddingLeft: 28, width: '100%' }}
                />
              </div>
              <button
                type="button"
                className="btn"
                onClick={onOpenDashboard}
                title="Your reviews and the PRs awaiting your review"
              >
                <Icon name="doc-stack" size={12} color="var(--gray-700)" /> Dashboard
              </button>
              <button
                type="button"
                className="btn"
                onClick={onEnterStoryline}
                title="Compose a local storyline for the focused branch"
              >
                <Icon name="doc-stack" size={12} color="var(--gray-700)" /> Storyline
              </button>
              <FetchButton onFetch={onFetch} fetching={fetching} />
            </div>

            {error && <div style={errorBanner}>{error}</div>}

            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <RepoBranchList
                rows={rows}
                filter={filter}
                query={query}
                onSelfReview={onSelfReview}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const errorBanner: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--red-d)',
  background: 'rgba(255,59,48,0.08)',
  border: '1px solid rgba(255,59,48,0.20)',
  borderRadius: 'var(--r-sm)',
  padding: '6px 10px',
  marginBottom: 10,
};
