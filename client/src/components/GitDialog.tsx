import { type ReactNode, useState } from 'react';
import type { GitStep } from '../generated/GitStep';
import type { GitStepKind } from '../generated/GitStepKind';
import { DISMISS } from '../lib/shortcuts';
import { useShortcut } from '../lib/useShortcut';
import { ErrorBanner } from './ErrorBanner';
import { Icon, type IconName } from './Icon';

/** Step-dot accent per git-step kind (mirrors the v6 design's V6_GitStepList).
 *  Keyed by the Rust `GitStepKind`, so a new kind is a type error here rather
 *  than an undefined colour at runtime. */
const DOT_COLOR: Record<GitStepKind, string> = {
  stash: 'var(--orange)',
  checkout: 'var(--blue)',
  pop: 'var(--orange)',
  // A push leaves the working tree alone but is the one step that reaches the
  // network and changes what other people can see — green, like the prompt.
  push: 'var(--green-d)',
};

/** The numbered list of git commands a confirmed action will run — the
 *  ADR-0027 "confirmation that lists the exact git commands". Presentational
 *  and shared by every git action (switch, push).
 *
 *  Commands **wrap** rather than ellipsize: the command line is the thing the
 *  user is being asked to approve, so hiding its tail defeats the point of
 *  showing it. */
export function GitStepList({ steps }: { steps: GitStep[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {steps.map((s, i) => (
        <div
          key={s.command}
          style={{
            display: 'flex',
            gap: 12,
            position: 'relative',
            paddingBottom: i === steps.length - 1 ? 0 : 14,
          }}
        >
          {i !== steps.length - 1 && (
            <div
              style={{
                position: 'absolute',
                left: 8,
                top: 20,
                bottom: 0,
                width: 2,
                background: 'var(--hairline)',
              }}
            />
          )}
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              flex: '0 0 18px',
              background: '#fff',
              border: `2px solid ${DOT_COLOR[s.kind]}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              fontWeight: 700,
              color: DOT_COLOR[s.kind],
              zIndex: 1,
            }}
          >
            {i + 1}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginBottom: 4 }}>
              {s.note}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 12,
                background: '#1e1c1a',
                color: '#e8e6e3',
                padding: '7px 10px',
                borderRadius: 6,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                userSelect: 'text',
              }}
            >
              <span style={{ color: '#6ee7a0' }}>$ </span>
              {s.command}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * What kind of git situation the dialog reports. Drives the icon chip and
 * nothing else — the copy stays the caller's (and, for failures, the engine's).
 *
 * - `action` — a mutation the user is about to authorize (switch, commit, push).
 * - `blocked` — an *expected* git state that forbids what was asked, usually
 *   with an alternative affordance ("checked out in another worktree → focus
 *   that worktree", "a rebase is in progress").
 * - `error` — a `git`/`gh` call failed; the body is the engine's verbatim message.
 * - `info` — a neutral status the user should acknowledge.
 */
export type GitDialogTone = 'action' | 'blocked' | 'error' | 'info';

const TONE: Record<GitDialogTone, { icon: IconName; color: string; tint: string }> = {
  action: { icon: 'branch', color: 'var(--blue)', tint: 'var(--blue-tint)' },
  blocked: { icon: 'alert', color: 'var(--orange)', tint: 'rgba(255,149,0,0.12)' },
  error: { icon: 'alert', color: 'var(--red-d)', tint: 'rgba(255,59,48,0.10)' },
  info: { icon: 'eye', color: 'var(--gray-500)', tint: 'var(--gray-100)' },
};

/**
 * A labelled verbatim value — a path, a ref, a SHA. Rendered in its own mono
 * block that **wraps and is selectable**, which is why long values belong here
 * rather than inline in `body`: an unbreakable 70-character worktree path in a
 * prose sentence overflows the card, and can't be copied out of it either.
 */
export type GitDialogDetail = { label: string; value: string };

/**
 * The one modal for git situations: a confirmation that lists the exact
 * commands, an expected state that blocks the action, or a failed `git`/`gh`
 * call. Every variant is the same shell — icon chip + title + explanation,
 * optional verbatim details, optional step list, one primary affordance — so a
 * new git state needs copy and a tone, not another dialog.
 *
 * Fail loud (CLAUDE.md): the confirm handler's rejection renders **verbatim**
 * in the error banner and the dialog stays open, so the message can be read and
 * copied. Nothing is shortened or rewritten.
 *
 * Purely presentational: it decides no git policy and derives no state. Which
 * tone a situation gets is the caller's call, from what Rust returned.
 */
export function GitDialog({
  tone = 'action',
  icon,
  title,
  body,
  details,
  steps,
  confirmLabel,
  onConfirm,
  cancelLabel = 'Cancel',
  onClose,
}: {
  tone?: GitDialogTone;
  /** Override the tone's icon (e.g. `folder` for a worktree situation). */
  icon?: IconName;
  title: ReactNode;
  body: ReactNode;
  /** Verbatim paths/refs, each on its own wrapping, selectable mono line. */
  details?: GitDialogDetail[];
  /** The git commands a confirm will run — renders the "Stage will run" list. */
  steps?: GitStep[];
  /** Primary button label. With no `onConfirm` it just dismisses (default "Close"). */
  confirmLabel?: string;
  /** Omit for a dismiss-only dialog (a report with no action to take). */
  onConfirm?: () => Promise<void>;
  cancelLabel?: string;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = TONE[tone];
  const dismissOnly = !onConfirm;
  const hasSteps = !!steps && steps.length > 0;
  const hasDetails = !!details && details.length > 0;
  const hasContent = hasSteps || hasDetails || !!error;

  useShortcut(DISMISS, onClose, { enabled: !submitting });

  const confirm = async () => {
    if (!onConfirm) {
      onClose();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      console.warn('git_dialog_confirm_failed', e);
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: overlay modal; a styled div with role="dialog" matches the existing NewReviewModal/RepoMenu pattern rather than a native <dialog>.
    <div
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : 'Git action'}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 50,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        style={{
          width: hasSteps ? 540 : 430,
          maxWidth: '100%',
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: '#fff',
          borderRadius: 12,
          boxShadow: 'var(--sh-pop)',
          // The card clips its own content, so nothing can paint outside the
          // white surface (the overlap this dialog used to show). Everything
          // inside wraps, so clipping never actually hides text.
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '16px 22px 14px',
            borderBottom: hasContent ? '1px solid var(--hairline)' : 'none',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 11,
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: t.tint,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: '0 0 30px',
            }}
          >
            <Icon name={icon ?? t.icon} size={15} color={t.color} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--gray-900)',
                letterSpacing: -0.01,
                overflowWrap: 'anywhere',
              }}
            >
              {title}
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: 'var(--gray-600)',
                marginTop: 3,
                lineHeight: 1.45,
                overflowWrap: 'anywhere',
              }}
            >
              {body}
            </div>
          </div>
        </div>
        {hasContent && (
          <div style={{ padding: '16px 22px', overflowY: 'auto', flex: 1 }}>
            {hasDetails && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  marginBottom: hasSteps ? 16 : 0,
                }}
              >
                {details?.map((d) => (
                  <div key={d.label}>
                    <div className="section-label" style={{ padding: '0 0 4px' }}>
                      {d.label}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 11.5,
                        color: 'var(--gray-700)',
                        background: 'var(--gray-75)',
                        border: '1px solid var(--hairline)',
                        borderRadius: 'var(--r-sm)',
                        padding: '6px 9px',
                        overflowWrap: 'anywhere',
                        userSelect: 'text',
                        lineHeight: 1.45,
                      }}
                    >
                      {d.value}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {hasSteps && (
              <>
                <div className="section-label" style={{ padding: '0 0 12px' }}>
                  Stage will run
                </div>
                <GitStepList steps={steps ?? []} />
              </>
            )}
            {error && (
              <div style={{ marginTop: hasSteps || hasDetails ? 12 : 0, marginBottom: -10 }}>
                <ErrorBanner title={error} onClose={() => setError(null)} />
              </div>
            )}
          </div>
        )}
        <div
          style={{
            padding: '12px 22px',
            borderTop: '1px solid var(--hairline)',
            background: 'var(--gray-50)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {hasSteps && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--gray-500)',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Icon name="eye" size={12} color="var(--gray-400)" /> Nothing runs until you confirm
            </div>
          )}
          <div style={{ flex: 1 }} />
          {!dismissOnly && (
            <button type="button" className="btn" onClick={onClose} disabled={submitting}>
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={confirm}
            disabled={submitting}
            style={{ opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? 'Working…' : (confirmLabel ?? (dismissOnly ? 'Close' : 'Confirm'))}
          </button>
        </div>
      </div>
    </div>
  );
}
