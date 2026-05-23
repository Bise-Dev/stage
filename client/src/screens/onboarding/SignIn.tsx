import { Icon } from '../../components/Icon';
import { StageLogo } from '../../components/StageLogo';

export function SignIn({ onContinue }: { onContinue: () => void }) {
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

        <div className="flex items-center gap-2.5" style={{ margin: '18px 0' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
          <span
            style={{
              fontSize: 11,
              color: 'var(--gray-500)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontWeight: 600,
            }}
          >
            or
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
        </div>

        <div className="text-center" style={{ fontSize: 12.5, color: 'var(--gray-700)' }}>
          <button
            type="button"
            onClick={onContinue}
            className="cursor-default bg-transparent border-none p-0"
            style={{
              color: 'var(--blue)',
              fontWeight: 600,
              fontSize: 'inherit',
              fontFamily: 'inherit',
            }}
          >
            Skip — use Stage locally only
          </button>
          <div style={{ fontSize: 11, color: 'var(--gray-500)', marginTop: 4 }}>
            You can still review your own branches and storylines. Connect GitHub later from
            Settings.
          </div>
        </div>
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
