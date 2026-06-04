import { useEffect, useRef, useState } from 'react';

import { Icon } from '../../components/Icon';
import { StageLogo } from '../../components/StageLogo';
import { TitleBar } from '../../components/TitleBar';
import { type AuthEvent, runWebFlow } from '../../lib/auth';
import type { User } from '../../tauri';

type SignInState = { kind: 'idle' } | { kind: 'signing-in' } | { kind: 'error'; message: string };

type Props = {
  onAuthenticated: (user: User) => void;
  /**
   * Enter local-only mode (ADR-0013): no Stage session, local features only.
   * Not sticky — signing in later upgrades to the full signed-in experience.
   */
  onStayOffline: () => void;
};

export function SignIn({ onAuthenticated, onStayOffline }: Props) {
  const [state, setState] = useState<SignInState>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const startSignIn = () => {
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

  const cancelSignIn = () => {
    abortRef.current?.abort();
    setState({ kind: 'idle' });
  };

  return (
    <div className="flex flex-col h-full w-full">
      <TitleBar title="Stage" />
      <div
        className="flex flex-1 items-center justify-center relative"
        style={{
          background: 'linear-gradient(180deg, #fbfaf8 0%, #f0eee9 100%)',
          minHeight: 0,
        }}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: 'radial-gradient(rgba(0,0,0,0.06) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
            opacity: 0.5,
          }}
        />

        <div
          className="relative z-10"
          style={{
            width: 380,
            background: '#fff',
            border: '1px solid var(--hairline)',
            borderRadius: 14,
            boxShadow: '0 24px 60px rgba(0,0,0,0.10), 0 4px 16px rgba(0,0,0,0.06)',
            padding: '28px 30px',
          }}
        >
          <div className="flex items-center gap-2.5" style={{ marginBottom: 22 }}>
            <StageLogo />
            <div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  color: 'var(--gray-900)',
                  letterSpacing: '-0.02em',
                }}
              >
                Stage
              </div>
              <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>
                Local pull-request review
              </div>
            </div>
          </div>

          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: 'var(--gray-900)',
              letterSpacing: '-0.01em',
              marginBottom: 4,
            }}
          >
            Sign in to continue
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--gray-500)',
              lineHeight: 1.5,
              marginBottom: 18,
            }}
          >
            Stage syncs with your GitHub account so it can open pull requests and post review
            comments on your behalf.
          </div>

          {state.kind === 'idle' && (
            <>
              <button
                type="button"
                onClick={startSignIn}
                className="flex items-center justify-center gap-1.5 w-full cursor-default"
                style={{
                  height: 38,
                  borderRadius: 'var(--r-sm)',
                  background: '#1a1917',
                  color: '#fff',
                  border: 'none',
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                }}
              >
                <Icon name="gh" size={14} color="#fff" />
                Continue with GitHub
              </button>
              {/* Local-only path (ADR-0013): work without a Stage session.
                  Not sticky — signing in later unlocks the backend features. */}
              <button
                type="button"
                onClick={onStayOffline}
                className="w-full cursor-default"
                style={{
                  marginTop: 10,
                  height: 32,
                  borderRadius: 'var(--r-sm)',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--gray-600)',
                  fontSize: 12.5,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                }}
              >
                Stay offline — review locally without signing in
              </button>
            </>
          )}

          {state.kind === 'signing-in' && (
            <div>
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--gray-700)',
                  marginBottom: 12,
                  lineHeight: 1.5,
                }}
              >
                Continue in your browser to finish signing in…
              </div>
              <button
                type="button"
                onClick={cancelSignIn}
                className="w-full cursor-default"
                style={{
                  height: 36,
                  borderRadius: 'var(--r-sm)',
                  background: '#ffffff',
                  border: '1px solid rgba(0,0,0,0.12)',
                  color: 'var(--gray-800)',
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
            </div>
          )}

          {state.kind === 'error' && (
            <div>
              <div
                style={{
                  fontSize: 12.5,
                  color: '#b42318',
                  marginBottom: 12,
                  lineHeight: 1.5,
                }}
              >
                Sign-in failed: {state.message}
              </div>
              <button
                type="button"
                onClick={startSignIn}
                className="flex items-center justify-center gap-1.5 w-full cursor-default"
                style={{
                  height: 38,
                  borderRadius: 'var(--r-sm)',
                  background: '#1a1917',
                  color: '#fff',
                  border: 'none',
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                }}
              >
                <Icon name="gh" size={14} color="#fff" />
                Retry
              </button>
            </div>
          )}
        </div>

        <div
          className="absolute left-0 right-0 text-center"
          style={{ bottom: 18, fontSize: 11, color: 'var(--gray-500)' }}
        >
          By continuing you agree to the <span style={{ color: 'var(--gray-700)' }}>Terms</span> and{' '}
          <span style={{ color: 'var(--gray-700)' }}>Privacy</span>. Stage runs locally — your code
          never leaves your machine.
        </div>
      </div>
    </div>
  );
}
