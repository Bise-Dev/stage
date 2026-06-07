import { type CSSProperties, useEffect, useRef, useState } from 'react';

import { type AuthEvent, runWebFlow } from '../lib/auth';
import { useAuth } from '../lib/authContext';
import type { User } from '../tauri';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

type FlowState = { kind: 'idle' } | { kind: 'signing-in' } | { kind: 'error'; message: string };

const MAX_ERROR_CHARS = 160;
function previewError(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_ERROR_CHARS ? `${collapsed.slice(0, MAX_ERROR_CHARS)}…` : collapsed;
}

const pillStyle: CSSProperties = {
  height: 24,
  padding: '0 10px',
  borderRadius: 'var(--r-sm)',
  background: '#fff',
  border: '1px solid rgba(0,0,0,0.12)',
  color: 'var(--gray-800)',
  fontSize: 12,
  fontWeight: 500,
  fontFamily: 'inherit',
};

export function AuthStatus() {
  const { user, localOnly, markAuthenticated, signOut } = useAuth();

  // Pre-decision boot state (the SignIn screen): show nothing — sign-in is the
  // whole screen there, so a chip would double up (ADR-0017).
  if (!user && !localOnly) {
    return null;
  }

  return user ? (
    <SignedInChip login={user.github_login} name={user.display_name} onSignOut={signOut} />
  ) : (
    <SignInChip onAuthenticated={markAuthenticated} />
  );
}

function SignedInChip({
  login,
  name,
  onSignOut,
}: {
  login: string;
  name: string;
  onSignOut: () => void;
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

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center cursor-default"
        style={{
          gap: 6,
          height: 24,
          padding: '0 6px 0 4px',
          border: 'none',
          background: open ? 'rgba(0,0,0,0.06)' : 'transparent',
          borderRadius: 6,
          fontFamily: 'inherit',
        }}
      >
        <Avatar name={name || login} size="sm" />
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--gray-700)' }}>{login}</span>
        <Icon name="chevron-right" size={10} color="var(--gray-400)" />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 6,
            minWidth: 140,
            background: '#fff',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--sh-pop)',
            padding: 4,
            zIndex: 50,
          }}
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="flex items-center w-full text-left cursor-default"
            style={{
              gap: 8,
              padding: '6px 10px',
              border: 'none',
              background: 'transparent',
              borderRadius: 'var(--r-sm)',
              fontSize: 12.5,
              color: 'var(--gray-800)',
              fontFamily: 'inherit',
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function SignInChip({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [state, setState] = useState<FlowState>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const start = () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ kind: 'signing-in' });
    runWebFlow((event: AuthEvent) => {
      switch (event.kind) {
        case 'started':
          break;
        case 'authenticated':
          setState({ kind: 'idle' });
          onAuthenticated(event.user);
          break;
        case 'cancelled':
          setState({ kind: 'idle' });
          break;
        case 'error':
          setState({ kind: 'error', message: event.message });
          break;
      }
    }, controller.signal).catch(() => {
      // runWebFlow routes errors through onEvent
    });
  };

  const cancel = () => {
    abortRef.current?.abort();
    setState({ kind: 'idle' });
  };

  if (state.kind === 'signing-in') {
    return (
      <div className="flex items-center" style={{ gap: 8 }}>
        <span style={{ fontSize: 11.5, color: 'var(--gray-600)' }}>Continue in your browser…</span>
        <button type="button" onClick={cancel} className="cursor-default" style={pillStyle}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center" style={{ gap: 8 }}>
      {state.kind === 'error' && (
        <span
          title={state.message}
          style={{
            fontSize: 11.5,
            color: '#b42318',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {previewError(state.message)}
        </span>
      )}
      <button
        type="button"
        onClick={start}
        className="flex items-center cursor-default"
        style={{ ...pillStyle, gap: 5 }}
      >
        <Icon name="gh" size={12} color="var(--gray-700)" />
        {state.kind === 'error' ? 'Retry sign-in' : 'Sign in'}
      </button>
    </div>
  );
}
