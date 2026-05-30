import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';
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

  // Reload persisted scope when the repo changes underneath us.
  useEffect(() => {
    setScopeState(loadScope(repoPath));
  }, [repoPath]);

  const setScope = useCallback(
    (s: SelfReviewScope) => {
      saveScope(repoPath, s);
      setScopeState(s);
    },
    [repoPath],
  );

  const fetchDiff = useCallback(async () => {
    try {
      const next = await selfReviewDiff(scope, scope === 'base' ? baseRef : null);
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

  // Initial + scope/base changes.
  useEffect(() => {
    setLoading(true);
    fetchDiff();
  }, [fetchDiff]);

  // Live refresh via the global watcher.
  useEffect(() => {
    const unlisten = listen('repo-changed', () => fetchDiff());
    return () => {
      unlisten.then((u) => u());
    };
  }, [fetchDiff]);

  return { diff, scope, setScope, loading, error };
}
