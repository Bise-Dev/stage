/* direction-a-2.jsx — Direction A: Create PR, Storyline Review, Publish Review */

/* ─────────────────────────────────────────────────────────────
   A3 · Create PR — write description + order files + intro comments
   ───────────────────────────────────────────────────────────── */
function A_CreatePR() {
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
            <Icon name="gh" size={13} color="var(--gray-700)" />
            <span style={{ fontSize: 12.5, color: 'var(--gray-700)', fontWeight: 500 }}>acme/payments</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="badge mono" style={{ background: 'rgba(0,0,0,0.06)' }}>main</span>
            <Icon name="arrow-right" size={11} color="var(--gray-400)" />
            <span className="badge mono" style={{ background: 'var(--blue-tint)', color: 'var(--blue-press)' }}>feat/checkout-v2</span>
          </div>
          <div style={{ flex: 1 }} />
          <div className="btn">Save draft</div>
          <div className="btn btn-primary"><Icon name="arrow-up-right" size={11} color="#fff" /> Open on GitHub</div>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Left: editor */}
          <div style={{ flex: 1, minWidth: 0, padding: '18px 22px', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray-500)', letterSpacing: 0.06, textTransform: 'uppercase' }}>Title</label>
              <input className="input lg" defaultValue="Replace legacy checkout with multi-step flow" style={{ marginTop: 6, fontWeight: 600, fontSize: 14 }} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray-500)', letterSpacing: 0.06, textTransform: 'uppercase' }}>Description</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <div className="seg">
                    <div className="active">Write</div>
                    <div>Preview</div>
                  </div>
                  <div className="btn"><Icon name="sparkle" size={11} color="var(--purple)"/> From storyline</div>
                </div>
              </div>
              <div style={{
                flex: 1, background: '#fff', border: '1px solid rgba(0,0,0,0.14)',
                borderRadius: 'var(--r-md)', padding: '12px 14px', fontSize: 13,
                color: 'var(--gray-800)', lineHeight: 1.55, overflow: 'hidden',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-900)' }}>## Summary</div>
                <div style={{ marginTop: 4 }}>
                  Replaces the single-page checkout form with a three-step flow (address → payment → review), driven by a new reducer in <span className="mono" style={{ background: 'rgba(0,0,0,0.05)', padding: '0 4px', borderRadius: 3 }}>src/checkout/state.ts</span>. Payment uses Stripe Elements tokenization end-to-end; we never see raw card data.
                </div>
                <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600, color: 'var(--gray-900)' }}>## Why</div>
                <div style={{ marginTop: 4 }}>
                  Conversion drops 18% at the long-form step. The new flow shortens perceived work and lets us A/B per-step copy without a redeploy.
                </div>
                <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600, color: 'var(--gray-900)' }}>## Reviewer storyline</div>
                <div style={{ marginTop: 4, color: 'var(--gray-500)', fontSize: 12 }}>
                  Auto-rendered from the 7 ordered files on the right. Each step shows your intro comment above the diff.
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray-500)', letterSpacing: 0.06, textTransform: 'uppercase' }}>Reviewers</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid rgba(0,0,0,0.14)', borderRadius: 'var(--r-sm)', padding: '5px 8px', height: 30 }}>
                  <Avatar name="Mira Park" size="sm" /><span style={{ fontSize: 12.5 }}>Mira Park</span>
                  <span style={{ color: 'var(--gray-300)' }}>·</span>
                  <Avatar name="Jon Singh" size="sm" /><span style={{ fontSize: 12.5 }}>Jon Singh</span>
                  <div style={{ flex: 1 }} />
                  <Icon name="plus" size={12} color="var(--gray-500)" />
                </div>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray-500)', letterSpacing: 0.06, textTransform: 'uppercase' }}>Labels</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid rgba(0,0,0,0.14)', borderRadius: 'var(--r-sm)', padding: '5px 8px', height: 30 }}>
                  <span className="badge badge-blue">checkout</span>
                  <span className="badge badge-orange">needs-design-review</span>
                </div>
              </div>
            </div>
          </div>

          {/* Right: storyline composer */}
          <div style={{ width: 420, flex: '0 0 420px', borderLeft: '1px solid var(--hairline)', background: '#fbfaf8', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '14px 16px 8px', borderBottom: '1px solid var(--hairline-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="doc-stack" size={13} color="var(--gray-700)" />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-900)' }}>Reviewer storyline</span>
                <span className="badge">7 steps</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 4 }}>
                Drag to reorder. Reviewers walk through one step at a time, seeing your intro before each diff.
              </div>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', padding: '8px 10px 12px' }}>
              {STORYLINE.map((s, i) => (
                <A_StorylineStep key={s.step} s={s} active={i === 3} dragging={i === 3} />
              ))}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: 10, border: '1px dashed rgba(0,0,0,0.18)', borderRadius: 'var(--r-md)',
                color: 'var(--gray-500)', fontSize: 12, marginTop: 4,
              }}>
                <Icon name="plus" size={11} color="var(--gray-500)" /> Add unordered files to storyline (4 remaining)
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function A_StorylineStep({ s, active, dragging }) {
  return (
    <div style={{
      display: 'flex', gap: 8, padding: '8px 8px 10px',
      borderRadius: 'var(--r-md)',
      background: active ? '#fff' : 'transparent',
      boxShadow: active ? 'var(--sh-2)' : 'none',
      border: active ? '1px solid rgba(0,122,255,0.4)' : '1px solid transparent',
      margin: '1px 0',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 1, opacity: dragging ? 1 : 0.5 }}>
        <Icon name="grip" size={11} color="var(--gray-400)" />
      </div>
      <div style={{
        width: 20, height: 20, borderRadius: 10, flex: '0 0 20px',
        background: active ? 'var(--blue)' : 'var(--gray-200)',
        color: active ? '#fff' : 'var(--gray-700)',
        fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginTop: 1,
      }}>{s.step}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gray-900)' }}>{s.title}</span>
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--gray-500)', marginTop: 1 }}>{s.file}</div>
        <div style={{
          marginTop: 6, fontSize: 12, color: active ? 'var(--gray-800)' : 'var(--gray-600)',
          lineHeight: 1.4,
          background: active ? 'rgba(0,122,255,0.06)' : 'rgba(0,0,0,0.03)',
          padding: '6px 8px', borderRadius: 5,
          borderLeft: '2px solid ' + (active ? 'var(--blue)' : 'var(--gray-300)'),
        }}>{s.intro}</div>
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────
   A4 · Storyline review (reviewing someone else's PR — one step at a time)
   ───────────────────────────────────────────────────────────── */
function A_StorylineReview() {
  // Showing step 4 (PaymentStep.tsx) with comments
  const step = STORYLINE[3];
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
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 1 }}>
              Jon Singh · <span className="mono">jon/sso-okta</span> → <span className="mono">main</span> · 19 files · <span style={{ color: 'var(--green-d)' }}>+731</span> <span style={{ color: 'var(--red-d)' }}>−14</span>
            </div>
          </div>
          <div className="btn"><Icon name="open-window" size={11}/> Outline</div>
          <div className="btn btn-primary"><Icon name="check" size={11} color="#fff"/> Finish review</div>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Storyline outline */}
          <div style={{ width: 240, flex: '0 0 240px', borderRight: '1px solid var(--hairline)', background: '#fbfaf8', padding: '12px 8px' }}>
            <div className="section-label" style={{ paddingLeft: 12, marginBottom: 6 }}>Storyline · 4/9</div>
            {STORYLINE.map((s, i) => (
              <div key={s.step} style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 10px',
                borderRadius: 5, fontSize: 12.5, margin: '1px 0',
                background: i === 3 ? 'rgba(0,122,255,0.10)' : 'transparent',
                color: i === 3 ? 'var(--blue-press)' : (i < 3 ? 'var(--gray-500)' : 'var(--gray-800)'),
                fontWeight: i === 3 ? 600 : 500,
              }}>
                <div style={{
                  width: 16, height: 16, borderRadius: 8, flex: '0 0 16px',
                  fontSize: 10, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: i < 3 ? 'var(--green-d)' : (i === 3 ? 'var(--blue)' : 'rgba(0,0,0,0.10)'),
                  color: i <= 3 ? '#fff' : 'var(--gray-700)',
                }}>{i < 3 ? '✓' : s.step}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</div>
                  <div className="mono" style={{ fontSize: 10, color: i === 3 ? 'rgba(0,98,204,0.7)' : 'var(--gray-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{s.file.split('/').pop()}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Center: intro + diff */}
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
                  <span style={{ fontWeight: 600 }}>Jon’s note:</span> {step.intro}
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
                {/* Diff with inline comment */}
                <table className="diff">
                  <tbody>
                    {DIFF_PAYMENT.slice(0, 8).map((l, i) => renderDiffRow(l, i))}
                    {/* Comment threaded inline after line 12 */}
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
                    background: i < 3 ? 'var(--green-d)' : i === 3 ? 'var(--blue)' : 'rgba(0,0,0,0.10)',
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

function renderDiffRow(l, i) {
  if (l.kind === 'hunk') {
    return <tr key={i} className="hunk"><td colSpan="4">{l.text}</td></tr>;
  }
  const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
  return (
    <tr key={i} className={l.kind}>
      <td className="ln">{l.n1 ?? ''}</td>
      <td className="ln">{l.n2 ?? ''}</td>
      <td className="sign">{sign}</td>
      <td className="src"><Code text={l.text} /></td>
    </tr>
  );
}


/* ─────────────────────────────────────────────────────────────
   A5 · Publish review — summary sheet with approve / request / comment
   ───────────────────────────────────────────────────────────── */
function A_PublishReview() {
  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage — Reviewing jon/sso-okta" />

        {/* Dimmed background showing the review context */}
        <div style={{
          flex: 1, position: 'relative',
          background: 'var(--gray-100)',
          overflow: 'hidden',
        }}>
          {/* Underlying ghost UI */}
          <div style={{ filter: 'blur(2px) saturate(0.6)', opacity: 0.45, height: '100%' }}>
            <div style={{ height: 56, background: '#fff', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px' }}>
              <Avatar name="Jon Singh" />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Okta SSO provider behind feature flag</div>
                <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>9 of 9 steps reviewed</div>
              </div>
            </div>
            <div style={{ padding: 20, color: 'var(--gray-400)' }}>·····</div>
          </div>

          {/* Sheet */}
          <div style={{
            position: 'absolute', top: 32, left: '50%',
            transform: 'translateX(-50%)',
            width: 600,
            background: '#fff',
            borderRadius: 12,
            boxShadow: 'var(--sh-pop)',
            overflow: 'hidden',
          }}>
            <div style={{ padding: '16px 22px 12px', borderBottom: '1px solid var(--hairline)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 14, background: 'var(--blue-tint)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Icon name="check" size={14} color="var(--blue)"/>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--gray-900)', letterSpacing: -0.01 }}>Finish review</div>
                  <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 1 }}>
                    9 of 9 storyline steps reviewed · 4 pending comments · 0 unresolved
                  </div>
                </div>
                <div style={{ fontSize: 18, color: 'var(--gray-400)', fontWeight: 300, cursor: 'default' }}>×</div>
              </div>
            </div>

            <div style={{ padding: '14px 22px' }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray-500)', letterSpacing: 0.06, textTransform: 'uppercase' }}>Summary</label>
              <div style={{
                marginTop: 6,
                background: '#fff',
                border: '1px solid rgba(0,0,0,0.14)',
                borderRadius: 'var(--r-md)',
                padding: '10px 12px',
                fontSize: 13, color: 'var(--gray-800)', lineHeight: 1.5,
                minHeight: 90,
              }}>
                Overall this is solid. The feature flag and rollback path are convincing. A couple of asks: please tighten the timeout / abort story on token fetch, and add a smoke test for the disabled-flag path so we don't ship a half-wired provider behind the toggle.
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--gray-500)', textAlign: 'right' }}>Will be posted as the top-level review comment.</div>

              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <A_ReviewRadio
                  selected
                  icon={<Icon name="x-circle" size={14} color="var(--orange)"/>}
                  label="Request changes"
                  sub="Block merge. 4 comments will be published."
                  color="var(--orange)"
                />
                <A_ReviewRadio
                  icon={<Icon name="comment" size={14} color="var(--gray-600)"/>}
                  label="Comment"
                  sub="Submit feedback without an explicit approval."
                />
                <A_ReviewRadio
                  icon={<Icon name="check-circle" size={14} color="var(--green-d)"/>}
                  label="Approve"
                  sub="Confirm this is ready to merge."
                  color="var(--green-d)"
                />
              </div>

              <div style={{ marginTop: 12, padding: '8px 10px', background: 'rgba(0,0,0,0.04)', borderRadius: 'var(--r-md)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" defaultChecked style={{ accentColor: 'var(--blue)' }} />
                <span style={{ fontSize: 12.5, color: 'var(--gray-700)' }}>Publish to GitHub and post inline comments on the PR</span>
              </div>
            </div>

            <div style={{ padding: '12px 22px', borderTop: '1px solid var(--hairline)', display: 'flex', gap: 8, justifyContent: 'flex-end', background: 'var(--gray-50)' }}>
              <div className="btn">Cancel</div>
              <div className="btn">Copy as markdown</div>
              <div className="btn btn-primary" style={{ background: 'var(--orange)', color: '#fff' }}>
                Request changes
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function A_ReviewRadio({ selected, icon, label, sub, color }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '10px 12px',
      borderRadius: 'var(--r-md)',
      border: '1px solid ' + (selected ? (color || 'var(--blue)') : 'rgba(0,0,0,0.12)'),
      background: selected ? 'rgba(255,149,0,0.06)' : '#fff',
      boxShadow: selected ? '0 0 0 3px rgba(255,149,0,0.10)' : 'none',
    }}>
      <div style={{
        width: 16, height: 16, borderRadius: 8, marginTop: 1,
        border: '1.5px solid ' + (selected ? (color || 'var(--blue)') : 'rgba(0,0,0,0.25)'),
        flex: '0 0 16px', position: 'relative',
      }}>
        {selected && <div style={{ position: 'absolute', inset: 3, borderRadius: 5, background: color || 'var(--blue)' }} />}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--gray-900)' }}>
          {icon} {label}
        </div>
        <div style={{ fontSize: 12, color: 'var(--gray-600)', marginTop: 2 }}>{sub}</div>
      </div>
    </div>
  );
}


Object.assign(window, { A_CreatePR, A_StorylineReview, A_PublishReview, renderDiffRow });
