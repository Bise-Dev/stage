import { useState } from 'react';

/**
 * A compact, dismissible error banner. Shows a short `title`, an optional
 * collapsed `detail` (clamped to a couple of lines so a giant payload — e.g. a
 * server HTML traceback — never floods the screen), a **Copy** action that puts
 * the *full* title+detail on the clipboard, and a close button.
 *
 * Why this exists: backend failures can carry long, ugly bodies (a 500's HTML,
 * a stack trace). Per CLAUDE.md we surface the cause verbatim rather than
 * swallowing it — but the user shouldn't have to scroll a wall of markup to
 * dismiss it. So: message up front, full text one click away, always closable.
 */
export function ErrorBanner({
  title,
  detail,
  onClose,
}: {
  title: string;
  /** The full error text. Omitted when the title says everything. */
  detail?: string | null;
  /** When provided, renders a close button that calls this. */
  onClose?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // A new error replacing the old one resets the transient Copy/expand state.
  // Adjusting state during render on a changed prop is React's recommended
  // pattern here (no effect needed): React re-renders immediately with the
  // reset values before painting.
  const [prevDetail, setPrevDetail] = useState(detail);
  if (detail !== prevDetail) {
    setPrevDetail(detail);
    setCopied(false);
    setExpanded(false);
  }

  const full = detail ? `${title}\n\n${detail}` : title;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
    } catch (e) {
      // Non-fatal: copying is a convenience. Surface for visibility per CLAUDE.md.
      console.warn('error_banner_copy_failed', e);
    }
  };

  const longDetail = !!detail && (detail.length > 140 || detail.includes('\n'));

  return (
    <div
      style={{
        fontSize: 11.5,
        color: 'var(--red-d)',
        background: 'rgba(255,59,48,0.08)',
        border: '1px solid rgba(255,59,48,0.20)',
        borderRadius: 'var(--r-sm)',
        padding: '6px 10px',
        marginBottom: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {/* `overflowWrap: anywhere` — git/gh messages carry unbreakable tokens
            (a 70-char worktree path, a URL) that would otherwise overflow. */}
        <div
          style={{
            flex: 1,
            fontWeight: 600,
            lineHeight: 1.4,
            minWidth: 0,
            overflowWrap: 'anywhere',
          }}
        >
          {title}
        </div>
        <button
          type="button"
          className="btn"
          onClick={copy}
          style={{ flex: '0 0 auto', height: 20, padding: '0 8px', fontSize: 11 }}
          title="Copy the full error text"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        {onClose && (
          <button
            type="button"
            className="btn"
            onClick={onClose}
            aria-label="Dismiss"
            title="Dismiss"
            style={{
              flex: '0 0 auto',
              height: 20,
              width: 20,
              padding: 0,
              fontSize: 13,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        )}
      </div>

      {detail && (
        <div
          className="mono"
          style={{
            color: 'var(--red-d)',
            opacity: 0.85,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 11,
            lineHeight: 1.45,
            ...(expanded
              ? { maxHeight: 200, overflow: 'auto' }
              : {
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }),
          }}
        >
          {detail}
        </div>
      )}

      {longDetail && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            alignSelf: 'flex-start',
            background: 'none',
            border: 'none',
            padding: 0,
            color: 'var(--red-d)',
            fontFamily: 'inherit',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'default',
            textDecoration: 'underline',
          }}
        >
          {expanded ? 'Hide details' : 'Show details'}
        </button>
      )}
    </div>
  );
}
