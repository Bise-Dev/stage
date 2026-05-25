import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useCallback, useEffect, useState } from 'react';
import {
  type GithubPrSearchItem,
  type RecentRepo,
  type RepoInfo,
  type User,
  authLogout,
  forgetRecentRepo,
  getActiveRepo,
  gitCurrentBranch,
  githubPrs,
  listRecentRepos,
  setActiveRepo,
} from '../../tauri';

type PrsState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: GithubPrSearchItem[] }
  | { kind: 'error'; detail: string };

function parseRepo(repositoryUrl: string): { owner: string; repo: string } {
  const m = repositoryUrl.match(/\/repos\/([^/]+)\/([^/]+)$/);
  return m ? { owner: m[1], repo: m[2] } : { owner: '?', repo: '?' };
}

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function relativeTime(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  const minutes = Math.round(ms / 60_000);
  if (Math.abs(minutes) < 60) return RTF.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RTF.format(hours, 'hour');
  const days = Math.round(hours / 24);
  return RTF.format(days, 'day');
}

export function WorkspaceScaffold({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [activeRepo, setActiveRepoState] = useState<RepoInfo | null>(null);
  const [recents, setRecents] = useState<RecentRepo[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [prs, setPrs] = useState<PrsState>({ kind: 'loading' });

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

  const doLogout = useCallback(async () => {
    try {
      await authLogout();
    } catch (e) {
      console.warn('authLogout failed; clearing local state anyway', e);
    }
    onLogout();
  }, [onLogout]);

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

  useEffect(() => {
    let cancelled = false;
    githubPrs('author')
      .then((items) => {
        if (!cancelled) setPrs({ kind: 'ready', items });
      })
      .catch((e) => {
        if (!cancelled) setPrs({ kind: 'error', detail: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main style={{ padding: '3rem 1.5rem 1.5rem', maxWidth: 720, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Stage</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: '#555' }}>@{user.github_login}</span>
          <button type="button" onClick={doLogout}>
            Logout
          </button>
        </div>
      </header>
      <p style={{ color: '#888', marginTop: '0.25rem' }}>
        Smoke scaffold. Pick a git repo and see your open GitHub PRs below.
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
        {error && <p style={{ color: '#b00020' }}>Error: {error}</p>}
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

      <section>
        <h2>My GitHub PRs (author)</h2>
        {prs.kind === 'loading' && <p>Loading…</p>}
        {prs.kind === 'error' && (
          <p style={{ color: '#b00020' }}>Failed to load PRs: {prs.detail}</p>
        )}
        {prs.kind === 'ready' && prs.items.length === 0 && <p>No open PRs found.</p>}
        {prs.kind === 'ready' && prs.items.length > 0 && (
          <ul>
            {prs.items.map((pr) => {
              const { owner, repo } = parseRepo(pr.repository_url);
              return (
                <li key={`${owner}/${repo}#${pr.number}`} style={{ marginBottom: 6 }}>
                  <button
                    type="button"
                    onClick={() => openUrl(pr.html_url)}
                    style={{ textAlign: 'left', cursor: 'pointer' }}
                  >
                    {owner}/{repo} #{pr.number} · {pr.title}
                  </button>
                  <div style={{ fontSize: 11, color: '#777' }}>
                    by @{pr.user.login} · updated {relativeTime(pr.updated_at)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
