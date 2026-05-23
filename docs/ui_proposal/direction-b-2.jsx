/* direction-b-2.jsx — Direction B: Create PR, Storyline Review, Publish Review */

/* ─────────────────────────────────────────────────────────────
   B3 · Create PR (Inspector-style: storyline timeline on left, editor + per-step intro right)
   ───────────────────────────────────────────────────────────── */
function B_CreatePR() {
  const focusStep = 3; // PaymentStep
  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage — Open pull request" vibrant
          right={<>
            <div className="btn">Save draft</div>
            <div className="btn btn-primary"><Icon name="gh" size={11} color="#fff"/> Open on GitHub</div>
          </>}
        />

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Storyline rail — vertical timeline */}
          <B_Sidebar width={260}>
            <div style={{ padding: '12px 14px 6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="doc-stack" size={13} color="var(--gray-700)" />
                <span style={{ fontSize: 13, fontWeight: 700 }}>Storyline</span>
                <span className="badge">7 / 11</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--gray-500)', marginTop: 4, lineHeight: 1.4 }}>
                Drag to reorder. Unordered files appear at the end.
              </div>
            </div>

            <div style={{ flex: 1, overflow: 'hidden', padding: '4px 10px 10px', position: 'relative' }}>
              {/* timeline track */}
              <div style={{ position: 'absolute', left: 24, top: 10, bottom: 60, width: 2, background: 'rgba(0,0,0,0.08)' }}/>
              {STORYLINE.map((s, i) => (
                <div key={s.step} style={{
                  display: 'flex', gap: 8, padding: '6px 6px',
                  position: 'relative',
                }}>
                  <div style={{
                    width: 18, height: 18, borderRadius: 9,
                    background: i === focusStep ? 'var(--blue)' : '#fff',
                    border: '2px solid ' + (i === focusStep ? 'var(--blue)' : 'rgba(0,0,0,0.18)'),
                    color: i === focusStep ? '#fff' : 'var(--gray-700)',
                    fontSize: 10, fontWeight: 700,
                    flex: '0 0 18px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: i === focusStep ? '0 0 0 3px var(--blue-tint-2)' : 'none',
                    zIndex: 1,
                  }}>{s.step}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12.5, fontWeight: i === focusStep ? 600 : 500,
                      color: 'var(--gray-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{s.title}</div>
                    <div className="mono" style={{ fontSize: 10.5, color: 'var(--gray-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.file.split('/').pop()}</div>
                    {s.intro && i !== focusStep && (
                      <div style={{
                        fontSize: 11, color: 'var(--gray-500)',
                        marginTop: 4, lineHeight: 1.4,
                        overflow: 'hidden', display: '-webkit-box',
                        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                      }}>{s.intro}</div>
                    )}
                  </div>
                  {i !== focusStep && <Icon name="grip" size={10} color="var(--gray-400)"/>}
                </div>
              ))}

              <B_SLLabel right={<Icon name="plus" size={11} color="var(--gray-500)"/>}>Unordered (4)</B_SLLabel>
              {['Button.tsx', 'checkout.spec.ts', 'flow.spec.ts', 'README.md'].map(n => (
                <div key={n} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 12px', fontSize: 12, color: 'var(--gray-600)',
                }}>
                  <Icon name="file" size={11} color="var(--gray-400)"/>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{n}</span>
                  <Icon name="plus" size={10} color="var(--gray-400)"/>
                </div>
              ))}
            </div>
          </B_Sidebar>

          {/* Center: PR meta + per-step focus */}
          <div style={{ flex: 1, minWidth: 0, padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden' }}>
            {/* PR meta strip */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="badge mono" style={{ background: 'rgba(0,0,0,0.06)' }}>main</span>
              <Icon name="arrow-right" size={11} color="var(--gray-400)" />
              <span className="badge mono" style={{ background: 'var(--blue-tint)', color: 'var(--blue-press)' }}>feat/checkout-v2</span>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>11 files · +412 −87</span>
            </div>

            {/* Title */}
            <input className="input lg" defaultValue="Replace legacy checkout with multi-step flow"
              style={{ fontSize: 16, fontWeight: 700, height: 38, padding: '0 12px', letterSpacing: -0.01 }} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, flex: 1, minHeight: 0 }}>
              {/* Description */}
              <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray-500)', letterSpacing: 0.06, textTransform: 'uppercase' }}>Description</span>
                  <div className="seg" style={{ height: 22 }}>
                    <div className="active">Write</div>
                    <div>Preview</div>
                  </div>
                </div>
                <div style={{ flex: 1, background: '#fff', border: '1px solid rgba(0,0,0,0.14)', borderRadius: 'var(--r-md)', padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--gray-800)', lineHeight: 1.55, overflow: 'hidden' }}>
                  <span className="t-com">## Summary</span>{'\n'}
                  Replaces the single-page checkout form with a three-step{'\n'}
                  flow (address → payment → review), driven by a reducer{'\n'}
                  in `src/checkout/state.ts`. Payment uses Stripe Elements{'\n'}
                  tokenization end-to-end.{'\n\n'}
                  <span className="t-com">## Why</span>{'\n'}
                  Conversion drops 18% at the long-form step. The new flow{'\n'}
                  shortens perceived work and lets us A/B per-step copy{'\n'}
                  without a redeploy.{'\n\n'}
                  <span className="t-com">## Reviewer storyline</span>{'\n'}
                  See the 7-step walkthrough on the left.
                </div>
              </div>

              {/* Step intro editor */}
              <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray-500)', letterSpacing: 0.06, textTransform: 'uppercase' }}>Intro for Step {STORYLINE[focusStep].step}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--gray-500)' }}>{STORYLINE[focusStep].file}</span>
                </div>
                <div style={{
                  background: 'rgba(0,122,255,0.04)',
                  border: '1px solid rgba(0,122,255,0.25)',
                  borderRadius: 'var(--r-md)',
                  padding: '10px 12px',
                  fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.5,
                  marginBottom: 8,
                }}>
                  {STORYLINE[focusStep].intro}
                </div>
                <div style={{ flex: 1, background: '#fff', border: '1px solid var(--hairline)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
                  <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--hairline-2)', fontSize: 11, color: 'var(--gray-500)' }}>
                    Preview of how reviewers will see step {STORYLINE[focusStep].step}
                  </div>
                  <table className="diff">
                    <tbody>
                      {DIFF_PAYMENT.slice(0, 8).map((l, i) => renderDiffRow(l, i))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Footer meta */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingTop: 4, borderTop: '1px solid var(--hairline)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--gray-500)', fontWeight: 600 }}>Reviewers</span>
                <Avatar name="Mira Park" size="sm" />
                <Avatar name="Jon Singh" size="sm" />
                <Icon name="plus" size={11} color="var(--gray-500)"/>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--gray-500)', fontWeight: 600 }}>Labels</span>
                <span className="badge badge-blue">checkout</span>
                <span className="badge badge-orange">needs-design-review</span>
              </div>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>Storyline coverage: <strong style={{ color: 'var(--green-d)' }}>64%</strong></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────
   B4 · Storyline review (sidebar timeline + author intro overlay + diff)
   ───────────────────────────────────────────────────────────── */
function B_StorylineReview() {
  const step = STORYLINE[3];
  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage" vibrant />

        {/* Toolbar */}
        <div style={{
          height: 48, flex: '0 0 48px',
          background: 'linear-gradient(180deg, rgba(248,247,244,0.95), rgba(238,237,233,0.95))',
          backdropFilter: 'blur(20px) saturate(180%)',
          borderBottom: '1px solid var(--hairline)',
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 12px',
        }}>
          <Avatar name="Jon Singh" size="sm" />
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>Okta SSO provider behind feature flag</span>
            <span style={{ fontSize: 10.5, color: 'var(--gray-500)' }}><span className="mono">jon/sso-okta</span> · Jon Singh</span>
          </div>
          <span className="badge badge-orange">Changes requested</span>
          <div style={{ flex: 1 }} />
          <div className="btn"><Icon name="chevron-left" size={11}/></div>
          <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>Step 4 / 9</span>
          <div className="btn btn-primary">Next <Icon name="chevron-right" size={11} color="#fff"/></div>
          <div style={{ width: 1, height: 18, background: 'rgba(0,0,0,0.12)', margin: '0 6px' }}/>
          <div className="btn btn-success">Finish review</div>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Timeline sidebar */}
          <B_Sidebar width={220}>
            <B_SLLabel right={<span style={{ fontSize: 10, color: 'var(--gray-500)' }}>4/9</span>}>Storyline</B_SLLabel>
            <div style={{ flex: 1, overflow: 'hidden', padding: '4px 6px', position: 'relative' }}>
              <div style={{ position: 'absolute', left: 18, top: 12, bottom: 12, width: 2, background: 'rgba(0,0,0,0.08)' }}/>
              <div style={{ position: 'absolute', left: 18, top: 12, height: 'calc(3 * 50px + 12px)', width: 2, background: 'var(--green)' }}/>
              {STORYLINE.map((s, i) => {
                const done = i < 3, current = i === 3;
                return (
                  <div key={s.step} style={{ display: 'flex', gap: 8, padding: '4px 4px 6px', height: 50, position: 'relative' }}>
                    <div style={{
                      width: 18, height: 18, borderRadius: 9, flex: '0 0 18px',
                      background: done ? 'var(--green-d)' : (current ? 'var(--blue)' : '#fff'),
                      border: '2px solid ' + (done ? 'var(--green-d)' : current ? 'var(--blue)' : 'rgba(0,0,0,0.18)'),
                      color: '#fff', fontSize: 10, fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: current ? '0 0 0 3px var(--blue-tint-2)' : 'none',
                      zIndex: 1,
                    }}>{done ? '✓' : s.step}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 12, fontWeight: current ? 600 : 500,
                        color: current ? 'var(--gray-900)' : (done ? 'var(--gray-500)' : 'var(--gray-700)'),
                        textDecoration: done ? 'none' : 'none',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{s.title}</div>
                      <div className="mono" style={{ fontSize: 10, color: 'var(--gray-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{s.file.split('/').pop()}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ padding: 12, borderTop: '1px solid var(--hairline-2)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray-500)', letterSpacing: 0.06, textTransform: 'uppercase', marginBottom: 6 }}>Your draft</div>
              <div style={{ fontSize: 12, color: 'var(--gray-700)', lineHeight: 1.5 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--orange)' }}>
                  <Icon name="comment-fill" size={11} color="var(--orange)"/> 4 pending comments
                </span>
                <div style={{ marginTop: 6 }}>0 unresolved · 9 of 9 viewed</div>
              </div>
            </div>
          </B_Sidebar>

          {/* Center */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--gray-50)' }}>
            {/* Step header card */}
            <div style={{ padding: '14px 22px', background: '#fff', borderBottom: '1px solid var(--hairline)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{
                  width: 26, height: 26, borderRadius: 13, background: 'var(--blue)',
                  color: '#fff', fontSize: 12, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>4</div>
                <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: -0.01 }}>{step.title}</span>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>{step.file}</span>
                <div style={{ flex: 1 }} />
                <span className="badge badge-green">+84 −0</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', background: 'rgba(0,122,255,0.06)', borderLeft: '3px solid var(--blue)', borderRadius: '0 6px 6px 0' }}>
                <Avatar name="Jon Singh" size="sm" />
                <div style={{ fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>Jon’s note for this step</div>
                  {step.intro}
                </div>
              </div>
            </div>

            {/* Diff */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{ background: '#fff' }}>
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
                {/* New comment composer */}
                <div style={{ padding: 12, background: 'var(--gray-50)', borderTop: '1px solid var(--hairline)' }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Avatar name="You" size="sm" />
                    <div style={{ flex: 1, background: '#fff', border: '1px solid rgba(0,0,0,0.14)', borderRadius: 'var(--r-md)', boxShadow: 'var(--sh-1)' }}>
                      <div style={{ padding: '8px 10px', fontSize: 12.5, color: 'var(--gray-400)' }}>
                        Add a comment on this step…
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 8px', borderTop: '1px solid var(--hairline-2)', gap: 6 }}>
                        <div style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>Posted to Jon after you finish the review</div>
                        <div style={{ flex: 1 }}/>
                        <div className="btn"><Icon name="sparkle" size={10} color="var(--purple)"/> Suggest change</div>
                        <div className="btn btn-primary">Add to draft</div>
                      </div>
                    </div>
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


/* ─────────────────────────────────────────────────────────────
   B5 · Publish review — popover from toolbar
   ───────────────────────────────────────────────────────────── */
function B_PublishReview() {
  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage" vibrant />

        {/* Toolbar (same as B4 but with popover anchor) */}
        <div style={{
          height: 48, flex: '0 0 48px',
          background: 'linear-gradient(180deg, rgba(248,247,244,0.95), rgba(238,237,233,0.95))',
          backdropFilter: 'blur(20px) saturate(180%)',
          borderBottom: '1px solid var(--hairline)',
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 12px',
        }}>
          <Avatar name="Jon Singh" size="sm" />
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>Okta SSO provider behind feature flag</span>
            <span style={{ fontSize: 10.5, color: 'var(--gray-500)' }}><span className="mono">jon/sso-okta</span> · Jon Singh</span>
          </div>
          <span className="badge badge-orange">Changes requested</span>
          <div style={{ flex: 1 }} />
          <div className="btn"><Icon name="chevron-left" size={11}/></div>
          <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>9 / 9</span>
          <div className="btn"><Icon name="chevron-right" size={11}/></div>
          <div style={{ width: 1, height: 18, background: 'rgba(0,0,0,0.12)', margin: '0 6px' }}/>
          {/* Active button: Finish review (popover anchor) */}
          <div style={{ position: 'relative' }}>
            <div className="btn btn-success" style={{ boxShadow: '0 0 0 3px rgba(31,138,62,0.2)' }}>
              Finish review <Icon name="chevron-down" size={10} color="#fff"/>
            </div>
            {/* Popover */}
            <div style={{
              position: 'absolute', top: 36, right: 0, width: 480,
              background: '#fff',
              borderRadius: 10,
              boxShadow: 'var(--sh-pop)',
              overflow: 'hidden',
              zIndex: 10,
            }}>
              <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Finish review</div>
                <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>9 / 9 steps · 4 pending comments</div>
              </div>
              <div style={{ padding: '12px 16px' }}>
                <div style={{
                  background: '#fff',
                  border: '1px solid rgba(0,0,0,0.14)',
                  borderRadius: 'var(--r-md)',
                  padding: '10px 12px',
                  fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.5,
                  minHeight: 84,
                }}>
                  Overall this is solid. The feature flag and rollback path are convincing. Two asks before merge: tighten the timeout / abort story on token fetch, and add a smoke test for the disabled-flag path so we don't ship a half-wired provider behind the toggle.
                </div>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <B_PubRow icon="comment"      label="Comment"          sub="Submit feedback without an explicit approval." />
                  <B_PubRow icon="check-circle" label="Approve"          sub="Confirm this is ready to merge." color="var(--green-d)"/>
                  <B_PubRow icon="x-circle"     label="Request changes"  sub="Block merge. Your 4 comments will be posted." color="var(--orange)" active />
                </div>
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--gray-75)', borderRadius: 6 }}>
                  <input type="checkbox" defaultChecked style={{ accentColor: 'var(--blue)' }}/>
                  <span style={{ fontSize: 12, color: 'var(--gray-700)' }}>Also post to GitHub PR #482</span>
                  <div style={{ flex: 1 }}/>
                  <Icon name="gh" size={11} color="var(--gray-500)"/>
                </div>
              </div>
              <div style={{ padding: '10px 16px', borderTop: '1px solid var(--hairline)', display: 'flex', gap: 6, justifyContent: 'flex-end', background: 'var(--gray-50)' }}>
                <div className="btn"><Icon name="copy" size={10}/> Copy markdown</div>
                <div className="btn btn-ghost" style={{ color: 'var(--gray-700)', fontWeight: 500 }}>Cancel</div>
                <div className="btn" style={{ background: 'var(--orange)', color: '#fff', borderColor: 'rgba(0,0,0,0.10)' }}>
                  Submit · Request changes
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Ghosted underlying review (greyscale) */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0, filter: 'saturate(0.4)', opacity: 0.55 }}>
          <B_Sidebar width={220}>
            <B_SLLabel>Storyline</B_SLLabel>
            <div style={{ padding: '4px 8px' }}>
              {STORYLINE.slice(0, 5).map((s, i) => (
                <div key={s.step} style={{ display: 'flex', gap: 8, padding: '4px 4px', height: 30, alignItems: 'center' }}>
                  <div style={{ width: 16, height: 16, borderRadius: 8, background: 'var(--green-d)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✓</div>
                  <div style={{ fontSize: 12, color: 'var(--gray-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</div>
                </div>
              ))}
            </div>
          </B_Sidebar>
          <div style={{ flex: 1, background: 'var(--gray-50)', padding: 20 }}>
            <div style={{ background: '#fff', border: '1px solid var(--hairline)', borderRadius: 8, padding: 20, color: 'var(--gray-400)' }}>
              All steps reviewed.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function B_PubRow({ icon, label, sub, color, active }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 10px',
      borderRadius: 6,
      border: '1px solid ' + (active ? (color || 'var(--blue)') : 'transparent'),
      background: active ? 'rgba(255,149,0,0.06)' : 'transparent',
    }}>
      <div style={{
        width: 14, height: 14, borderRadius: 7, marginTop: 2, flex: '0 0 14px',
        border: '1.5px solid ' + (active ? (color || 'var(--blue)') : 'rgba(0,0,0,0.25)'),
        position: 'relative',
      }}>
        {active && <div style={{ position: 'absolute', inset: 2, borderRadius: 4, background: color || 'var(--blue)' }} />}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600 }}>
          <Icon name={icon} size={12} color={color || 'var(--gray-600)'}/>
          {label}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--gray-600)', marginTop: 2 }}>{sub}</div>
      </div>
    </div>
  );
}

Object.assign(window, { B_CreatePR, B_StorylineReview, B_PublishReview });
