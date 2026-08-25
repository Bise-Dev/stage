import { getVersion } from '@tauri-apps/api/app';
import { type ReactNode, useEffect, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { StageLogo } from '../../components/StageLogo';
import { TitleBar } from '../../components/TitleBar';
import { type GitHubUser, buildInfo, ghIdentity } from '../../tauri';

/**
 * Settings is a single scrolling page: the GitHub identity Stage acts as, and
 * what this copy of Stage is. There is little enough of it that a two-entry
 * sidebar cost a click to read one screen's worth of content, so both sections
 * sit on the page.
 */
export function Settings({
  onClose,
}: {
  /** Return to the screen Settings was opened from. */
  onClose: () => void;
}) {
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

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '24px 32px' }}>
          <div style={{ maxWidth: 560 }}>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                color: 'var(--gray-900)',
                letterSpacing: -0.02,
                marginBottom: 4,
              }}
            >
              Settings
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--gray-500)', marginBottom: 24 }}>
              The GitHub identity Stage acts as, and this copy of Stage.
            </div>

            <AccountSection />

            <div style={{ borderTop: '1px solid var(--hairline)', margin: '24px 0 20px' }} />

            <AboutSection />
          </div>
        </div>
      </div>
    </div>
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

  if (error) {
    return (
      <Card label="Account" hint="GitHub CLI not ready">
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
          stores no token of its own. Run <span className="mono">gh auth login</span> in a terminal,
          then reopen Stage.
        </div>
      </Card>
    );
  }

  return (
    <Card
      label="Account"
      hint="Stage reads your GitHub identity from your local `gh` credentials. It holds no token of its own, and self-review never calls GitHub."
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
  );
}

/**
 * Render a build timestamp (Unix epoch seconds) as a local date and time. Stage
 * has no prebuilt releases — every copy is built from source — so "when was this
 * built" is the honest answer to "how old is my install?".
 */
function formatBuiltAt(builtAt: number): string {
  return new Date(builtAt * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [builtAt, setBuiltAt] = useState<number | null>(null);
  const [builtAtError, setBuiltAtError] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch((e) => {
        // Fail-loud (CLAUDE.md): surface the failure instead of rendering a
        // blank or fabricated version.
        console.warn('app_version_failed', e);
        setVersionError(String(e));
      });
    buildInfo()
      .then((info) => setBuiltAt(info.built_at))
      .catch((e) => {
        // Same rule as the version above: a missing build time is shown as a
        // failure, never quietly omitted.
        console.warn('build_info_failed', e);
        setBuiltAtError(String(e));
      });
  }, []);

  return (
    <Card label="About">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '14px',
          background: '#fff',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--r-md)',
        }}
      >
        <StageLogo size={48} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: 'var(--gray-900)',
              letterSpacing: -0.02,
            }}
          >
            Stage
          </div>
          <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 2 }}>
            {versionError ? (
              <span style={{ color: 'var(--red-d)' }}>Couldn't read version: {versionError}</span>
            ) : version ? (
              `Version ${version}`
            ) : (
              'Version …'
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 2 }}>
            {builtAtError ? (
              <span style={{ color: 'var(--red-d)' }}>
                Couldn't read build time: {builtAtError}
              </span>
            ) : builtAt !== null ? (
              `Built ${formatBuiltAt(builtAt)}`
            ) : (
              'Built …'
            )}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--gray-600)', marginTop: 6, lineHeight: 1.5 }}>
            A local-first tool for walking your own branch — with your coding agent's debrief
            alongside it.
          </div>
        </div>
      </div>
    </Card>
  );
}
