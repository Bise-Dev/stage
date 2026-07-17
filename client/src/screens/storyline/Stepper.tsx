import { Fragment } from 'react';

export type WizardStep = 'order' | 'intro';

const STEPS: { key: WizardStep; label: string }[] = [
  { key: 'order', label: 'Order files' },
  { key: 'intro', label: 'Write intros' },
];

/** The two-step wizard indicator from the design (Order files · Write intros).
 *  Steps are buttons so the author can jump between them; the connector line
 *  fills green once a step is behind the current one. */
export function Stepper({
  current,
  onJump,
}: {
  current: WizardStep;
  onJump: (step: WizardStep) => void;
}) {
  const currentIdx = STEPS.findIndex((s) => s.key === current);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {STEPS.map((s, i) => {
        const active = i === currentIdx;
        const done = i < currentIdx;
        return (
          <Fragment key={s.key}>
            <button
              type="button"
              onClick={() => onJump(s.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'default',
                fontFamily: 'inherit',
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  background: active ? 'var(--blue)' : done ? 'var(--green-d)' : 'rgba(0,0,0,0.10)',
                  color: active || done ? '#fff' : 'var(--gray-700)',
                  fontSize: 10.5,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                  color: active ? 'var(--gray-900)' : 'var(--gray-600)',
                }}
              >
                {s.label}
              </span>
            </button>
            {i < STEPS.length - 1 && (
              <div style={{ width: 24, height: 1, background: 'rgba(0,0,0,0.12)' }} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
