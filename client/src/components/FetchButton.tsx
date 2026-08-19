import { useEffect, useRef, useState } from 'react';

import { syncSetAutoFetch } from '../tauri';
import { Icon } from './Icon';

// Auto-fetch interval options for the Overview's Fetch button. `seconds: 0`
// means "off" (manual fetch only).
const AUTO_FETCH_OPTIONS: { label: string; seconds: number }[] = [
  { label: 'Off', seconds: 0 },
  { label: 'Every 10s', seconds: 10 },
  { label: 'Every 30s', seconds: 30 },
  { label: 'Every 2m', seconds: 120 },
];

const AUTO_FETCH_KEY = 'home:auto-fetch-seconds';

/** Persisted auto-fetch interval, validated against the options we actually
 *  offer — any stale/unknown value falls back to Off. */
function loadAutoFetchSeconds(): number {
  const saved = Number(localStorage.getItem(AUTO_FETCH_KEY));
  return AUTO_FETCH_OPTIONS.some((o) => o.seconds === saved) ? saved : 0;
}

/**
 * The home-screen Fetch control: a "Fetch" button plus an attached caret that
 * opens a menu to pick a periodic auto-fetch interval (Off / 10s / 30s / 2m).
 * Clicking Fetch runs `onFetch` once; the chosen interval is handed to the
 * background sync engine (`sync_set_auto_fetch`), which owns the timer and
 * runs the periodic `git fetch --prune` off the UI thread — results land via
 * the watcher → `sync-updated`, never through this component.
 */
export function FetchButton({
  onFetch,
  fetching,
}: {
  onFetch: () => void | Promise<void>;
  fetching: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [seconds, setSeconds] = useState(loadAutoFetchSeconds);
  const ref = useRef<HTMLDivElement>(null);

  // Close the popover on outside click / Escape (mirrors RepoMenu).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Hand the cadence to the sync engine on mount (the persisted value) and on
  // every change — the engine owns the periodic fetch, this is just the knob.
  useEffect(() => {
    syncSetAutoFetch(seconds).catch((e) => console.warn('sync_set_auto_fetch_failed', e));
  }, [seconds]);

  const choose = (next: number) => {
    setSeconds(next);
    localStorage.setItem(AUTO_FETCH_KEY, String(next));
    setOpen(false);
  };

  const active = AUTO_FETCH_OPTIONS.find((o) => o.seconds === seconds) ?? AUTO_FETCH_OPTIONS[0];
  const auto = seconds > 0;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', flex: '0 0 auto' }}>
      <button
        type="button"
        className="btn btn-lg"
        onClick={() => void onFetch()}
        disabled={fetching}
        style={{
          opacity: fetching ? 0.6 : 1,
          // Square off the right edge so it reads as one control with the caret.
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
        }}
        title={auto ? `Auto-fetching ${active.label.toLowerCase()}` : 'Fetch from remote'}
      >
        <Icon name="branch" size={12} color="var(--gray-700)" /> {fetching ? 'Fetching…' : 'Fetch'}
      </button>
      <button
        type="button"
        className="btn btn-lg"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Auto-fetch interval"
        title={auto ? `Auto-fetch: ${active.label}` : 'Set auto-fetch interval'}
        style={{
          // Join to the Fetch button: square inner corners, collapse the shared border.
          borderTopLeftRadius: 0,
          borderBottomLeftRadius: 0,
          marginLeft: -1,
          padding: '0 7px',
        }}
      >
        <Icon name="chevron-down" size={11} color={auto ? 'var(--blue)' : 'var(--gray-700)'} />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 6,
            minWidth: 150,
            background: '#fff',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--sh-pop)',
            padding: 4,
            zIndex: 20,
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              color: 'var(--gray-500)',
              padding: '4px 8px 2px',
              letterSpacing: 0.02,
            }}
          >
            Auto-fetch
          </div>
          {AUTO_FETCH_OPTIONS.map((o) => (
            <button
              key={o.seconds}
              type="button"
              role="menuitemradio"
              aria-checked={o.seconds === seconds}
              onClick={() => choose(o.seconds)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                textAlign: 'left',
                background: 'none',
                border: 'none',
                borderRadius: 5,
                padding: '6px 8px',
                fontFamily: 'inherit',
                fontSize: 12.5,
                color: 'var(--gray-800)',
                cursor: 'default',
              }}
            >
              <span style={{ width: 12, display: 'flex', flex: '0 0 12px' }}>
                {o.seconds === seconds && <Icon name="check" size={11} color="var(--blue)" />}
              </span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
