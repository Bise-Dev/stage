import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type SelfReviewFileChange,
  type SelfReviewStats,
  selfReviewDiff,
  storylineDiff,
} from '../../tauri';

const INCLUDE_KEY_PREFIX = 'shell:includeUncommitted:';

function loadInclude(repoPath: string | null): boolean {
  if (!repoPath) return false;
  return localStorage.getItem(`${INCLUDE_KEY_PREFIX}${repoPath}`) === 'true';
}

/** The one reviewable diff, whichever scope produced it: **one entry per file**
 *  (ADR-0030). Shape-compatible with both backend diffs so the screen below
 *  never branches on which one it got. */
export type ReviewDiff = {
  /** The ref the diff was actually computed against, after the remote-tracking
   *  preference in `resolve_base_commit` (e.g. `origin/main` for `main`). */
  baseRef: string;
  headSha: string;
  files: SelfReviewFileChange[];
  stats: SelfReviewStats;
};

export type ReviewDiffState = {
  /** Null until the first fetch resolves. */
  diff: ReviewDiff | null;
  /** The checked-out branch, from the working-tree diff. */
  currentBranch: string | null;
  /** Whether the working tree is folded into `diff` (the scope switch). */
  includeUncommitted: boolean;
  setIncludeUncommitted: (on: boolean) => void;
  /** Workdir-diff file count, for the "+ Uncommitted" badge and the
   *  committed-only warning banner. `null` until first resolved. */
  uncommittedCount: number | null;
  loading: boolean;
  error: string | null;
};

/**
 * The shell's Self-Review diff, as a **scope switch** rather than two stacked
 * sections (ADR-0030). "+ Uncommitted" off means the committed diff —
 * `merge_base(base, HEAD) → HEAD`, tree-to-tree, exactly what the PR will
 * contain. On means the Base-scope diff — `merge_base(base, HEAD) → working
 * tree` — where a file the author both committed to *and* has edited since
 * shows up once, with its committed and uncommitted hunks in one patch.
 *
 * Both refresh on the global watcher events, mirroring the subscribe-once
 * pattern used elsewhere in the shell.
 *
 * Per CLAUDE.md "Error handling": no silent fallbacks — a backend failure
 * leaves the last good diff on screen and populates `error` for the banner.
 */
export function useReviewDiff(repoPath: string | null, baseRef: string | null): ReviewDiffState {
  const [diff, setDiff] = useState<ReviewDiff | null>(null);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [uncommittedCount, setUncommittedCount] = useState<number | null>(null);
  const [includeUncommitted, setIncludeState] = useState(() => loadInclude(repoPath));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIncludeState(loadInclude(repoPath));
  }, [repoPath]);

  const setIncludeUncommitted = useCallback(
    (on: boolean) => {
      if (repoPath) localStorage.setItem(`${INCLUDE_KEY_PREFIX}${repoPath}`, String(on));
      setIncludeState(on);
    },
    [repoPath],
  );

  const fetchDiff = useCallback(async () => {
    if (!repoPath || !baseRef) {
      setLoading(true);
      return;
    }
    try {
      // The working-tree diff names the current branch (the committed diff's
      // head ref) and feeds the toggle's badge, so it is fetched in both
      // scopes; the second fetch depends on it.
      const wd = await selfReviewDiff('workdir', null);
      setCurrentBranch(wd.currentBranch);
      setUncommittedCount(wd.files.length);
      if (includeUncommitted) {
        const merged = await selfReviewDiff('base', baseRef);
        setDiff({
          // Base scope always reports the ref it resolved to; the fallback
          // never fires, it just keeps the type honest.
          baseRef: merged.baseRef ?? baseRef,
          headSha: merged.headSha,
          files: merged.files,
          stats: merged.stats,
        });
      } else {
        const committed = await storylineDiff(baseRef, wd.currentBranch);
        setDiff({
          baseRef: committed.baseRef,
          headSha: committed.headSha,
          files: committed.files,
          stats: committed.stats,
        });
      }
      setError(null);
    } catch (e) {
      console.warn('shell_review_diff_failed', e);
      const msg =
        typeof e === 'object' && e !== null && 'message' in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(msg);
      // Keep the previous diff visible — a transient git lock shouldn't blank
      // the screen mid-review.
    } finally {
      setLoading(false);
    }
  }, [repoPath, baseRef, includeUncommitted]);

  useEffect(() => {
    setLoading(true);
    void fetchDiff();
  }, [fetchDiff]);

  // Subscribe once; call the latest fetch through a ref (a listener registered
  // with the fetch inline would capture the first closure and go stale).
  const fetchRef = useRef(fetchDiff);
  fetchRef.current = fetchDiff;
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
    diff,
    currentBranch,
    includeUncommitted,
    setIncludeUncommitted,
    uncommittedCount,
    loading,
    error,
  };
}
