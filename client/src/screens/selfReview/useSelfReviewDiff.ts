import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type SelfReviewDiff, type SelfReviewScope, selfReviewDiff } from '../../tauri';

const SCOPE_KEY_PREFIX = 'selfReview:scope:';

// Default to the Base view: a Self-Review is opened to review the whole change
// (committed branch work, which `base` includes), so an all-committed branch —
// the normal state at an agent handoff — shows its diff on open instead of an
// empty "Uncommitted" view. An explicit `workdir` pick still persists.
function loadScope(repoPath: string | null): SelfReviewScope {
  if (!repoPath) return 'base';
  const v = localStorage.getItem(`${SCOPE_KEY_PREFIX}${repoPath}`);
  return v === 'workdir' ? 'workdir' : 'base';
}

function saveScope(repoPath: string | null, scope: SelfReviewScope) {
  if (!repoPath) return;
  localStorage.setItem(`${SCOPE_KEY_PREFIX}${repoPath}`, scope);
}

export type UseSelfReviewDiff = {
  diff: SelfReviewDiff | null;
  scope: SelfReviewScope;
  setScope: (s: SelfReviewScope) => void;
  loading: boolean;
  error: string | null;
  /** File count of the uncommitted (workdir-scope) diff, for the toggle badge.
   *  `null` until first resolved. */
  uncommittedCount: number | null;
};

/**
 * Owns the Self-Review diff and the scope toggle. Refetches on every
 * `repo-changed` event (the global watcher fires on .git/, working tree,
 * untracked dirs) and on `worktrees-changed` (fired by common-dir activity
 * such as a `git fetch` in a linked worktree updating `origin/*`) and
 * whenever the scope or `baseRef` changes.
 *
 * To make scope toggling feel instant we keep an in-memory cache keyed by
 * `(scope, baseRef)` — flipping back to a previously-seen scope swaps the
 * cached payload in synchronously while the background refetch runs to pick
 * up any drift. The cache is dropped on every `repo-changed` event so it
 * never gets stale relative to the working tree.
 *
 * Per CLAUDE.md "Error handling": no silent fallbacks — a backend failure
 * leaves `diff` null and `error` populated, and the screen shows a red banner.
 */
export function useSelfReviewDiff(
  repoPath: string | null,
  baseRef: string | null,
): UseSelfReviewDiff {
  const [scope, setScopeState] = useState<SelfReviewScope>(() => loadScope(repoPath));
  const [diff, setDiff] = useState<SelfReviewDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Cache keyed by `${scope}:${baseRef ?? ''}`. Holds the most recent payload
  // for each (scope, base) we've fetched in this session.
  const cacheRef = useRef<Map<string, SelfReviewDiff>>(new Map());
  // File count of the uncommitted (workdir-scope) diff, surfaced on the
  // "Uncommitted" toggle regardless of the active scope. `null` = not yet known.
  const [uncommittedCount, setUncommittedCount] = useState<number | null>(null);

  // Reload persisted scope when the repo changes underneath us, and drop the
  // cache — different repo means different diffs.
  useEffect(() => {
    setScopeState(loadScope(repoPath));
    cacheRef.current.clear();
  }, [repoPath]);

  const setScope = useCallback(
    (s: SelfReviewScope) => {
      saveScope(repoPath, s);
      // Optimistic swap: if we have a cached payload for the target scope,
      // show it instantly and let the background refetch reconcile.
      const cached = cacheRef.current.get(`${s}:${s === 'base' ? (baseRef ?? '') : ''}`);
      if (cached) {
        setDiff(cached);
        setError(null);
      }
      setScopeState(s);
    },
    [repoPath, baseRef],
  );

  const fetchDiff = useCallback(async () => {
    // Don't fire a `base`-scope fetch until we know which base. `baseRef`
    // is resolved asynchronously from repoSummary() on mount; with a
    // persisted `base` preference in localStorage, this effect would
    // otherwise race the resolution and Rust would (correctly) refuse with
    // "base_ref required in base scope but was not provided".
    if (scope === 'base' && !baseRef) {
      setLoading(true);
      return;
    }
    // Dev-only timing for the invoke→setDiff round-trip. `console.*` is
    // forwarded into the Activity-log ring in dev (activityLog/console.ts), so
    // this surfaces in the drawer without ad-hoc logging. Gated on DEV — no
    // instrumentation ships to production (see plan Phase 1b).
    const startedAt = import.meta.env.DEV ? performance.now() : 0;
    try {
      const next = await selfReviewDiff(scope, scope === 'base' ? baseRef : null);
      cacheRef.current.set(`${scope}:${scope === 'base' ? (baseRef ?? '') : ''}`, next);
      setDiff(next);
      setError(null);
      if (import.meta.env.DEV) {
        console.debug('self_review_diff_timing', {
          scope,
          files: next.files.length,
          ms: Math.round(performance.now() - startedAt),
        });
      }
    } catch (e) {
      console.warn('self_review_diff_failed', e);
      const msg =
        typeof e === 'object' && e !== null && 'message' in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(msg);
      // Keep the previous diff visible — clearing on error would make the
      // screen flicker between empty + populated on every transient git lock.
    } finally {
      setLoading(false);
    }
  }, [scope, baseRef]);

  // The uncommitted file count for the "Uncommitted" toggle. When that scope is
  // active the main `diff` already IS the workdir diff, so the count is derived
  // from it (effect below) and this fetch is skipped; otherwise fetch a workdir
  // diff just for its file count. Reuses `selfReviewDiff`; a clean tree = 0 files.
  const fetchUncommittedCount = useCallback(async () => {
    if (!repoPath || scope === 'workdir') return;
    try {
      const wd = await selfReviewDiff('workdir', null);
      setUncommittedCount(wd.files.length);
    } catch (e) {
      console.warn('uncommitted_count_failed', e);
      // Keep the last known count; a transient git lock shouldn't blank the badge.
    }
  }, [repoPath, scope]);

  // When viewing Uncommitted, the loaded diff IS the uncommitted set — derive the
  // count from it directly (no second git call).
  useEffect(() => {
    if (scope === 'workdir' && diff) setUncommittedCount(diff.files.length);
  }, [scope, diff]);

  // Initial + on repo/scope change (in base scope): keep the count fresh.
  useEffect(() => {
    void fetchUncommittedCount();
  }, [fetchUncommittedCount]);

  // Initial + scope/base changes. We only show the spinner if we have nothing
  // cached for the new scope — otherwise the optimistic swap above already
  // populated `diff` and the user shouldn't see a loading state.
  useEffect(() => {
    const cached = cacheRef.current.get(`${scope}:${scope === 'base' ? (baseRef ?? '') : ''}`);
    if (!cached) setLoading(true);
    fetchDiff();
  }, [fetchDiff, scope, baseRef]);

  // Live refresh via the global watchers. A working-tree change (`repo-changed`)
  // or common-dir activity (`worktrees-changed`, e.g. a `git fetch` updating
  // `origin/*`) invalidates the cache for every scope and refetches — so the
  // base diff redraws against a freshened remote default even in a linked
  // worktree, whose fetch fires `worktrees-changed` rather than `repo-changed`.
  //
  // Subscribe ONCE and call the latest `fetchDiff` through a ref. Re-subscribing
  // on every `fetchDiff` identity change (it changes with `scope`/`baseRef`) and
  // re-registering via the async `listen()` leaked handlers whose captured
  // `scope` was stale: on a `worktrees-changed` burst the stale `workdir`-scope
  // listeners refetched 0 files (clean tree) while the live `base`-scope one
  // refetched the real diff, and the two raced — flickering the diff to empty.
  const fetchDiffRef = useRef(fetchDiff);
  fetchDiffRef.current = fetchDiff;
  const fetchCountRef = useRef(fetchUncommittedCount);
  fetchCountRef.current = fetchUncommittedCount;
  useEffect(() => {
    const refresh = () => {
      cacheRef.current.clear();
      void fetchDiffRef.current();
      void fetchCountRef.current();
    };
    const unlisten = [listen('repo-changed', refresh), listen('worktrees-changed', refresh)];
    return () => {
      for (const u of unlisten) u.then((f) => f());
    };
  }, []);

  return { diff, scope, setScope, loading, error, uncommittedCount };
}
