import { useCallback, useEffect, useState } from 'react';
import {
  type BaseOptions,
  type BranchInfo,
  getActiveRepo,
  gitFetch,
  gitLocalBranches,
  repoSummary,
  selfReviewBaseOptions,
} from '../../tauri';

const BASE_KEY_PREFIX = 'selfReview:base:';

export type ShellBootstrap = {
  repoPath: string | null;
  defaultBranch: string | null;
  /** The author-chosen base ref (persisted per repo); null until resolved. */
  baseRef: string | null;
  setBaseRef: (b: string) => void;
  /** Non-persisting override (the `stage open` seed path, ADR-0014). */
  seedBaseRef: (b: string) => void;
  branches: BranchInfo[];
  baseOptions: BaseOptions | null;
  fetching: boolean;
  refreshBase: () => Promise<void>;
  error: string | null;
};

/**
 * The review shell's shared bootstrap: active repo, default branch, the
 * author-chosen base (persisted per repo, recommended ref as the default),
 * local branches for the base picker, and the fetch/refresh action. Shared by
 * every shell mode (extracted from the pre-shell SelfReview screen).
 *
 * Fail loud per CLAUDE.md: no fallback to "main" — a bootstrap failure
 * surfaces in `error` for the shell's banner.
 */
export function useShellBootstrap(): ShellBootstrap {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [baseRef, setBaseRefState] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [baseOptions, setBaseOptions] = useState<BaseOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await getActiveRepo();
        if (!r) {
          setError('No active repository — pick one from the Home screen.');
          return;
        }
        setRepoPath(r.path);
        const sum = await repoSummary(r.path);
        setDefaultBranch(sum.defaultBranch);
        const opts = await selfReviewBaseOptions();
        setBaseOptions(opts);
        // Resolve the base: a previously-picked branch wins, else the
        // recommended ref (the remote default when fetched — ADR-0016 — so a
        // stale local default in a worktree doesn't skew the diff).
        const persisted = localStorage.getItem(`${BASE_KEY_PREFIX}${r.path}`);
        setBaseRefState(persisted ?? opts.recommended);
        setBranches(await gitLocalBranches());
      } catch (e) {
        console.warn('shell_bootstrap_failed', e);
        setError(String(e));
      }
    })();
  }, []);

  const setBaseRef = useCallback(
    (b: string) => {
      if (repoPath) localStorage.setItem(`${BASE_KEY_PREFIX}${repoPath}`, b);
      setBaseRefState(b);
    },
    [repoPath],
  );

  const seedBaseRef = useCallback((b: string) => setBaseRefState(b), []);

  // Refresh the remote-tracking refs so the base diff reflects the current
  // remote default; after the fetch, re-read the base options (behind-count +
  // last-fetch time). The diff hooks refresh via the repo watcher.
  const [fetching, setFetching] = useState(false);
  const refreshBase = useCallback(async () => {
    setFetching(true);
    try {
      await gitFetch();
      setBaseOptions(await selfReviewBaseOptions());
    } catch (e) {
      console.warn('shell_fetch_failed', e);
      setError(String(e));
    } finally {
      setFetching(false);
    }
  }, []);

  return {
    repoPath,
    defaultBranch,
    baseRef,
    setBaseRef,
    seedBaseRef,
    branches,
    baseOptions,
    fetching,
    refreshBase,
    error,
  };
}
