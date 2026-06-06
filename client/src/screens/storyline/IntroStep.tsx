import { Icon } from '../../components/Icon';
import type { SelfReviewFileChange } from '../../tauri';
import { DiffPreview } from './DiffPreview';
import type { Step } from './reconcile';

/** One row in the step-list rail (numbered, ✓ once an intro exists, with a
 *  one-line intro snippet or a "no intro yet" warning). */
function StepRow({
  s,
  n,
  active,
  onSelect,
}: {
  s: Step;
  /** 1-based position shown in the circle. */
  n: number;
  active: boolean;
  onSelect: () => void;
}) {
  const hasIntro = s.introText.trim().length > 0;
  const file = s.path.split('/').pop() ?? s.path;
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: 'flex',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 'var(--r-md)',
        background: active ? '#fff' : 'transparent',
        border: `1px solid ${active ? 'rgba(0,122,255,0.4)' : 'transparent'}`,
        boxShadow: active ? 'var(--sh-2)' : 'none',
        margin: '1px 0',
        width: '100%',
        textAlign: 'left',
        cursor: 'default',
        fontFamily: 'inherit',
      }}
    >
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          flex: '0 0 20px',
          background: active
            ? 'var(--blue)'
            : hasIntro
              ? 'rgba(52,199,89,0.18)'
              : 'var(--gray-150)',
          color: active ? '#fff' : hasIntro ? 'var(--green-d)' : 'var(--gray-600)',
          fontSize: 11,
          fontWeight: 700,
          marginTop: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {hasIntro && !active ? '✓' : n}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="mono"
          style={{
            fontSize: 12,
            fontWeight: active ? 600 : 500,
            color: 'var(--gray-900)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {file}
        </div>
        {s.stale && <span className="badge badge-orange">stale</span>}
        {hasIntro ? (
          <div
            style={{
              fontSize: 11,
              color: 'var(--gray-500)',
              marginTop: 4,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 1,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {s.introText}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--orange)', marginTop: 4, fontStyle: 'italic' }}>
            no intro yet
          </div>
        )}
      </div>
    </button>
  );
}

/**
 * Step 2 of storyline composition (design screen 3b): a step-list rail, an
 * intro editor, and a live diff preview of what reviewers will see for the
 * focused step. The diff text comes from the parent (one `self_review_diff`
 * call, indexed by path); this component is otherwise stateless.
 */
export function IntroStep({
  steps,
  selectedPath,
  onSelectPath,
  onSetIntro,
  getFile,
  diffLoading,
  diffError,
}: {
  steps: Step[];
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  onSetIntro: (path: string, text: string) => void;
  getFile: (path: string) => SelfReviewFileChange | null;
  diffLoading: boolean;
  diffError: string | null;
}) {
  const withIntro = steps.filter((s) => s.introText.trim().length > 0).length;
  const idx = steps.findIndex((s) => s.path === selectedPath);
  const selected = idx === -1 ? null : steps[idx];

  const goto = (i: number) => {
    if (i >= 0 && i < steps.length) onSelectPath(steps[i].path);
  };

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {/* Step list rail */}
      <div
        style={{
          width: 260,
          flex: '0 0 260px',
          borderRight: '1px solid var(--hairline)',
          background: '#fbfaf8',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
        }}
      >
        <div style={{ padding: '12px 14px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="doc-stack" size={13} color="var(--gray-700)" />
            <span style={{ fontSize: 13, fontWeight: 700 }}>Storyline</span>
            <span className="badge">
              {withIntro} of {steps.length} with intros
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 4, lineHeight: 1.4 }}>
            Write one or two sentences per step so reviewers know what to look at.
          </div>
        </div>
        <div style={{ flex: 1, padding: '4px 8px 8px' }}>
          {steps.length === 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--gray-500)', padding: '4px 6px' }}>
              No steps yet — go back to ordering to add files.
            </div>
          )}
          {steps.map((s, i) => (
            <StepRow
              key={s.path}
              s={s}
              n={i + 1}
              active={s.path === selectedPath}
              onSelect={() => onSelectPath(s.path)}
            />
          ))}
        </div>
      </div>

      {/* Editor + preview */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', minHeight: 0 }}>
        {!selected ? (
          <div style={{ padding: '24px', fontSize: 12.5, color: 'var(--gray-500)' }}>
            Select a step to write its intro.
          </div>
        ) : (
          <>
            {/* Intro editor */}
            <div
              style={{
                width: 380,
                flex: '0 0 380px',
                borderRight: '1px solid var(--hairline)',
                padding: '14px 18px',
                background: 'var(--gray-50)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                minHeight: 0,
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 11,
                      background: 'var(--blue)',
                      color: '#fff',
                      fontSize: 11,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flex: '0 0 22px',
                    }}
                  >
                    {idx + 1}
                  </div>
                  <span
                    className="mono"
                    style={{
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: 'var(--gray-900)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {selected.path}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <label
                  htmlFor="storyline-intro"
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--gray-500)',
                    letterSpacing: 0.06,
                    textTransform: 'uppercase',
                  }}
                >
                  Intro for reviewers
                </label>
                <textarea
                  id="storyline-intro"
                  className="input"
                  value={selected.introText}
                  onChange={(e) => onSetIntro(selected.path, e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      goto(idx + 1);
                    }
                  }}
                  placeholder="Why this file matters, what to look at first…"
                  style={{
                    marginTop: 6,
                    width: '100%',
                    flex: 1,
                    minHeight: 120,
                    fontFamily: 'inherit',
                    resize: 'none',
                    lineHeight: 1.5,
                  }}
                />
                <div style={{ fontSize: 11, color: 'var(--gray-500)', marginTop: 4 }}>
                  Markdown supported · ⌘↩ to save and continue
                </div>
              </div>

              {/* Step nav */}
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => goto(idx - 1)}
                  disabled={idx <= 0}
                  style={{ opacity: idx <= 0 ? 0.4 : 1 }}
                >
                  <Icon name="chevron-left" size={11} /> Prev
                </button>
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => goto(idx + 1)}
                  disabled={idx >= steps.length - 1}
                  style={{ opacity: idx >= steps.length - 1 ? 0.4 : 1 }}
                >
                  Next <Icon name="chevron-right" size={11} color="#fff" />
                </button>
              </div>
            </div>

            {/* Diff preview */}
            <DiffPreview
              introText={selected.introText}
              file={getFile(selected.path)}
              loading={diffLoading}
              error={diffError}
            />
          </>
        )}
      </div>
    </div>
  );
}
