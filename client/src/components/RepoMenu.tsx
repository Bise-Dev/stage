import { type ReactNode, useEffect, useRef, useState } from 'react';

import { openInFinder } from '../tauri';
import { Icon } from './Icon';

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

/**
 * The bottom-left repository picker shared by the signed-in Workspaces home and
 * the local-only Repo home. A button showing the repo slug/path that opens an
 * upward popover with Change repository… / Reveal in Finder / Settings… and an
 * auth action. The auth action is the only thing that differs between the two
 * homes: signed-in passes "Sign out"; local-only passes "Sign in" (there is no
 * session to sign out of yet) — hence `authLabel` + `onAuth`.
 */
export function RepoMenu({
  slug,
  path,
  onChangeRepo,
  onOpenSettings,
  authLabel,
  onAuth,
}: {
  slug: string | null;
  path: string | null;
  onChangeRepo: () => void;
  onOpenSettings: () => void;
  /** "Sign out" (signed-in) or "Sign in" (local-only). */
  authLabel: string;
  onAuth: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  const label = slug ?? (path ? basename(path) : '—');

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          width: '100%',
          textAlign: 'left',
          background: open ? 'rgba(0,0,0,0.05)' : 'none',
          border: 'none',
          borderRadius: 5,
          padding: '4px 10px',
          cursor: 'default',
          fontFamily: 'inherit',
          minWidth: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Icon name="folder" size={13} color="var(--gray-500)" />
          <span
            style={{
              flex: 1,
              fontSize: 12.5,
              fontWeight: 500,
              color: 'var(--gray-800)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
            title={path ?? undefined}
          >
            {label}
          </span>
          <span
            style={{
              display: 'flex',
              color: 'var(--gray-400)',
              flex: '0 0 auto',
            }}
          >
            <Icon name="chevron-right" size={11} />
          </span>
        </div>
        {path && (
          <div
            className="mono"
            style={{
              paddingLeft: 19,
              marginTop: 1,
              color: 'var(--gray-500)',
              fontSize: 11,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {path}
          </div>
        )}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            right: 0,
            marginBottom: 6,
            background: '#fff',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--sh-pop)',
            padding: 4,
            zIndex: 20,
          }}
        >
          <MenuItem
            onClick={() => {
              setOpen(false);
              onChangeRepo();
            }}
          >
            Change repository…
          </MenuItem>
          <MenuItem
            disabled={!path}
            onClick={() => {
              setOpen(false);
              if (path) openInFinder(path).catch((e) => console.warn('open_in_finder_failed', e));
            }}
          >
            Reveal in Finder
          </MenuItem>
          <div
            aria-hidden="true"
            style={{ height: 1, background: 'var(--hairline)', margin: '4px 0' }}
          />
          <MenuItem
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            Settings…
          </MenuItem>
          <div
            aria-hidden="true"
            style={{ height: 1, background: 'var(--hairline)', margin: '4px 0' }}
          />
          <MenuItem
            onClick={() => {
              setOpen(false);
              onAuth();
            }}
          >
            {authLabel}
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'none',
        border: 'none',
        borderRadius: 5,
        padding: '6px 8px',
        fontFamily: 'inherit',
        fontSize: 12.5,
        color: disabled ? 'var(--gray-400)' : 'var(--gray-800)',
        cursor: 'default',
      }}
    >
      {children}
    </button>
  );
}
