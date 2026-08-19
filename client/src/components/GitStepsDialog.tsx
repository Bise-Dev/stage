import { type ReactNode, useState } from 'react';
import type { SwitchStep } from '../generated/SwitchStep';
import type { SwitchStepKind } from '../generated/SwitchStepKind';
import { Icon } from './Icon';

/** Step-dot accent per git-step kind (mirrors the v6 design's V6_GitStepList). */
const DOT_COLOR: Record<SwitchStepKind, string> = {
  stash: 'var(--orange)',
  checkout: 'var(--blue)',
  pop: 'var(--orange)',
};

/** The numbered list of git commands a confirmed action will run — the
 *  ADR-0027 "confirmation that lists the exact git commands". Presentational
 *  and reusable (the full-v6 push steps will render through it too). */
export function GitStepList({ steps }: { steps: SwitchStep[] }) {
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
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
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

/** Confirmation dialog for a git-mutating action: title, explanation, the
 *  exact step list, and a "nothing runs until you confirm" footer. The confirm
 *  handler's rejection message renders verbatim in the red banner (fail loud —
 *  the engine's message is complete; don't rewrite it). */
export function GitStepsDialog({
  title,
  body,
  steps,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  body: ReactNode;
  steps: SwitchStep[];
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      console.warn('git_steps_confirm_failed', e);
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: overlay modal; a styled div with role="dialog" matches the existing ConfirmDialog/NewReviewModal pattern rather than a native <dialog>.
    <div
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : 'Confirm git steps'}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        style={{
          width: 540,
          background: '#fff',
          borderRadius: 12,
          boxShadow: 'var(--sh-pop)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '16px 22px 14px',
            borderBottom: '1px solid var(--hairline)',
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
              background: 'var(--blue-tint)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: '0 0 30px',
            }}
          >
            <Icon name="branch" size={15} color="var(--blue)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--gray-900)',
                letterSpacing: -0.01,
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
              }}
            >
              {body}
            </div>
          </div>
        </div>
        <div style={{ padding: '16px 22px' }}>
          <div className="section-label" style={{ padding: '0 0 12px' }}>
            Stage will run
          </div>
          <GitStepList steps={steps} />
          {error && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--red-d)',
                background: 'rgba(255,59,48,0.08)',
                border: '1px solid rgba(255,59,48,0.20)',
                borderRadius: 'var(--r-sm)',
                padding: '6px 10px',
                marginTop: 12,
              }}
            >
              {error}
            </div>
          )}
        </div>
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
          <div style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={confirm}
            disabled={submitting}
            style={{ opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
