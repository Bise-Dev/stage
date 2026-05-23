/* direction-a.jsx — "Quiet"
   Light neutrals, minimal chrome, single system-blue accent.
   Each screen renders inside a 1280×820 .stage frame. */

/* ─────────────────────────────────────────────────────────────
   A1 · Workspaces overview
   ───────────────────────────────────────────────────────────── */
function A_Workspaces() {
  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage" />
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Left rail: filters */}
          <div style={{ width: 200, borderRight: '1px solid var(--hairline)', padding: '14px 10px', background: '#fbfaf8' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px 8px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-700)' }}>Workspaces</div>
              <Icon name="plus" size={13} color="var(--gray-500)"/>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 6 }}>
              {[
                { label: 'All', count: 5, active: true },
                { label: 'Yours', count: 2 },
                { label: 'Assigned to you', count: 2 },
                { label: 'Drafts', count: 1 },
                { label: 'Approved', count: 1 },
              ].map(r => (
                <div key={r.label} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '5px 10px', borderRadius: 5,
                  background: r.active ? 'rgba(0,0,0,0.06)' : 'transparent',
                  color: 'var(--gray-800)', fontSize: 12.5, fontWeight: r.active ? 600 : 500,
                }}>
                  <span>{r.label}</span>
                  <span style={{ color: 'var(--gray-500)', fontSize: 11.5, fontWeight: 500 }}>{r.count}</span>
                </div>
              ))}
            </div>
            <div className="section-label" style={{ marginTop: 18, padding: '0 6px' }}>Repository</div>
            <div style={{ padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="folder" size={13} color="var(--gray-500)"/>
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>acme/payments</span>
            </div>
            <div style={{ padding: '0 10px 4px 28px', color: 'var(--gray-500)', fontSize: 11.5 }}>
              ~/code/acme-payments
            </div>
          </div>

          {/* Main: workspace cards */}
          <div style={{ flex: 1, padding: '18px 22px', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <div style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--gray-400)' }}>
                  <Icon name="search" size={13} />
                </div>
                <input className="input lg" placeholder="Search workspaces by branch, title or author…" style={{ paddingLeft: 28 }} />
              </div>
              <div className="seg">
                <div className="active">Active</div>
                <div>All</div>
                <div>Archived</div>
              </div>
              <div className="btn btn-primary btn-lg" style={{ gap: 6 }}>
                <Icon name="plus" size={12} color="#fff" />
                New workspace
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {WORKSPACES.map(w => <A_WorkspaceCard key={w.id} w={w} active={w.id === 'feat-checkout-v2'} />)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function A_WorkspaceCard({ w, active }) {
  const states = {
    'in-review': { label: 'In review', cls: 'badge-blue' },
    'draft':     { label: 'Draft',     cls: '' },
    'reviewing': { label: 'Reviewing', cls: 'badge-purple' },
    'requested': { label: 'Changes requested', cls: 'badge-orange' },
    'approved':  { label: 'Approved',  cls: 'badge-green' },
  };
  const st = states[w.state];
  return (
    <div style={{
      background: '#fff',
      border: '1px solid ' + (active ? 'rgba(0,122,255,0.5)' : 'var(--hairline)'),
      borderRadius: 'var(--r-lg)',
      padding: '12px 14px',
      boxShadow: active ? '0 0 0 3px var(--blue-tint)' : 'var(--sh-1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Icon name="branch" size={13} color="var(--gray-500)" />
            <span className="mono" style={{ fontSize: 12, color: 'var(--gray-700)', fontWeight: 500 }}>{w.branch}</span>
            <span className={'badge ' + st.cls}>{st.label}</span>
            {w.author !== 'You' && <Avatar name={w.author} size="sm" />}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--gray-900)', marginBottom: 6, letterSpacing: -0.01 }}>
            {w.title}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11.5, color: 'var(--gray-600)' }}>
            <span><span style={{ color: 'var(--green-d)', fontWeight: 600 }}>+{w.added}</span> <span style={{ color: 'var(--red-d)', fontWeight: 600, marginLeft: 4 }}>−{w.removed}</span></span>
            <span style={{ color: 'var(--gray-400)' }}>·</span>
            <span>{w.files} files</span>
            <span style={{ color: 'var(--gray-400)' }}>·</span>
            <span>{w.ahead} ahead, {w.behind} behind <span className="mono" style={{ color: 'var(--gray-500)' }}>{w.base}</span></span>
            {w.storyline > 0 && (<>
              <span style={{ color: 'var(--gray-400)' }}>·</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="doc-stack" size={11} color="var(--gray-500)" /> {w.storyline}-step storyline
              </span>
            </>)}
            {w.comments > 0 && (<>
              <span style={{ color: 'var(--gray-400)' }}>·</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="comment" size={11} color="var(--gray-500)" /> {w.comments}
              </span>
            </>)}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {w.reviewers.length > 0 && (
            <div style={{ display: 'flex' }}>
              {w.reviewers.map((r, i) => (
                <div key={r} style={{ marginLeft: i ? -6 : 0, border: '1.5px solid #fff', borderRadius: '50%' }}>
                  <Avatar name={r} size="sm" />
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 11.5, color: 'var(--gray-500)', minWidth: 56, textAlign: 'right' }}>{w.updated}</div>
        </div>
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────
   A2 · Local review (your own changes)
   ───────────────────────────────────────────────────────────── */
function A_LocalReview() {
  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage — feat/checkout-v2" />

        {/* Subheader */}
        <div style={{
          height: 52, flex: '0 0 52px',
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '0 16px', background: '#fff',
          borderBottom: '1px solid var(--hairline)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="badge" style={{ background: 'rgba(0,0,0,0.06)', fontFamily: 'var(--font-mono)' }}>main</span>
            <Icon name="arrow-right" size={11} color="var(--gray-400)"/>
            <span className="badge mono" style={{ background: 'var(--blue-tint)', color: 'var(--blue-press)' }}>feat/checkout-v2</span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-900)', letterSpacing: -0.01 }}>
              Replace legacy checkout with multi-step flow
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 1 }}>
              Local review · 11 files · <span style={{ color: 'var(--green-d)' }}>+412</span> <span style={{ color: 'var(--red-d)' }}>−87</span> · 6 of 11 files reviewed
            </div>
          </div>
          <div className="btn"><Icon name="sparkle" size={12} color="var(--purple)"/> Summarize</div>
          <div className="btn"><Icon name="copy" size={12} /> Copy as markdown</div>
          <div className="btn btn-primary"><Icon name="gh" size={12} color="#fff"/> Open PR…</div>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Files panel */}
          <div style={{ width: 260, flex: '0 0 260px', borderRight: '1px solid var(--hairline)', background: '#fbfaf8', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid var(--hairline-2)' }}>
              <input className="input" placeholder="Filter files…" />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px 4px' }}>
              <span className="section-label" style={{ padding: 0 }}>Files</span>
              <span style={{ fontSize: 10.5, color: 'var(--gray-500)', fontWeight: 600 }}>6/11 viewed</span>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', padding: '0 6px' }}>
              {FILES.map((f, i) => <A_FileRow key={f.path} f={f} active={i === 2} />)}
            </div>
            <div style={{ padding: '10px 12px', borderTop: '1px solid var(--hairline-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 11, color: 'var(--gray-500)', fontWeight: 600, letterSpacing: 0.04, textTransform: 'uppercase' }}>Summary</div>
              <div style={{ fontSize: 12, color: 'var(--gray-700)', lineHeight: 1.45 }}>
                Adds a 3-step checkout (address, payment, review) backed by a reducer. Payment is tokenized via Stripe Elements. Drops the old single-page form.
              </div>
              <div className="btn btn-ghost" style={{ alignSelf: 'flex-start', color: 'var(--blue)', fontWeight: 600, padding: 0, height: 18 }}>Regenerate</div>
            </div>
          </div>

          {/* Diff */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--gray-50)' }}>
            <div style={{
              height: 36, flex: '0 0 36px',
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '0 14px',
              borderBottom: '1px solid var(--hairline)', background: '#fff',
            }}>
              <span className="mono" style={{ fontSize: 12.5, color: 'var(--gray-800)', fontWeight: 500 }}>
                src/checkout/steps/PaymentStep.tsx
              </span>
              <span className="badge badge-green">added</span>
              <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>+84 −0</span>
              <div style={{ flex: 1 }} />
              <div className="seg">
                <div>Split</div>
                <div className="active">Unified</div>
              </div>
              <div className="btn"><Icon name="eye" size={11}/> Mark viewed</div>
            </div>

            <div style={{ flex: 1, overflow: 'hidden', padding: '12px 14px' }}>
              <div style={{ background: '#fff', border: '1px solid var(--hairline)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
                <DiffTable lines={DIFF_PAYMENT} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function A_FileRow({ f, active }) {
  const statusBadge = {
    added:    { ch: 'A', color: 'var(--green-d)' },
    modified: { ch: 'M', color: '#a08000' },
    removed:  { ch: 'D', color: 'var(--red-d)' },
    renamed:  { ch: 'R', color: 'var(--purple)' },
  }[f.status];
  const parts = f.path.split('/');
  const file = parts.pop();
  const dir = parts.join('/');
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 8px', borderRadius: 5, margin: '1px 0',
      background: active ? 'rgba(0,122,255,0.10)' : 'transparent',
      color: active ? 'var(--blue-press)' : 'var(--gray-800)',
    }}>
      <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: statusBadge.color, width: 12 }}>{statusBadge.ch}</span>
      <div style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: active ? 600 : 500 }}>{file}</div>
        {dir && <div style={{ fontSize: 10.5, color: active ? 'rgba(0,98,204,0.6)' : 'var(--gray-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dir}</div>}
      </div>
      {f.comments > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 10.5, color: active ? 'var(--blue-press)' : 'var(--gray-500)' }}>
          <Icon name="comment-fill" size={10} color={active ? 'var(--blue-press)' : 'var(--gray-400)'} />
          {f.comments}
        </span>
      )}
      <span style={{ fontSize: 10.5, color: active ? 'rgba(0,98,204,0.7)' : 'var(--gray-500)' }}>
        {f.add > 0 && <span style={{ color: active ? '#1f5fa8' : 'var(--green-d)' }}>+{f.add}</span>}
        {f.add > 0 && f.del > 0 && ' '}
        {f.del > 0 && <span style={{ color: active ? '#7a3530' : 'var(--red-d)' }}>−{f.del}</span>}
      </span>
      {f.viewed && <Icon name="check" size={10} color="var(--gray-500)" />}
    </div>
  );
}


Object.assign(window, { A_Workspaces, A_LocalReview });
