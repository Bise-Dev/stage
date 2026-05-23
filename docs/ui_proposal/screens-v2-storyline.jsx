/* screens-v2-storyline.jsx — Storyline Review refined with B's timeline line */

function V2_StorylineReview() {
  const step = STORYLINE[3];
  const focusIdx = 3;
  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage — Reviewing jon/sso-okta · 4 / 9" />

        {/* Subheader: PR context */}
        <div style={{
          flex: '0 0 56px',
          padding: '8px 16px',
          background: '#fff',
          borderBottom: '1px solid var(--hairline)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <Avatar name="Jon Singh" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-900)', letterSpacing: -0.01 }}>
              Okta SSO provider behind feature flag
              <span className="badge badge-orange" style={{ marginLeft: 8 }}>Changes requested</span>
              <span className="badge" style={{ background: 'rgba(0,0,0,0.06)', marginLeft: 4, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <Icon name="gh" size={9} color="var(--gray-700)"/> PR #479
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 1 }}>
              Jon Singh · <span className="mono">jon/sso-okta</span> → <span className="mono">main</span> · 19 files · <span style={{ color: 'var(--green-d)' }}>+731</span> <span style={{ color: 'var(--red-d)' }}>−14</span>
            </div>
          </div>
          <div className="btn"><Icon name="open-window" size={11}/> Outline</div>
          <div className="btn btn-primary"><Icon name="check" size={11} color="#fff"/> Finish review</div>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Storyline outline with vertical timeline line */}
          <div style={{ width: 240, flex: '0 0 240px', borderRight: '1px solid var(--hairline)', background: '#fbfaf8', padding: '14px 0 14px 0', position: 'relative', display: 'flex', flexDirection: 'column' }}>
            <div className="section-label" style={{ paddingLeft: 16, marginBottom: 8 }}>Storyline · 4 / 9</div>

            {/* Vertical track + filled portion */}
            <div style={{ position: 'relative', flex: 1, padding: '4px 8px' }}>
              {/* gray track */}
              <div style={{
                position: 'absolute', left: 24, top: 14,
                width: 2, height: 'calc(100% - 28px)',
                background: 'rgba(0,0,0,0.10)',
                borderRadius: 1,
              }}/>
              {/* filled (completed steps) */}
              <div style={{
                position: 'absolute', left: 24, top: 14,
                width: 2, height: `${focusIdx * (100 / STORYLINE.length) + 4}%`,
                background: 'var(--green-d)',
                borderRadius: 1,
              }}/>

              {STORYLINE.map((s, i) => {
                const done = i < focusIdx, current = i === focusIdx;
                return (
                  <div key={s.step} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '7px 10px',
                    borderRadius: 5,
                    margin: '1px 0',
                    background: current ? 'rgba(0,122,255,0.10)' : 'transparent',
                    color: current ? 'var(--blue-press)' : (done ? 'var(--gray-500)' : 'var(--gray-800)'),
                    position: 'relative',
                  }}>
                    <div style={{
                      width: 18, height: 18, borderRadius: 9, flex: '0 0 18px',
                      background: done ? 'var(--green-d)' : (current ? 'var(--blue)' : '#fff'),
                      border: '2px solid ' + (done ? 'var(--green-d)' : current ? 'var(--blue)' : 'rgba(0,0,0,0.18)'),
                      color: '#fff', fontSize: 10, fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: current ? '0 0 0 3px var(--blue-tint-2)' : 'none',
                      zIndex: 1,
                      position: 'relative',
                    }}>{done ? '✓' : s.step}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 12.5,
                        fontWeight: current ? 600 : 500,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{s.title}</div>
                      <div className="mono" style={{
                        fontSize: 10.5,
                        color: current ? 'rgba(0,98,204,0.7)' : 'var(--gray-500)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        marginTop: 1,
                      }}>{s.file.split('/').pop()}</div>
                    </div>
                    {(s.step === 4) && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, color: current ? 'var(--blue-press)' : 'var(--gray-500)' }}>
                        <Icon name="comment-fill" size={9} color={current ? 'var(--blue-press)' : 'var(--gray-400)'}/> 1
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Your draft footer */}
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--hairline-2)', fontSize: 11.5, color: 'var(--gray-600)', lineHeight: 1.5 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--orange)', fontWeight: 600 }}>
                <Icon name="comment-fill" size={10} color="var(--orange)"/> 4 pending comments
              </div>
              <div style={{ marginTop: 2 }}>in your draft review</div>
            </div>
          </div>

          {/* Center */}
          <div style={{ flex: 1, minWidth: 0, background: 'var(--gray-50)', display: 'flex', flexDirection: 'column' }}>
            {/* Step header */}
            <div style={{ padding: '14px 22px 12px', background: '#fff', borderBottom: '1px solid var(--hairline)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{
                  width: 24, height: 24, borderRadius: 12, background: 'var(--blue)',
                  color: '#fff', fontSize: 12, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>4</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--gray-900)', letterSpacing: -0.01 }}>{step.title}</div>
                <span className="badge badge-green">added</span>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--gray-500)', marginLeft: 4 }}>{step.file}</span>
              </div>
              <div style={{
                display: 'flex', gap: 10, padding: '8px 10px',
                background: 'rgba(0,122,255,0.07)',
                border: '1px solid rgba(0,122,255,0.18)',
                borderRadius: 'var(--r-md)',
              }}>
                <Avatar name="Jon Singh" size="sm" />
                <div style={{ fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.45 }}>
                  <span style={{ fontWeight: 600 }}>Jon's note:</span> {step.intro}
                </div>
              </div>
            </div>

            <div style={{ flex: 1, overflow: 'hidden', padding: '12px 22px' }}>
              <div style={{ background: '#fff', border: '1px solid var(--hairline)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
                <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--hairline-2)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
                  <Icon name="file" size={12} color="var(--gray-500)" />
                  <span className="mono" style={{ fontSize: 11.5, color: 'var(--gray-700)' }}>src/checkout/steps/PaymentStep.tsx</span>
                  <div style={{ flex: 1 }} />
                  <span style={{ color: 'var(--gray-500)' }}>+84 −0</span>
                </div>
                <table className="diff">
                  <tbody>
                    {DIFF_PAYMENT.slice(0, 8).map((l, i) => renderDiffRow(l, i))}
                  </tbody>
                </table>
                <CommentBlock {...COMMENTS['PaymentStep:12']} />
                <table className="diff">
                  <tbody>
                    {DIFF_PAYMENT.slice(8).map((l, i) => renderDiffRow(l, i + 8))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Footer: prev/next */}
            <div style={{
              flex: '0 0 52px', padding: '0 22px',
              display: 'flex', alignItems: 'center', gap: 10,
              background: '#fff', borderTop: '1px solid var(--hairline)',
            }}>
              <div className="btn"><Icon name="chevron-left" size={12}/> Step 3 · Address</div>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4, padding: '0 12px' }}>
                {STORYLINE.map((s, i) => (
                  <div key={s.step} style={{
                    flex: 1, height: 3, borderRadius: 2,
                    background: i < focusIdx ? 'var(--green-d)' : i === focusIdx ? 'var(--blue)' : 'rgba(0,0,0,0.10)',
                  }}/>
                ))}
              </div>
              <div className="btn"><Icon name="comment" size={11}/> Add comment</div>
              <div className="btn btn-primary">Step 5 · Review <Icon name="chevron-right" size={12} color="#fff"/></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { V2_StorylineReview });
