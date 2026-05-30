import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type SelfReviewDiff, type SelfReviewScope, selfReviewDiff } from '../../tauri';

const SCOPE_KEY_PREFIX = 'selfReview:scope:';

function loadScope(repoPath: string | null): SelfReviewScope {
  if (!repoPath) return 'workdir';
  const v = localStorage.getItem(`${SCOPE_KEY_PREFIX}${repoPath}`);
  return v === 'base' ? 'base' : 'workdir';
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
};

/**
 * Owns the Self-Review diff and the scope toggle. Refetches on every
 * `repo-changed` event (the global watcher fires on .git/, working tree,
 * untracked dirs) and whenever the scope or `baseRef` changes.
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
    try {
      const next = await selfReviewDiff(scope, scope === 'base' ? baseRef : null);
      cacheRef.current.set(`${scope}:${scope === 'base' ? (baseRef ?? '') : ''}`, next);
      setDiff(next);
      setError(null);
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

  // Initial + scope/base changes. We only show the spinner if we have nothing
  // cached for the new scope — otherwise the optimistic swap above already
  // populated `diff` and the user shouldn't see a loading state.
  useEffect(() => {
    const cached = cacheRef.current.get(`${scope}:${scope === 'base' ? (baseRef ?? '') : ''}`);
    if (!cached) setLoading(true);
    fetchDiff();
  }, [fetchDiff, scope, baseRef]);

  // Live refresh via the global watcher. A file change invalidates the cache
  // for every scope — both modes' diffs are affected by a working-tree edit.
  useEffect(() => {
    const unlisten = listen('repo-changed', () => {
      cacheRef.current.clear();
      fetchDiff();
    });
    return () => {
      unlisten.then((u) => u());
    };
  }, [fetchDiff]);

  return { diff, scope, setScope, loading, error };
}
