import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { StageLogo } from '../../components/StageLogo';
import { runDeviceFlow } from '../../lib/auth';
import type { DeviceCode, User } from '../../tauri';

type State =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'awaiting-user'; device: DeviceCode }
  | { kind: 'error'; reason: 'expired' | 'denied' | 'transport'; detail?: string };

const ERROR_COPY: Record<'expired' | 'denied' | 'transport', string> = {
  expired: 'GitHub code expired. Try again.',
  denied: 'Authorization denied on GitHub.',
  transport: "Couldn't reach Stage backend.",
};

export function SignIn({ onAuthenticated }: { onAuthenticated: (u: User) => void }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const startFlow = useCallback(async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ kind: 'starting' });

    const outcome = await runDeviceFlow((e) => {
      if (e.kind === 'code-issued') {
        setState({ kind: 'awaiting-user', device: e.device });
      }
    }, ac.signal);

    if (outcome.ok) {
      onAuthenticated(outcome.user);
    } else {
      setState({ kind: 'error', reason: outcome.reason, detail: outcome.detail });
    }
  }, [onAuthenticated]);

  // Cancel any in-flight poll on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div
      className="flex h-full w-full items-center justify-center relative"
      style={{ background: 'linear-gradient(180deg, #fbfaf8 0%, #f0eee9 100%)' }}
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
            <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>Local pull-request review</div>
          </div>
        </div>

        {state.kind === 'idle' && <IdleCard onContinue={startFlow} />}
        {state.kind === 'starting' && <StatusCard label="Contacting GitHub…" />}
        {state.kind === 'awaiting-user' && <AwaitingCard device={state.device} />}
        {state.kind === 'error' && (
          <ErrorCard
            reason={state.reason}
            detail={state.detail}
            onRetry={() => setState({ kind: 'idle' })}
          />
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
  );
}

function IdleCard({ onContinue }: { onContinue: () => void }) {
  return (
    <>
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
      <div style={{ fontSize: 12.5, color: 'var(--gray-500)', lineHeight: 1.5, marginBottom: 18 }}>
        Stage syncs with your GitHub account so it can open pull requests and post review comments
        on your behalf.
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onContinue}
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
        <button
          type="button"
          onClick={onContinue}
          className="flex items-center justify-center gap-1.5 w-full cursor-default"
          style={{
            height: 38,
            borderRadius: 'var(--r-sm)',
            background: '#ffffff',
            border: '1px solid rgba(0,0,0,0.12)',
            boxShadow: '0 1px 0 rgba(0,0,0,0.04)',
            color: 'var(--gray-800)',
            fontSize: 13,
            fontWeight: 500,
            fontFamily: 'inherit',
          }}
        >
          Continue with SSO
        </button>
      </div>
    </>
  );
}

function StatusCard({ label }: { label: string }) {
  return (
    <div style={{ fontSize: 13, color: 'var(--gray-700)', textAlign: 'center', padding: '12px 0' }}>
      {label}
    </div>
  );
}

function AwaitingCard({ device }: { device: DeviceCode }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 12.5, color: 'var(--gray-500)', marginBottom: 10 }}>
        Enter this code at{' '}
        <span className="mono" style={{ color: 'var(--gray-800)' }}>
          {device.verification_uri}
        </span>
      </div>
      <div
        className="mono"
        style={{
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: '0.18em',
          color: 'var(--gray-900)',
          padding: '14px 0',
        }}
      >
        {device.user_code}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 6 }}>
        Waiting for GitHub… browser should have opened.
      </div>
    </div>
  );
}

function ErrorCard({
  reason,
  detail,
  onRetry,
}: {
  reason: 'expired' | 'denied' | 'transport';
  detail: string | undefined;
  onRetry: () => void;
}) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-900)', marginBottom: 6 }}>
        {ERROR_COPY[reason]}
      </div>
      {detail && (
        <div style={{ fontSize: 11, color: 'var(--gray-500)', marginBottom: 12 }}>{detail}</div>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="cursor-default"
        style={{
          height: 32,
          padding: '0 14px',
          borderRadius: 'var(--r-sm)',
          background: '#1a1917',
          color: '#fff',
          border: 'none',
          fontSize: 13,
          fontWeight: 600,
          fontFamily: 'inherit',
        }}
      >
        Try again
      </button>
    </div>
  );
}
