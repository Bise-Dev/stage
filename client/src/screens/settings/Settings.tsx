import { getVersion } from '@tauri-apps/api/app';
import { type ReactNode, useEffect, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { StageLogo } from '../../components/StageLogo';
import { TitleBar } from '../../components/TitleBar';
import { type GitHubUser, ghIdentity } from '../../tauri';

type SectionId = 'account' | 'about';

const SECTIONS: { id: SectionId; label: string; icon: 'gh' | 'eye' }[] = [
  { id: 'account', label: 'Account', icon: 'gh' },
  { id: 'about', label: 'About', icon: 'eye' },
];

export function Settings({
  onClose,
}: {
  /** Return to the screen Settings was opened from. */
  onClose: () => void;
}) {
  const [section, setSection] = useState<SectionId>('account');

  // Esc closes Settings, matching the dismiss pattern used by the app's other
  // overlays (RepoMenu). Ignored while typing so it can't eat an Escape meant
  // for a focused field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
        return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="stage">
      <div className="win">
        <TitleBar
          title="Stage — Settings"
          right={
            <button type="button" className="btn" onClick={onClose}>
              Done
            </button>
          }
        />

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Sidebar nav */}
          <div
            style={{
              width: 200,
              flex: '0 0 200px',
              borderRight: '1px solid var(--hairline)',
              background: '#fbfaf8',
              padding: '14px 8px',
            }}
          >
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  padding: '6px 10px',
                  borderRadius: 5,
                  margin: '1px 0',
                  background: section === s.id ? 'rgba(0,0,0,0.06)' : 'transparent',
                  color: 'var(--gray-800)',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: section === s.id ? 600 : 500,
                  cursor: 'default',
                }}
              >
                <Icon name={s.icon} size={13} color="var(--gray-600)" />
                {s.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px' }}>
            {section === 'account' ? <AccountSection /> : <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: 'var(--gray-900)',
          letterSpacing: -0.02,
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--gray-500)', marginBottom: 24 }}>{hint}</div>
    </>
  );
}

function Card({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--gray-800)',
            letterSpacing: 0.02,
          }}
        >
          {label}
        </span>
        {hint && (
          <span style={{ fontSize: 11.5, color: 'var(--gray-500)', fontWeight: 500 }}>{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * The GitHub identity Stage acts as — the local `gh` token owner (ADR-0022 §5).
 * There is no Stage account, session, or sign-in/out: identity is whoever `gh`
 * is authenticated as, resolved read-only via `gh api user`. A failure (gh
 * absent/unauthenticated) surfaces verbatim with the `gh auth login` remedy.
 */
function AccountSection() {
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ghIdentity()
      .then(setUser)
      .catch((e) => {
        console.warn('gh_identity_failed', e);
        setError(String(e));
      });
  }, []);

  return (
    <>
      <SectionHeader title="Account" hint="The GitHub identity Stage acts as on your behalf." />

      {error ? (
        <Card label="GitHub CLI not ready">
          <div
            style={{
              padding: '14px',
              background: '#fff',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--r-md)',
              fontSize: 12.5,
              color: 'var(--gray-700)',
              lineHeight: 1.5,
            }}
          >
            <div style={{ color: 'var(--red-d)', marginBottom: 6 }}>{error}</div>
            Stage uses your local <span className="mono">gh</span> CLI for every GitHub action — it
            stores no token of its own. Run <span className="mono">gh auth login</span> in a
            terminal, then reopen Stage.
          </div>
        </Card>
      ) : (
        <Card
          label="Connected via the GitHub CLI"
          hint="Stage uses your local `gh` credentials to open PRs, post reviews, and read PR state. It holds no token of its own."
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '12px 14px',
              background: '#fff',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--r-md)',
            }}
          >
            <Avatar name={user?.name || user?.login || '…'} size="lg" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--gray-900)' }}>
                {user ? user.name || user.login : 'Resolving…'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--gray-500)' }}>
                {user ? `@${user.login}` : 'gh api user'}
              </div>
            </div>
            {user && (
              <span className="badge badge-green">
                <Icon name="check" size={9} color="var(--green-d)" /> gh
              </span>
            )}
          </div>
        </Card>
      )}
    </>
  );
}

function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch((e) => {
        // Fail-loud (CLAUDE.md): surface the failure instead of rendering a
        // blank or fabricated version.
        console.warn('app_version_failed', e);
        setVersionError(String(e));
      });
  }, []);

  return (
    <>
      <SectionHeader title="About" hint="About this copy of Stage." />

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18 }}>
        <StageLogo size={48} />
        <div>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: 'var(--gray-900)',
              letterSpacing: -0.02,
            }}
          >
            Stage
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--gray-500)', marginTop: 2 }}>
            {versionError ? (
              <span style={{ color: 'var(--red-d)' }}>Couldn't read version: {versionError}</span>
            ) : version ? (
              `Version ${version}`
            ) : (
              'Version …'
            )}
          </div>
        </div>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--gray-600)', maxWidth: 420, lineHeight: 1.5 }}>
        A local-first tool for human-tailored pull request review.
      </div>
    </>
  );
}
