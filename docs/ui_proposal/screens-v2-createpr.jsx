/* screens-v2-createpr.jsx — Create PR split into Order + Intro screens */

/* ─────────────────────────────────────────────────────────────
   3a · Create PR — Order files (drag and drop)
   ───────────────────────────────────────────────────────────── */
function V2_CreatePR_Order() {
  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage — Open pull request" />

        <div style={{
          height: 48, flex: '0 0 48px',
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '0 16px', background: '#fff',
          borderBottom: '1px solid var(--hairline)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="badge mono" style={{ background: 'rgba(0,0,0,0.06)' }}>main</span>
            <Icon name="arrow-right" size={11} color="var(--gray-400)" />
            <span className="badge mono" style={{ background: 'var(--blue-tint)', color: 'var(--blue-press)' }}>feat/checkout-v2</span>
          </div>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gray-900)', marginLeft: 6 }}>
            Replace legacy checkout with multi-step flow
          </span>
          <div style={{ flex: 1 }} />
          {/* Stepper */}
          <V2_PRSteps step={1} />
          <div style={{ flex: 1 }} />
          <div className="btn">Save draft</div>
          <div className="btn">Skip ordering</div>
          <div className="btn btn-primary">Next: Write intros <Icon name="chevron-right" size={11} color="#fff"/></div>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Unordered files (drag source) */}
          <div style={{ width: 260, flex: '0 0 260px', borderRight: '1px solid var(--hairline)', background: '#fbfaf8', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '12px 14px 8px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gray-800)' }}>Unordered files</div>
              <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 2, lineHeight: 1.4 }}>
                Drag into the storyline. Files left here will be shown to reviewers in alphabetical order at the end.
              </div>
            </div>
            <div style={{ flex: 1, padding: '0 8px 8px' }}>
              {FILES.filter(f => ['src/components/Button.tsx', 'tests/checkout.spec.ts', 'tests/checkout/flow.spec.ts', 'README.md'].includes(f.path)).map(f => (
                <V2_DragFileCard key={f.path} f={f} />
              ))}
            </div>
          </div>

          {/* Storyline canvas */}
          <div style={{ flex: 1, minWidth: 0, padding: '16px 22px', background: 'var(--gray-50)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <Icon name="doc-stack" size={14} color="var(--gray-700)"/>
              <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: -0.01, color: 'var(--gray-900)' }}>Reviewer storyline</span>
              <span className="badge">7 of 11 ordered</span>
              <div style={{ flex: 1 }}/>
              <div style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
                Drag rows to reorder. Drop unordered files from the left to add steps.
              </div>
            </div>

            <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
              {/* Storyline items as drag cards */}
              {STORYLINE.map((s, i) => (
                <V2_OrderRow key={s.step} s={s} dragging={i === 3} />
              ))}

              {/* Drop indicator (between step 4 and 5) */}
              <div style={{
                height: 0, marginLeft: 56,
                borderTop: '2px dashed var(--blue)',
                position: 'relative', marginTop: -2, marginBottom: -2,
                opacity: 0.6,
              }}>
                <span style={{
                  position: 'absolute', left: -50, top: -10,
                  fontSize: 10.5, fontWeight: 600, color: 'var(--blue)',
                }}>drop here</span>
              </div>

              <div style={{
                marginTop: 10, padding: '20px',
                border: '1.5px dashed rgba(0,0,0,0.16)', borderRadius: 'var(--r-lg)',
                background: 'rgba(0,0,0,0.02)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 8, color: 'var(--gray-500)', fontSize: 12.5,
              }}>
                <Icon name="plus" size={12} color="var(--gray-500)" />
                Drop unordered files here to extend the storyline
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function V2_PRSteps({ step }) {
  const steps = ['Order files', 'Write intros'];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {steps.map((s, i) => {
        const idx = i + 1;
        const active = idx === step, done = idx < step;
        return (
          <React.Fragment key={i}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                width: 18, height: 18, borderRadius: 9,
                background: active ? 'var(--blue)' : done ? 'var(--green-d)' : 'rgba(0,0,0,0.10)',
                color: active || done ? '#fff' : 'var(--gray-700)',
                fontSize: 10.5, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{done ? '✓' : idx}</div>
              <span style={{ fontSize: 12, fontWeight: active ? 600 : 500, color: active ? 'var(--gray-900)' : 'var(--gray-600)' }}>{s}</span>
            </div>
            {i < steps.length - 1 && <div style={{ width: 24, height: 1, background: 'rgba(0,0,0,0.12)' }}/>}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function V2_DragFileCard({ f }) {
  const ch = { added: 'A', modified: 'M', removed: 'D', renamed: 'R' }[f.status];
  const chColor = { added: 'var(--green-d)', modified: '#a08000', removed: 'var(--red-d)', renamed: 'var(--purple)' }[f.status];
  const parts = f.path.split('/'); const file = parts.pop(); const dir = parts.join('/');
  return (
    <div style={{
      background: '#fff', border: '1px solid var(--hairline)',
      borderRadius: 'var(--r-md)', padding: '8px 10px',
      margin: '4px 0',
      display: 'flex', alignItems: 'center', gap: 8,
      boxShadow: 'var(--sh-1)',
    }}>
      <Icon name="grip" size={11} color="var(--gray-400)" />
      <span className="mono" style={{
        fontSize: 10, fontWeight: 700, color: chColor,
        width: 14, height: 14, borderRadius: 3,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: '1px solid ' + chColor + '55',
        flex: '0 0 14px',
      }}>{ch}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file}</div>
        {dir && <div style={{ fontSize: 10, color: 'var(--gray-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dir}</div>}
      </div>
      <span style={{ fontSize: 10.5, color: 'var(--gray-500)' }}>
        {f.add > 0 && <span style={{ color: 'var(--green-d)' }}>+{f.add}</span>}
        {f.add > 0 && f.del > 0 && ' '}
        {f.del > 0 && <span style={{ color: 'var(--red-d)' }}>−{f.del}</span>}
      </span>
    </div>
  );
}

function V2_OrderRow({ s, dragging }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px',
      background: dragging ? '#fff' : 'transparent',
      border: '1px solid ' + (dragging ? 'rgba(0,122,255,0.5)' : 'transparent'),
      borderRadius: 'var(--r-md)',
      boxShadow: dragging ? '0 8px 24px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.06), 0 0 0 3px var(--blue-tint)' : 'none',
      marginBottom: 4,
      transform: dragging ? 'translateY(-2px) scale(1.005)' : 'none',
    }}>
      <Icon name="grip" size={12} color="var(--gray-400)" />
      <div style={{
        width: 24, height: 24, borderRadius: 12, flex: '0 0 24px',
        background: 'var(--blue)', color: '#fff',
        fontSize: 12, fontWeight: 700,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{s.step}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-900)' }}>{s.title}</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--gray-500)' }}>{s.file}</span>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 2 }}>
          {s.intro ? <span><Icon name="check" size={10} color="var(--green-d)"/> intro written</span> : <span style={{ fontStyle: 'italic' }}>no intro yet</span>}
        </div>
      </div>
      <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
        <span style={{ color: 'var(--green-d)' }}>+96</span> <span style={{ color: 'var(--red-d)' }}>−0</span>
      </span>
      <Icon name="chevron-down" size={10} color="var(--gray-400)" />
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────
   3b · Create PR — Write intros (with diff preview)
   ───────────────────────────────────────────────────────────── */
function V2_CreatePR_Intro() {
  const focus = 3; // PaymentStep
  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage — Open pull request" />

        <div style={{
          height: 48, flex: '0 0 48px',
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '0 16px', background: '#fff',
          borderBottom: '1px solid var(--hairline)',
        }}>
          <div className="btn"><Icon name="chevron-left" size={11}/> Back to ordering</div>
          <div style={{ flex: 1 }} />
          <V2_PRSteps step={2} />
          <div style={{ flex: 1 }} />
          <div className="btn">Save draft</div>
          <div className="btn btn-primary"><Icon name="gh" size={11} color="#fff"/> Open PR on GitHub</div>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Step list */}
          <div style={{ width: 260, flex: '0 0 260px', borderRight: '1px solid var(--hairline)', background: '#fbfaf8', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '12px 14px 8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="doc-stack" size={13} color="var(--gray-700)"/>
                <span style={{ fontSize: 13, fontWeight: 700 }}>Storyline</span>
                <span className="badge">6 of 7 with intros</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 4, lineHeight: 1.4 }}>
                Write one or two sentences per step so reviewers know what to look at.
              </div>
            </div>
            <div style={{ flex: 1, padding: '4px 8px 8px', overflow: 'hidden' }}>
              {STORYLINE.map((s, i) => (
                <V2_IntroStepRow key={s.step} s={s} active={i === focus} />
              ))}
            </div>
          </div>

          {/* Top-level PR meta + intro editor + diff */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#fff' }}>
            {/* PR header */}
            <div style={{ padding: '14px 22px 12px', borderBottom: '1px solid var(--hairline)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span className="badge mono" style={{ background: 'rgba(0,0,0,0.06)' }}>main</span>
                <Icon name="arrow-right" size={11} color="var(--gray-400)" />
                <span className="badge mono" style={{ background: 'var(--blue-tint)', color: 'var(--blue-press)' }}>feat/checkout-v2</span>
                <div style={{ flex: 1 }}/>
                <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>11 files · +412 −87</span>
              </div>
              <input className="input lg" defaultValue="Replace legacy checkout with multi-step flow"
                     style={{ fontSize: 14, fontWeight: 600, height: 34 }} />
              <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11.5, color: 'var(--gray-600)' }}>
                <span><strong style={{ color: 'var(--gray-700)' }}>Reviewers:</strong> Mira Park, Jon Singh</span>
                <span style={{ color: 'var(--gray-400)' }}>·</span>
                <span><strong style={{ color: 'var(--gray-700)' }}>Labels:</strong> <span className="badge badge-blue">checkout</span></span>
              </div>
            </div>

            {/* Step focus */}
            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
              {/* Intro editor */}
              <div style={{ width: 380, flex: '0 0 380px', borderRight: '1px solid var(--hairline)', padding: '14px 18px', background: 'var(--gray-50)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 22, height: 22, borderRadius: 11, background: 'var(--blue)', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{STORYLINE[focus].step}</div>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--gray-900)', letterSpacing: -0.01 }}>{STORYLINE[focus].title}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 4 }}>{STORYLINE[focus].file}</div>
                </div>

                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray-500)', letterSpacing: 0.06, textTransform: 'uppercase' }}>Intro for reviewers</label>
                  <div style={{
                    marginTop: 6,
                    background: '#fff',
                    border: '1px solid rgba(0,0,0,0.14)',
                    borderRadius: 'var(--r-md)',
                    padding: '10px 12px',
                    fontSize: 13, color: 'var(--gray-800)', lineHeight: 1.5,
                    minHeight: 120,
                    boxShadow: 'inset 0 1px 0 rgba(0,0,0,0.02)',
                  }}>
                    {STORYLINE[focus].intro}<span style={{ display: 'inline-block', width: 1, height: 14, background: 'var(--blue)', verticalAlign: 'middle', marginLeft: 1 }}/>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--gray-500)', marginTop: 4 }}>
                    Markdown supported · ⌘↩ to save and continue
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  <div className="btn"><Icon name="sparkle" size={10} color="var(--purple)"/> Draft from diff</div>
                  <div style={{ flex: 1 }}/>
                  <div className="btn btn-ghost" style={{ color: 'var(--gray-700)' }}>Skip step</div>
                </div>

                <div style={{ flex: 1 }}/>

                {/* Step nav */}
                <div style={{ display: 'flex', gap: 6 }}>
                  <div className="btn"><Icon name="chevron-left" size={11}/> Step 3</div>
                  <div style={{ flex: 1 }}/>
                  <div className="btn btn-primary">Step 5 <Icon name="chevron-right" size={11} color="#fff"/></div>
                </div>
              </div>

              {/* Diff preview */}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--hairline)', background: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="eye" size={11} color="var(--gray-500)"/>
                  <span style={{ fontSize: 11.5, color: 'var(--gray-600)', fontWeight: 500 }}>Preview · what reviewers will see for this step</span>
                  <div style={{ flex: 1 }}/>
                  <span className="badge badge-green">+84 −0</span>
                </div>
                <div style={{ flex: 1, overflow: 'hidden', background: '#fff' }}>
                  {/* Intro card (preview of how it'll show up) */}
                  <div style={{ padding: 14 }}>
                    <div style={{
                      display: 'flex', gap: 10, padding: '10px 12px',
                      background: 'rgba(0,122,255,0.06)',
                      border: '1px solid rgba(0,122,255,0.18)',
                      borderRadius: 'var(--r-md)',
                    }}>
                      <Avatar name="You" size="sm" />
                      <div style={{ fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.45 }}>
                        <span style={{ fontWeight: 600 }}>Your note:</span> {STORYLINE[focus].intro}
                      </div>
                    </div>
                  </div>
                  <div style={{ borderTop: '1px solid var(--hairline)' }}>
                    <table className="diff">
                      <tbody>
                        {DIFF_PAYMENT.slice(0, 12).map((l, i) => renderDiffRow(l, i))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function V2_IntroStepRow({ s, active }) {
  const hasIntro = !!s.intro && s.step !== 7;
  return (
    <div style={{
      display: 'flex', gap: 8, padding: '8px 10px',
      borderRadius: 'var(--r-md)',
      background: active ? '#fff' : 'transparent',
      border: '1px solid ' + (active ? 'rgba(0,122,255,0.4)' : 'transparent'),
      boxShadow: active ? 'var(--sh-2)' : 'none',
      margin: '1px 0',
    }}>
      <div style={{
        width: 20, height: 20, borderRadius: 10, flex: '0 0 20px',
        background: active ? 'var(--blue)' : (hasIntro ? 'rgba(52,199,89,0.18)' : 'var(--gray-150)'),
        color: active ? '#fff' : (hasIntro ? 'var(--green-d)' : 'var(--gray-600)'),
        fontSize: 11, fontWeight: 700, marginTop: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{hasIntro && !active ? '✓' : s.step}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: active ? 600 : 500, color: 'var(--gray-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s.title}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--gray-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
          {s.file.split('/').pop()}
        </div>
        {hasIntro && !active && (
          <div style={{ fontSize: 11, color: 'var(--gray-500)', marginTop: 4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical' }}>
            {s.intro}
          </div>
        )}
        {!hasIntro && !active && (
          <div style={{ fontSize: 11, color: 'var(--orange)', marginTop: 4, fontStyle: 'italic' }}>
            no intro yet
          </div>
        )}
      </div>
    </div>
  );
}


Object.assign(window, { V2_CreatePR_Order, V2_CreatePR_Intro });
