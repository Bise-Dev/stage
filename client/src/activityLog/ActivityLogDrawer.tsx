import { listen } from '@tauri-apps/api/event';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type ActivityLogEntry,
  type ActivityLogLevel,
  type ActivityLogPill,
  activityLogClear,
  activityLogSnapshot,
} from '../tauri';
import { EVENT_NAME } from './constants';

const ALL_PILLS: ActivityLogPill[] = ['http', 'git', 'cmd', 'webview', 'rust'];

// Source-pill colours. Distinct hues so the eye can scan by source.
const PILL_COLOR: Record<ActivityLogPill, string> = {
  http: 'var(--blue)',
  git: 'var(--purple)',
  cmd: 'var(--green-d)',
  webview: 'var(--orange)',
  rust: 'var(--gray-500)',
};

const LEVEL_RANK: Record<ActivityLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

const LEVEL_COLOR: Record<ActivityLogLevel, string> = {
  trace: 'var(--gray-400)',
  debug: 'var(--gray-500)',
  info: 'var(--gray-700)',
  warn: 'var(--orange)',
  error: 'var(--red-d)',
};

function formatTime(tsMs: number): string {
  const d = new Date(tsMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

type Props = { onClose: () => void };

/**
 * The Activity-log drawer body. On mount it snapshots the Rust ring,
 * then tails `activity_log:event` for live rows (de-duped by monotonic id).
 * Filters: source pills, level (default INFO+, toggle DEBUG/TRACE), and a
 * substring search over message + field values. Copy-as-JSONL exports exactly
 * the filtered view (redaction is already applied in Rust).
 */
export function ActivityLogDrawer({ onClose }: Props) {
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [sources, setSources] = useState<Set<ActivityLogPill>>(new Set(ALL_PILLS));
  const [includeDebug, setIncludeDebug] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const lastIdRef = useRef<number>(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether to keep the view pinned to the newest row. Off once the user
  // scrolls up; back on when they return to the bottom.
  const followRef = useRef(true);

  // Snapshot the ring, then tail the live stream. We start listening before the
  // snapshot resolves and de-dup by id, so no row slips through the gap.
  useEffect(() => {
    let mounted = true;
    const append = (e: ActivityLogEntry) => {
      if (e.id <= lastIdRef.current) return;
      lastIdRef.current = e.id;
      setEntries((prev) => [...prev, e]);
    };
    const unlistenPromise = listen<ActivityLogEntry>(EVENT_NAME, (ev) => {
      if (mounted) append(ev.payload);
    });
    activityLogSnapshot()
      .then((snap) => {
        if (!mounted) return;
        setEntries((prev) => {
          // Merge: snapshot is the base; keep any live rows that already arrived.
          const maxSnap = snap.length ? snap[snap.length - 1].id : -1;
          lastIdRef.current = Math.max(lastIdRef.current, maxSnap);
          const tail = prev.filter((e) => e.id > maxSnap);
          return [...snap, ...tail];
        });
      })
      .catch((e) => {
        // Surface via the original-bound console (not forwarded back into the
        // ring infinitely — this is a one-shot snapshot failure).
        console.warn('activity_log_snapshot failed', e);
      });
    return () => {
      mounted = false;
      void unlistenPromise.then((un) => un());
    };
  }, []);

  const filtered = useMemo(() => {
    const minRank = includeDebug ? 0 : LEVEL_RANK.info;
    const needle = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (!sources.has(e.pill)) return false;
      if (LEVEL_RANK[e.level] < minRank) return false;
      if (needle) {
        const haystack = [e.message, e.target, e.error ?? '', ...Object.values(e.fields)]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [entries, sources, includeDebug, search]);

  // Pin to bottom while following.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on each new row
  useEffect(() => {
    if (followRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered.length]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const toggleSource = useCallback((pill: ActivityLogPill) => {
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(pill)) {
        next.delete(pill);
      } else {
        next.add(pill);
      }
      return next;
    });
  }, []);

  const onCopy = useCallback(async () => {
    const jsonl = filtered.map((e) => JSON.stringify(e)).join('\n');
    try {
      await navigator.clipboard.writeText(jsonl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      console.warn('activity_log copy failed', e);
    }
  }, [filtered]);

  const onClear = useCallback(async () => {
    try {
      await activityLogClear();
    } catch (e) {
      console.warn('activity_log_clear failed', e);
    }
    lastIdRef.current = -1;
    setEntries([]);
    setExpanded(null);
  }, []);

  return (
    <div style={S.root}>
      <div style={S.header}>
        <span style={S.title}>Activity log</span>
        <span style={S.count}>
          {filtered.length}
          {filtered.length !== entries.length ? ` / ${entries.length}` : ''}
        </span>
        <div style={S.pills}>
          {ALL_PILLS.map((pill) => {
            const on = sources.has(pill);
            return (
              <button
                type="button"
                key={pill}
                onClick={() => toggleSource(pill)}
                style={{
                  ...S.pillBtn,
                  color: on ? '#fff' : PILL_COLOR[pill],
                  background: on ? PILL_COLOR[pill] : 'transparent',
                  borderColor: PILL_COLOR[pill],
                  opacity: on ? 1 : 0.55,
                }}
              >
                {pill}
              </button>
            );
          })}
        </div>
        <label style={S.debugToggle}>
          <input
            type="checkbox"
            checked={includeDebug}
            onChange={(e) => setIncludeDebug(e.target.checked)}
          />
          DEBUG
        </label>
        <input
          type="search"
          placeholder="filter…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={S.search}
        />
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onCopy} style={S.actionBtn}>
          {copied ? 'Copied' : 'Copy as JSONL'}
        </button>
        <button type="button" onClick={onClear} style={S.actionBtn}>
          Clear
        </button>
        <button type="button" onClick={onClose} style={S.actionBtn} title="Close (⌘`)">
          ✕
        </button>
      </div>

      <div ref={scrollRef} onScroll={onScroll} style={S.body}>
        {filtered.length === 0 ? (
          <div style={S.empty}>No matching activity.</div>
        ) : (
          filtered.map((e) => {
            const isOpen = expanded === e.id;
            const hasDetail = Object.keys(e.fields).length > 0 || e.error;
            return (
              <div key={e.id} style={S.rowWrap}>
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: dev tool, mouse-only */}
                <div style={S.row} onClick={() => hasDetail && setExpanded(isOpen ? null : e.id)}>
                  <span style={S.time}>{formatTime(e.ts_ms)}</span>
                  <span style={{ ...S.level, color: LEVEL_COLOR[e.level] }}>{e.level}</span>
                  <span
                    style={{
                      ...S.rowPill,
                      color: PILL_COLOR[e.pill],
                      borderColor: PILL_COLOR[e.pill],
                    }}
                  >
                    {e.pill}
                  </span>
                  <span style={S.target} title={e.target}>
                    {e.target}
                  </span>
                  <span style={S.message}>{e.message}</span>
                  {e.duration_ms != null && <span style={S.duration}>{e.duration_ms}ms</span>}
                  {hasDetail && <span style={S.chev}>{isOpen ? '▾' : '▸'}</span>}
                </div>
                {isOpen && hasDetail && (
                  <div style={S.detail}>
                    {Object.entries(e.fields).map(([k, v]) => (
                      <div key={k} style={S.detailRow}>
                        <span style={S.detailKey}>{k}</span>
                        <span style={S.detailVal}>{v}</span>
                      </div>
                    ))}
                    {e.error && (
                      <div style={S.detailRow}>
                        <span style={{ ...S.detailKey, color: 'var(--red-d)' }}>error</span>
                        <span
                          style={{ ...S.detailVal, color: 'var(--red-d)', whiteSpace: 'pre-wrap' }}
                        >
                          {e.error}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// Inline styles keep this diagnostic surface self-contained (no styles.css churn).
const S: Record<string, CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--gray-50)',
    borderTop: '1px solid var(--divider)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11.5,
    color: 'var(--gray-800)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 10px',
    borderBottom: '1px solid var(--hairline)',
    background: 'var(--gray-100)',
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  title: { fontFamily: 'var(--font-ui)', fontWeight: 600, fontSize: 12 },
  count: { color: 'var(--gray-500)', fontSize: 11 },
  pills: { display: 'flex', gap: 4 },
  pillBtn: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    lineHeight: 1.4,
    padding: '1px 7px',
    borderRadius: 999,
    border: '1px solid',
    cursor: 'pointer',
  },
  debugToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    fontFamily: 'var(--font-ui)',
    fontSize: 11,
    color: 'var(--gray-600)',
    cursor: 'pointer',
  },
  search: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    padding: '2px 8px',
    border: '1px solid var(--gray-200)',
    borderRadius: 'var(--r-sm)',
    background: '#fff',
    width: 140,
  },
  actionBtn: {
    fontFamily: 'var(--font-ui)',
    fontSize: 11,
    padding: '2px 8px',
    border: '1px solid var(--gray-200)',
    borderRadius: 'var(--r-sm)',
    background: '#fff',
    cursor: 'pointer',
    color: 'var(--gray-700)',
  },
  body: { flex: 1, overflowY: 'auto', overflowX: 'hidden' },
  empty: { padding: 16, color: 'var(--gray-400)', fontFamily: 'var(--font-ui)' },
  rowWrap: { borderBottom: '1px solid var(--hairline-2)' },
  row: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    padding: '2px 10px',
    cursor: 'default',
    whiteSpace: 'nowrap',
  },
  time: { color: 'var(--gray-400)', flexShrink: 0 },
  level: { width: 38, flexShrink: 0, textTransform: 'uppercase', fontSize: 10 },
  rowPill: {
    flexShrink: 0,
    border: '1px solid',
    borderRadius: 999,
    padding: '0 6px',
    fontSize: 10,
  },
  target: {
    color: 'var(--gray-500)',
    flexShrink: 0,
    maxWidth: 220,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  message: { color: 'var(--gray-900)', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 },
  duration: { color: 'var(--blue)', flexShrink: 0 },
  chev: { color: 'var(--gray-400)', flexShrink: 0 },
  detail: { padding: '4px 10px 8px 56px', background: 'var(--gray-75)' },
  detailRow: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '1px 0' },
  detailKey: { color: 'var(--gray-500)', minWidth: 110, flexShrink: 0 },
  detailVal: { color: 'var(--gray-800)', wordBreak: 'break-all' },
};
