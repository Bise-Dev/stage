/* screens-v2-publish.jsx — Simplified publish review */

function V2_PublishReview() {
  const comments = [
    { file: 'PaymentStep.tsx',  line: 12, kind: 'blocking',   text: 'Should we set a timeout on tokenize()? On flaky networks this just hangs.' },
    { file: 'state.ts',         line: 28, kind: 'nit',        text: 'Naming: STORE_PAYMENT_TOKEN matches the rest of the file.' },
    { file: 'okta-provider.ts', line: 41, kind: 'blocking',   text: 'Missing smoke test for the disabled-flag path before we merge.' },
    { file: 'okta-provider.ts', line: 88, kind: 'suggestion', text: 'Consider extracting the redirect-uri builder so we can reuse it for SAML later.' },
  ];

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage — Reviewing jon/sso-okta" />

        <div style={{
          flex: 1, position: 'relative',
          background: 'var(--gray-100)',
          overflow: 'hidden',
        }}>
          {/* Ghosted underlying UI */}
          <div style={{ filter: 'blur(2px) saturate(0.6)', opacity: 0.35, height: '100%' }}>
            <div style={{ height: 56, background: '#fff', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px' }}>
              <Avatar name="Jon Singh" />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Okta SSO provider behind feature flag</div>
                <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>9 of 9 steps reviewed</div>
              </div>
            </div>
          </div>

          {/* Sheet */}
          <div style={{
            position: 'absolute', top: 32, left: '50%',
            transform: 'translateX(-50%)',
            width: 560,
            background: '#fff',
            borderRadius: 12,
            boxShadow: 'var(--sh-pop)',
            overflow: 'hidden',
          }}>
            {/* Header */}
            <div style={{ padding: '16px 22px 14px', borderBottom: '1px solid var(--hairline)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--gray-900)', letterSpacing: -0.01, flex: 1 }}>Finish review</div>
                <div style={{ fontSize: 18, color: 'var(--gray-400)', fontWeight: 300, cursor: 'default' }}>×</div>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--gray-600)', marginTop: 4, lineHeight: 1.5 }}>
                <span style={{ fontWeight: 600, color: 'var(--gray-800)' }}>Okta SSO provider behind feature flag</span>{' '}
                <span className="mono" style={{ color: 'var(--gray-500)' }}>· jon/sso-okta</span>
              </div>
            </div>

            {/* At-a-glance summary */}
            <div style={{ padding: '14px 22px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, borderBottom: '1px solid var(--hairline)' }}>
              <V2_SumStat value="9 / 9" label="steps reviewed" tone="ok" />
              <V2_SumStat value="2"      label="blocking"       tone="bad" />
              <V2_SumStat value="1"      label="suggestion"     tone="neutral" />
              <V2_SumStat value="1"      label="nit"            tone="neutral" />
            </div>

            {/* Comment preview */}
            <div style={{ padding: '12px 22px 16px', borderBottom: '1px solid var(--hairline)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray-500)', letterSpacing: 0.06, textTransform: 'uppercase' }}>
                  4 comments will be posted
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--blue)', fontWeight: 500 }}>Reorder…</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {comments.map((c, i) => (
                  <V2_CommentMini key={i} c={c} />
                ))}
              </div>
            </div>

            {/* Review state pills */}
            <div style={{ padding: '14px 22px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray-500)', letterSpacing: 0.06, textTransform: 'uppercase', marginBottom: 8 }}>
                Submit as
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <V2_StatePill icon="comment"      label="Comment" />
                <V2_StatePill icon="check-circle" label="Approve" color="var(--green-d)" />
                <V2_StatePill icon="x-circle"     label="Request changes" color="var(--orange)" active />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, padding: '8px 10px', background: 'var(--gray-75)', borderRadius: 6 }}>
                <input type="checkbox" defaultChecked style={{ accentColor: 'var(--blue)' }}/>
                <span style={{ fontSize: 12.5, color: 'var(--gray-700)' }}>Also post to GitHub PR #479</span>
                <div style={{ flex: 1 }}/>
                <Icon name="gh" size={11} color="var(--gray-500)"/>
              </div>
            </div>

            <div style={{ padding: '12px 22px', borderTop: '1px solid var(--hairline)', display: 'flex', gap: 8, justifyContent: 'flex-end', background: 'var(--gray-50)' }}>
              <div className="btn"><Icon name="copy" size={10}/> Copy as markdown</div>
              <div style={{ flex: 1 }}/>
              <div className="btn">Cancel</div>
              <div className="btn" style={{ background: 'var(--orange)', color: '#fff', borderColor: 'rgba(0,0,0,0.10)' }}>
                Request changes
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function V2_SumStat({ value, label, tone }) {
  const color = tone === 'ok' ? 'var(--green-d)' : tone === 'bad' ? 'var(--orange)' : 'var(--gray-800)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
      <span style={{ fontSize: 22, fontWeight: 700, color, letterSpacing: -0.02, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      <span style={{ fontSize: 11, color: 'var(--gray-500)' }}>{label}</span>
    </div>
  );
}

function V2_CommentMini({ c }) {
  const tones = {
    blocking:   { color: 'var(--orange)',  label: 'blocking' },
    suggestion: { color: 'var(--blue)',    label: 'suggestion' },
    nit:        { color: 'var(--gray-500)', label: 'nit' },
  };
  const t = tones[c.kind];
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 10px',
      background: '#fff',
      border: '1px solid var(--hairline)',
      borderLeft: '3px solid ' + t.color,
      borderRadius: 'var(--r-md)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--gray-700)', fontWeight: 500 }}>{c.file}</span>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--gray-500)' }}>:{c.line}</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: t.color, textTransform: 'uppercase', letterSpacing: 0.04 }}>{t.label}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--gray-700)', lineHeight: 1.45, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical' }}>
          {c.text}
        </div>
      </div>
    </div>
  );
}

function V2_StatePill({ icon, label, color, active }) {
  return (
    <div style={{
      flex: 1,
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      padding: '8px 10px',
      borderRadius: 'var(--r-md)',
      border: '1px solid ' + (active ? (color || 'var(--blue)') : 'rgba(0,0,0,0.12)'),
      background: active ? (color || 'var(--blue)') : '#fff',
      color: active ? '#fff' : 'var(--gray-800)',
      fontSize: 12.5,
      fontWeight: 600,
      boxShadow: active ? '0 1px 0 rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.25)' : 'none',
    }}>
      <Icon name={icon} size={12} color={active ? '#fff' : (color || 'var(--gray-600)')}/>
      {label}
    </div>
  );
}

Object.assign(window, { V2_PublishReview });
