import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import {
  type RecentRepo,
  type RepoSummary,
  listRecentRepos,
  repoSummary,
  setActiveRepo,
} from '../../tauri';
import { WizardRail } from './WizardRail';

type SummaryState = { kind: 'loading' } | { kind: 'ready'; summary: RepoSummary };

function basename(path: string) {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

function slugFromRemote(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/[:/]([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

interface Props {
  onOpened: () => void;
}

export function OpenRepository({ onOpened }: Props) {
  const [recents, setRecents] = useState<RecentRepo[]>([]);
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);

  const loadRecents = useCallback(async () => {
    const list = await listRecentRepos();
    setRecents(list);
    if (list.length > 0 && !selectedPath) {
      setSelectedPath(list[0].path);
    }
    for (const r of list) {
      setSummaries((s) => ({ ...s, [r.path]: { kind: 'loading' } }));
      repoSummary(r.path)
        .then((summary) => setSummaries((s) => ({ ...s, [r.path]: { kind: 'ready', summary } })))
        .catch(() => {
          setSummaries((s) => {
            const next = { ...s };
            delete next[r.path];
            return next;
          });
        });
    }
  }, [selectedPath]);

  useEffect(() => {
    loadRecents();
  }, [loadRecents]);

  const tryOpen = useCallback(
    async (path: string) => {
      setError(null);
      try {
        await setActiveRepo(path);
        onOpened();
      } catch (e) {
        setError(String(e));
      }
    },
    [onOpened],
  );

  useEffect(() => {
    const unlistenPromises = [
      listen('tauri://drag-enter', () => setDragOver(true)),
      listen('tauri://drag-over', () => setDragOver(true)),
      listen('tauri://drag-leave', () => setDragOver(false)),
      listen<{ paths: string[] }>('tauri://drag-drop', (e) => {
        setDragOver(false);
        const first = e.payload?.paths?.[0];
        if (first) tryOpen(first);
      }),
    ];
    return () => {
      for (const p of unlistenPromises) p.then((u) => u());
    };
  }, [tryOpen]);

  const pickFolder = useCallback(async () => {
    const path = await open({ directory: true, multiple: false });
    if (typeof path === 'string') await tryOpen(path);
  }, [tryOpen]);

  const onConfirm = useCallback(() => {
    if (selectedPath) tryOpen(selectedPath);
  }, [selectedPath, tryOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (recents.length === 0) return;
      const idx = recents.findIndex((r) => r.path === selectedPath);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = recents[Math.min(idx + 1, recents.length - 1)];
        if (next) setSelectedPath(next.path);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const next = recents[Math.max(idx - 1, 0)];
        if (next) setSelectedPath(next.path);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recents, selectedPath, onConfirm]);

  const selectedName = useMemo(() => {
    if (!selectedPath) return null;
    const sum = summaries[selectedPath];
    const slug = sum?.kind === 'ready' ? slugFromRemote(sum.summary.remoteUrl) : null;
    return slug ?? basename(selectedPath);
  }, [selectedPath, summaries]);

  return (
    <div
      className="flex h-full w-full overflow-hidden"
      style={{ background: 'linear-gradient(180deg, #fbfaf8 0%, #f0eee9 100%)' }}
    >
      <WizardRail active="openRepo" />

      <div className="flex flex-col flex-1 overflow-hidden" style={{ padding: '28px 36px' }}>
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: 'var(--gray-900)',
            letterSpacing: '-0.02em',
          }}
        >
          Open a local repository
        </div>
        <div
          style={{
            fontSize: 13,
            color: 'var(--gray-500)',
            marginTop: 4,
            marginBottom: 18,
            lineHeight: 1.5,
          }}
        >
          Choose the codebase Stage should track. You can add more later.
        </div>

        <div
          ref={dropZoneRef}
          className="flex items-center"
          style={{
            border: dragOver ? '2px solid var(--blue)' : '2px dashed rgba(0,122,255,0.35)',
            background: dragOver ? 'rgba(0,122,255,0.10)' : 'rgba(0,122,255,0.04)',
            borderRadius: 'var(--r-lg)',
            padding: '22px 24px',
            gap: 18,
            marginBottom: error ? 8 : 22,
            transition: 'background 80ms ease, border-color 80ms ease',
          }}
        >
          <div
            className="flex items-center justify-center"
            style={{
              width: 56,
              height: 56,
              borderRadius: 12,
              background: '#fff',
              border: '1px solid rgba(0,122,255,0.25)',
              flex: '0 0 56px',
            }}
          >
            <Icon name="folder" size={24} color="var(--blue)" />
          </div>
          <div className="flex-1">
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gray-900)' }}>
              Drop a folder here
            </div>
            <div style={{ fontSize: 12, color: 'var(--gray-600)', marginTop: 2 }}>
              Any local git repository works. Stage reads from <span className="mono">.git</span> —
              it doesn't modify your working tree.
            </div>
          </div>
          <button
            type="button"
            onClick={pickFolder}
            className="cursor-default"
            style={{
              height: 30,
              padding: '0 14px',
              borderRadius: 'var(--r-sm)',
              background: 'var(--blue)',
              border: '1px solid rgba(0,0,0,0.10)',
              color: '#fff',
              boxShadow: '0 1px 0 rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.25)',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
            }}
          >
            Choose folder…
          </button>
        </div>

        {error && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--red-d)',
              marginBottom: 14,
              padding: '6px 10px',
              background: 'rgba(255,59,48,0.08)',
              border: '1px solid rgba(255,59,48,0.20)',
              borderRadius: 'var(--r-sm)',
            }}
          >
            {error}
          </div>
        )}

        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.08em',
              color: 'var(--gray-500)',
              textTransform: 'uppercase',
            }}
          >
            {recents.length === 0 ? 'No recent repositories' : `Recent · ${recents.length}`}
          </span>
        </div>

        <div className="flex flex-col flex-1 overflow-auto" style={{ gap: 6 }}>
          {recents.length === 0 ? (
            <div
              className="flex items-center justify-center text-center"
              style={{
                flex: 1,
                fontSize: 12.5,
                color: 'var(--gray-500)',
                padding: '24px 12px',
                border: '1px dashed var(--hairline)',
                borderRadius: 'var(--r-md)',
                background: 'rgba(255,255,255,0.4)',
                lineHeight: 1.5,
              }}
            >
              Drop a folder above or choose one to get started.
              <br />
              Repos you open will appear here next time.
            </div>
          ) : (
            recents.map((r) => (
              <RepoRow
                key={r.path}
                path={r.path}
                summary={summaries[r.path]}
                selected={r.path === selectedPath}
                onSelect={() => setSelectedPath(r.path)}
                onActivate={() => tryOpen(r.path)}
              />
            ))
          )}
        </div>

        <div
          className="flex items-center"
          style={{
            gap: 10,
            marginTop: 14,
            paddingTop: 14,
            borderTop: '1px solid var(--hairline)',
          }}
        >
          <div className="flex-1" />
          <button
            type="button"
            onClick={onConfirm}
            disabled={!selectedPath}
            className="flex items-center gap-1.5 cursor-default disabled:opacity-50"
            style={{
              height: 30,
              padding: '0 14px',
              borderRadius: 'var(--r-sm)',
              background: 'var(--blue)',
              border: '1px solid rgba(0,0,0,0.10)',
              color: '#fff',
              boxShadow: '0 1px 0 rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.25)',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
            }}
          >
            Open {selectedName && <strong style={{ marginLeft: 4 }}>{selectedName}</strong>}
            <Icon name="chevron-right" size={11} color="#fff" />
          </button>
        </div>
      </div>
    </div>
  );
}

function RepoRow({
  path,
  summary,
  selected,
  onSelect,
  onActivate,
}: {
  path: string;
  summary: SummaryState | undefined;
  selected: boolean;
  onSelect: () => void;
  onActivate: () => void;
}) {
  const ready = summary?.kind === 'ready' ? summary.summary : null;
  const slug = ready ? slugFromRemote(ready.remoteUrl) : null;
  const name = basename(path);
  const branchesLabel =
    summary?.kind === 'loading'
      ? '…'
      : ready
        ? `${ready.branchesCount} ${ready.branchesCount === 1 ? 'branch' : 'branches'}`
        : '—';
  const defaultBranchLabel = summary?.kind === 'loading' ? '…' : (ready?.defaultBranch ?? '—');

  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onActivate}
      className="flex items-center text-left w-full cursor-default"
      style={{
        gap: 12,
        padding: '10px 14px',
        background: '#fff',
        border: `1px solid ${selected ? 'rgba(0,122,255,0.5)' : 'var(--hairline)'}`,
        borderRadius: 'var(--r-md)',
        boxShadow: selected ? '0 0 0 3px var(--blue-tint)' : 'var(--sh-1)',
        fontFamily: 'inherit',
      }}
    >
      <span
        className="relative inline-block"
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          flex: '0 0 16px',
          border: `1.5px solid ${selected ? 'var(--blue)' : 'rgba(0,0,0,0.25)'}`,
        }}
      >
        {selected && (
          <span
            className="absolute"
            style={{
              inset: 3,
              borderRadius: 5,
              background: 'var(--blue)',
            }}
          />
        )}
      </span>
      <Icon name="folder" size={14} color="var(--gray-600)" />
      <span className="flex-1 min-w-0">
        <span className="flex items-center" style={{ gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-900)' }}>{name}</span>
          {slug ? (
            <span
              className="inline-flex items-center"
              style={{
                gap: 3,
                height: 18,
                padding: '0 6px',
                borderRadius: 9,
                fontSize: 11,
                fontWeight: 600,
                background: 'rgba(0,0,0,0.06)',
                color: 'var(--gray-700)',
              }}
            >
              <Icon name="gh" size={9} color="var(--gray-700)" />
              {slug}
            </span>
          ) : ready ? (
            <span
              className="inline-flex items-center"
              style={{
                height: 18,
                padding: '0 6px',
                borderRadius: 9,
                fontSize: 11,
                fontWeight: 600,
                background: 'rgba(255,149,0,0.14)',
                color: '#b56500',
              }}
            >
              no remote
            </span>
          ) : null}
          <span
            className="mono inline-flex items-center"
            style={{
              height: 18,
              padding: '0 6px',
              borderRadius: 9,
              fontSize: 11,
              fontWeight: 600,
              background: 'rgba(0,0,0,0.05)',
              color: 'var(--gray-600)',
            }}
          >
            {defaultBranchLabel}
          </span>
        </span>
        <span
          className="mono block"
          style={{ fontSize: 11, color: 'var(--gray-500)', marginTop: 2 }}
        >
          {path}
        </span>
      </span>
      <span className="text-right" style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
        <span className="block">{branchesLabel}</span>
      </span>
    </button>
  );
}
