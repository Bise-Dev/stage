import { StageLogo } from '../../components/StageLogo';

export type WizardStep = 'signIn' | 'openRepo';

const STEPS: { id: WizardStep; n: number; label: string }[] = [
  { id: 'signIn', n: 1, label: 'Sign in' },
  { id: 'openRepo', n: 2, label: 'Open repository' },
];

export function WizardRail({ active }: { active: WizardStep }) {
  const activeIndex = STEPS.findIndex((s) => s.id === active);

  return (
    <div
      className="flex flex-col"
      style={{
        width: 220,
        flex: '0 0 220px',
        borderRight: '1px solid var(--hairline)',
        padding: '52px 18px 24px 18px',
        background: 'rgba(255,255,255,0.6)',
      }}
    >
      <div className="flex items-center gap-2.5" style={{ marginBottom: 26 }}>
        <StageLogo size={26} />
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--gray-900)',
            letterSpacing: '-0.01em',
          }}
        >
          Stage
        </div>
      </div>

      {STEPS.map((s, i) => {
        const done = i < activeIndex;
        const isActive = i === activeIndex;
        return (
          <div key={s.id} className="flex items-center gap-2.5" style={{ padding: '8px 4px' }}>
            <div
              className="flex items-center justify-center"
              style={{
                width: 22,
                height: 22,
                borderRadius: 11,
                flex: '0 0 22px',
                background: done ? 'var(--green-d)' : isActive ? 'var(--blue)' : 'rgba(0,0,0,0.08)',
                color: done || isActive ? '#fff' : 'var(--gray-700)',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {done ? '✓' : s.n}
            </div>
            <span
              style={{
                fontSize: 12.5,
                fontWeight: isActive ? 600 : 500,
                color: isActive ? 'var(--gray-900)' : done ? 'var(--gray-700)' : 'var(--gray-500)',
              }}
            >
              {s.label}
            </span>
          </div>
        );
      })}

      <div
        style={{
          marginTop: 24,
          padding: '10px 12px',
          background: 'rgba(0,122,255,0.06)',
          border: '1px solid rgba(0,122,255,0.18)',
          borderRadius: 'var(--r-md)',
          fontSize: 11.5,
          color: 'var(--gray-700)',
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: 'var(--gray-900)' }}>Heads up:</strong> Stage reads from{' '}
        <span className="mono">.git</span> locally and never modifies your working tree. Your code
        stays on your machine.
      </div>
    </div>
  );
}
