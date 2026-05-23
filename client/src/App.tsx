import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useState } from 'react';
import {
  type RecentRepo,
  type RepoInfo,
  forgetRecentRepo,
  getActiveRepo,
  gitCurrentBranch,
  listRecentRepos,
  setActiveRepo,
} from './tauri';

export function App() {
  const [activeRepo, setActiveRepoState] = useState<RepoInfo | null>(null);
  const [recents, setRecents] = useState<RecentRepo[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);

  const refreshRecents = useCallback(async () => {
    setRecents(await listRecentRepos());
  }, []);

  const refreshBranch = useCallback(async () => {
    try {
      setBranch(await gitCurrentBranch());
      setError(null);
    } catch (e) {
      setError(String(e));
      setBranch(null);
    }
  }, []);

  const selectRepo = useCallback(
    async (path: string) => {
      try {
        const info = await setActiveRepo(path);
        setActiveRepoState(info);
        setError(null);
        await refreshRecents();
        await refreshBranch();
      } catch (e) {
        setError(String(e));
      }
    },
    [refreshRecents, refreshBranch],
  );

  const pickFolder = useCallback(async () => {
    const path = await open({ directory: true, multiple: false });
    if (typeof path === 'string') await selectRepo(path);
  }, [selectRepo]);

  const forget = useCallback(
    async (path: string) => {
      await forgetRecentRepo(path);
      await refreshRecents();
    },
    [refreshRecents],
  );

  useEffect(() => {
    (async () => {
      setActiveRepoState(await getActiveRepo());
      await refreshRecents();
    })();
  }, [refreshRecents]);

  useEffect(() => {
    const unlistenPromise = listen('repo-changed', () => {
      const ts = new Date().toLocaleTimeString();
      setEvents((prev) => [`${ts} repo-changed`, ...prev].slice(0, 20));
      refreshBranch();
    });
    return () => {
      unlistenPromise.then((u) => u());
    };
  }, [refreshBranch]);

  useEffect(() => {
    if (activeRepo) refreshBranch();
  }, [activeRepo, refreshBranch]);

  return (
    <main className="app">
      <h1>Stage</h1>
      <p style={{ color: '#888', marginTop: '-0.5rem' }}>
        Smoke scaffold. Pick a git repo to verify picker → libgit2 → watcher wiring.
      </p>

      <section>
        {activeRepo ? (
          <>
            <p>
              Active repo: <code>{activeRepo.path}</code>
            </p>
            <p>Branch: {branch ?? '...'}</p>
          </>
        ) : (
          <p>No repo selected.</p>
        )}
        {error && <p className="error">Error: {error}</p>}
        <button type="button" onClick={pickFolder}>
          Pick repo...
        </button>
      </section>

      <section>
        <h2>Recent</h2>
        {recents.length === 0 ? (
          <p>No recents.</p>
        ) : (
          <ul>
            {recents.map((r) => (
              <li key={r.path}>
                <button type="button" onClick={() => selectRepo(r.path)}>
                  {r.path}
                </button>
                <button type="button" onClick={() => forget(r.path)}>
                  forget
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Watcher events</h2>
        {events.length === 0 ? (
          <p>(none yet — try touching a file in the repo)</p>
        ) : (
          <ul>
            {events.map((e) => (
              <li key={e}>
                <code>{e}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
