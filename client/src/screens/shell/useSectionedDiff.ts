import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type CommittedDiff,
  type SelfReviewDiff,
  selfReviewDiff,
  storylineDiff,
} from '../../tauri';

const INCLUDE_KEY_PREFIX = 'shell:includeUncommitted:';

function loadInclude(repoPath: string | null): boolean {
  if (!repoPath) return false;
  return localStorage.getItem(`${INCLUDE_KEY_PREFIX}${repoPath}`) === 'true';
}

export type SectionedDiff = {
  /** The committed section: `merge_base(base, HEAD) → HEAD`, tree-to-tree —
   *  the default scope (flag F4; CONTEXT.md "Self-Review"). Null until the
   *  first fetch resolves. */
  committed: CommittedDiff | null;
  /** The uncommitted section: `HEAD → index → workdir + untracked`. Always
   *  fetched (it also names the current branch and feeds the toggle badge);
   *  rendered as a separate section only when `includeUncommitted` is on. */
  workdir: SelfReviewDiff | null;
  includeUncommitted: boolean;
  setIncludeUncommitted: (on: boolean) => void;
  /** Workdir-diff file count, for the "+ Uncommitted" badge and the
   *  committed-only warning banner. `null` until first resolved. */
  uncommittedCount: number | null;
  loading: boolean;
  error: string | null;
};

/**
 * The shell's two-section diff (flag F4, replacing the old `workdir | base`
 * either/or): the committed diff is the reviewable unit, and the working tree
 * folds in as a *separate* section rather than being silently merged into the
 * base diff. Both sections refresh on the global watcher events, mirroring
 * `useSelfReviewDiff`'s subscribe-once pattern.
 *
 * Per CLAUDE.md "Error handling": no silent fallbacks — a backend failure
 * leaves the failed section unchanged and `error` populated for the banner.
 */
export function useSectionedDiff(
  repoPath: string | null,
  baseRef: string | null,
  options?: {
    /** Debrief mode: the working-tree section defaults ON (the Debrief
     *  describes the branch as the agent left it, committed + uncommitted)
     *  and the choice is per-open, never persisted. */
    ephemeralDefaultOn?: boolean;
  },
): SectionedDiff {
  const ephemeral = options?.ephemeralDefaultOn === true;
  const [committed, setCommitted] = useState<CommittedDiff | null>(null);
  const [workdir, setWorkdir] = useState<SelfReviewDiff | null>(null);
  const [includeUncommitted, setIncludeState] = useState(() =>
    ephemeral ? true : loadInclude(repoPath),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ephemeral) setIncludeState(loadInclude(repoPath));
  }, [repoPath, ephemeral]);

  const setIncludeUncommitted = useCallback(
    (on: boolean) => {
      if (!ephemeral && repoPath) {
        localStorage.setItem(`${INCLUDE_KEY_PREFIX}${repoPath}`, String(on));
      }
      setIncludeState(on);
    },
    [repoPath, ephemeral],
  );

  const fetchBoth = useCallback(async () => {
    if (!repoPath || !baseRef) {
      setLoading(true);
      return;
    }
    try {
      // The workdir diff also names the current branch — the committed diff's
      // head ref — so the two fetches are sequential by necessity.
      const wd = await selfReviewDiff('workdir', null);
      setWorkdir(wd);
      const cd = await storylineDiff(baseRef, wd.currentBranch);
      setCommitted(cd);
      setError(null);
    } catch (e) {
      console.warn('shell_sectioned_diff_failed', e);
      const msg =
        typeof e === 'object' && e !== null && 'message' in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(msg);
      // Keep the previous sections visible — a transient git lock shouldn't
      // blank the screen mid-review.
    } finally {
      setLoading(false);
    }
  }, [repoPath, baseRef]);

  useEffect(() => {
    setLoading(true);
    void fetchBoth();
  }, [fetchBoth]);

  // Subscribe once; call the latest fetch through a ref (see
  // useSelfReviewDiff's stale-listener note for why).
  const fetchRef = useRef(fetchBoth);
  fetchRef.current = fetchBoth;
  useEffect(() => {
    const refresh = () => {
      void fetchRef.current();
    };
    const unlisten = [listen('repo-changed', refresh), listen('worktrees-changed', refresh)];
    return () => {
      for (const u of unlisten) u.then((f) => f());
    };
  }, []);

  return {
    committed,
    workdir,
    includeUncommitted,
    setIncludeUncommitted,
    uncommittedCount: workdir ? workdir.files.length : null,
    loading,
    error,
  };
}
