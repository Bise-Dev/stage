import { useCallback, useEffect, useState } from 'react';

import { Icon } from '../../components/Icon';
import { TitleBar } from '../../components/TitleBar';
import {
  type BranchInfo,
  type WorktreeInfo,
  getActiveRepo,
  gitLocalBranches,
  onRepoChanged,
  onWorktreesChanged,
  repoSummary,
  repoWorktrees,
  setFocusedWorktree,
} from '../../tauri';
import { RepoBranchList, buildRepoRows } from './RepoBranchList';

const SHOW_PATHS_KEY = 'repoHome:showPaths';

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

/**
 * The local-only landing after opening a repo (ADR-0016): the B2 branch list
 * with worktrees annotated. Self-Review on a worktree-backed branch focuses
 * that worktree then enters the Self-Review screen. Refreshes on repo / worktree
 * changes so an externally-created worktree (e.g. agent-deck) appears live.
 */
export function RepoHome({
  onEnterSelfReview,
  onChangeRepo,
}: {
  onEnterSelfReview: () => void;
  onChangeRepo: () => void;
}) {
  const [label, setLabel] = useState('…');
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showPaths, setShowPaths] = useState(
    () => localStorage.getItem(SHOW_PATHS_KEY) !== 'false',
  );

  const reload = useCallback(async () => {
    try {
      const [b, w] = await Promise.all([gitLocalBranches(), repoWorktrees()]);
      setBranches(b);
      setWorktrees(w);
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

  const toggleShowPaths = useCallback(() => {
    setShowPaths((cur) => {
      const next = !cur;
      localStorage.setItem(SHOW_PATHS_KEY, String(next));
      return next;
    });
  }, []);

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

  const rows = buildRepoRows(branches, worktrees, defaultBranch);

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title={`Stage — ${label}`} />
        <div
          style={{
            height: 56,
            flex: '0 0 56px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '0 16px',
            borderBottom: '1px solid var(--hairline)',
            background: '#fff',
          }}
        >
          <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
            {label}
          </span>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={toggleShowPaths}>
            <Icon name="eye" size={12} /> Paths: {showPaths ? 'shown' : 'hidden'}
          </button>
          <button type="button" className="btn" onClick={onChangeRepo}>
            Change repository
          </button>
        </div>

        {error && <div style={errorBanner}>{error}</div>}

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px' }}>
          <div className="section-label" style={{ padding: '0 6px 6px' }}>
            Branches
          </div>
          <RepoBranchList rows={rows} showPaths={showPaths} onSelfReview={onSelfReview} />
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
  margin: '8px 16px 0',
};
