/* direction-b-1.jsx — Direction B "Source List"
   Denser, three-pane macOS-native pattern, translucent sidebar, more chrome.
*/

/* Shared: translucent source-list sidebar with vibrancy gradient */
function B_Sidebar({ children, width = 220 }) {
  return (
    <div style={{
      width, flex: '0 0 ' + width + 'px',
      borderRight: '1px solid var(--hairline)',
      background: 'linear-gradient(180deg, rgba(248,247,244,0.92) 0%, rgba(238,237,233,0.92) 100%)',
      backdropFilter: 'blur(20px) saturate(180%)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>{children}</div>
  );
}

function B_SLRow({ icon, label, count, active, indent = 0, color }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 10px', paddingLeft: 10 + indent * 14,
      borderRadius: 5, margin: '1px 6px', height: 26,
      background: active ? 'var(--blue)' : 'transparent',
      color: active ? '#fff' : 'var(--gray-800)',
      fontSize: 13,
      fontWeight: active ? 600 : 500,
    }}>
      {icon && (
        <span style={{ color: active ? 'rgba(255,255,255,0.95)' : (color || 'var(--gray-500)'), display: 'flex' }}>
          {icon}
        </span>
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {count !== undefined && (
        <span style={{
          fontSize: 11, fontWeight: 600,
          background: active ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.08)',
          color: active ? '#fff' : 'var(--gray-700)',
          padding: '1px 6px', borderRadius: 8,
        }}>{count}</span>
      )}
    </div>
  );
}

function B_SLLabel({ children, right }) {
  return (
    <div style={{
      padding: '14px 16px 4px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      fontSize: 10.5, fontWeight: 700, letterSpacing: 0.08,
      textTransform: 'uppercase', color: 'var(--gray-500)',
    }}>
      <span>{children}</span>{right}
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────
   B1 · Workspaces overview (three-pane)
   ───────────────────────────────────────────────────────────── */
function B_Workspaces() {
  const w = WORKSPACES[0];
  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage" vibrant
          right={<>
            <div className="btn btn-ghost"><Icon name="search" size={13}/></div>
            <div className="btn btn-ghost"><Icon name="gear" size={13}/></div>
          </>}
        />
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Source list */}
          <B_Sidebar width={220}>
            <B_SLLabel right={<Icon name="plus" size={11} color="var(--gray-500)"/>}>Repositories</B_SLLabel>
            <B_SLRow icon={<Icon name="folder" size={13}/>} label="acme/payments" count={5} active />
            <B_SLRow icon={<Icon name="folder" size={13}/>} label="acme/web" count={2} />
            <B_SLRow icon={<Icon name="folder" size={13}/>} label="acme/infra" />

            <B_SLLabel>Smart filters</B_SLLabel>
            <B_SLRow icon={<Icon name="dot-circle" size={13} color="var(--blue)"/>} label="In review" count={1} />
            <B_SLRow icon={<Icon name="dot-circle" size={13} color="var(--purple)"/>} label="Reviewing" count={1} />
            <B_SLRow icon={<Icon name="dot-circle" size={13} color="var(--orange)"/>} label="Changes requested" count={1} />
            <B_SLRow icon={<Icon name="dot-circle" size={13} color="var(--green)"/>} label="Approved" count={1} />
            <B_SLRow icon={<Icon name="file" size={13}/>} label="Drafts" count={1} />

            <B_SLLabel>People</B_SLLabel>
            <B_SLRow icon={<Avatar name="You" size="sm" />} label="You" />
            <B_SLRow icon={<Avatar name="Mira Park" size="sm" />} label="Mira Park" />
            <B_SLRow icon={<Avatar name="Jon Singh" size="sm" />} label="Jon Singh" />
            <B_SLRow icon={<Avatar name="Sam Okafor" size="sm" />} label="Sam Okafor" />
          </B_Sidebar>

          {/* Workspace list */}
          <div style={{
            width: 320, flex: '0 0 320px',
            borderRight: '1px solid var(--hairline)',
            background: '#fcfbfa',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid var(--hairline-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--gray-900)' }}>acme/payments</span>
                <span style={{ fontSize: 11, color: 'var(--gray-500)' }}>5 workspaces</span>
                <div style={{ flex: 1 }} />
                <Icon name="plus" size={13} color="var(--gray-500)"/>
              </div>
              <div style={{ marginTop: 6, position: 'relative' }}>
                <div style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--gray-400)' }}>
                  <Icon name="search" size={11}/>
                </div>
                <input className="input" placeholder="Filter workspaces" style={{ paddingLeft: 24 }} />
              </div>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', padding: '4px 0' }}>
              {WORKSPACES.map((w, i) => <B_WSListItem key={w.id} w={w} active={i === 0} />)}
            </div>
          </div>

          {/* Detail */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{
              height: 60, flex: '0 0 60px',
              padding: '10px 18px',
              borderBottom: '1px solid var(--hairline)',
              background: '#fff',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--gray-900)', letterSpacing: -0.01 }}>{w.title}</span>
                  <span className="badge badge-blue">In review</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, fontSize: 11.5, color: 'var(--gray-500)' }}>
                  <Icon name="branch" size={11}/>
                  <span className="mono">{w.branch}</span>
                  <span style={{ color: 'var(--gray-300)' }}>·</span>
                  <span>opened {w.updated}</span>
                </div>
              </div>
              <div className="btn"><Icon name="play" size={10} color="var(--gray-700)"/> Open workspace</div>
              <div className="btn btn-primary">Start local review</div>
            </div>

            <div style={{ flex: 1, overflow: 'hidden', padding: '14px 18px', background: 'var(--gray-50)' }}>
              {/* Stat tiles */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 12 }}>
                <B_Stat label="Files changed" value="11" sub="6 added · 4 modified · 1 deleted" />
                <B_Stat label="Lines" value={<span><span style={{color:'var(--green-d)'}}>+412</span> <span style={{color:'var(--red-d)'}}>−87</span></span>} sub="vs main" />
                <B_Stat label="Storyline" value="7 steps" sub="all files ordered" />
                <B_Stat label="Comments" value="6" sub="3 unresolved" />
              </div>

              {/* Recent activity */}
              <div style={{ background: '#fff', border: '1px solid var(--hairline)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--hairline-2)', fontSize: 12.5, fontWeight: 600 }}>Recent activity</div>
                {[
                  { who: 'Mira Park', what: 'commented on PaymentStep.tsx · L12', when: '14m ago' },
                  { who: 'Jon Singh', what: 'commented on state.ts · L28', when: '32m ago' },
                  { who: 'You', what: 'pushed 2 commits', when: '1h ago', icon: 'branch' },
                  { who: 'You', what: 'reordered storyline (3 ↔ 4)', when: '1h ago', icon: 'doc-stack' },
                  { who: 'Mira Park', what: 'added to storyline review', when: '3h ago', icon: 'eye' },
                ].map((a, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderTop: i ? '1px solid var(--hairline-2)' : 'none', fontSize: 12.5 }}>
                    <Avatar name={a.who} size="sm" />
                    <span style={{ fontWeight: 600 }}>{a.who}</span>
                    <span style={{ color: 'var(--gray-700)' }}>{a.what}</span>
                    <div style={{ flex: 1 }} />
                    <span style={{ color: 'var(--gray-500)', fontSize: 11.5 }}>{a.when}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function B_WSListItem({ w, active }) {
  const states = {
    'in-review': { dot: 'var(--blue)', label: 'In review' },
    'draft':     { dot: 'var(--gray-400)', label: 'Draft' },
    'reviewing': { dot: 'var(--purple)', label: 'Reviewing' },
    'requested': { dot: 'var(--orange)', label: 'Changes requested' },
    'approved':  { dot: 'var(--green)', label: 'Approved' },
  };
  const st = states[w.state];
  return (
    <div style={{
      padding: '8px 14px',
      borderBottom: '1px solid var(--hairline-2)',
      background: active ? 'var(--blue)' : 'transparent',
      color: active ? '#fff' : 'var(--gray-800)',
      cursor: 'default',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{
          width: 7, height: 7, borderRadius: 4,
          background: active ? '#fff' : st.dot,
        }}></span>
        <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {w.title}
        </span>
        <span style={{ fontSize: 10.5, opacity: 0.7 }}>{w.updated}</span>
      </div>
      <div className="mono" style={{ fontSize: 11, opacity: active ? 0.85 : 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {w.branch}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 11, opacity: active ? 0.92 : 0.7 }}>
        <span>{w.author}</span>
        <span>·</span>
        <span>+{w.added} −{w.removed}</span>
        <span>·</span>
        <span>{w.files} files</span>
        {w.comments > 0 && (<><span>·</span><span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Icon name="comment-fill" size={9} color={active ? '#fff' : 'var(--gray-500)'}/> {w.comments}</span></>)}
      </div>
    </div>
  );
}

function B_Stat({ label, value, sub }) {
  return (
    <div style={{ background: '#fff', border: '1px solid var(--hairline)', borderRadius: 'var(--r-md)', padding: '10px 12px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', color: 'var(--gray-500)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--gray-900)', letterSpacing: -0.02, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--gray-500)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────
   B2 · Local Review (three-pane: source-list | files | diff)
   ───────────────────────────────────────────────────────────── */
function B_LocalReview() {
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div className="btn btn-ghost"><Icon name="chevron-left" size={12} color="var(--gray-600)"/></div>
            <div className="btn btn-ghost"><Icon name="chevron-right" size={12} color="var(--gray-400)"/></div>
          </div>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: '#fff', borderRadius: 6, padding: '4px 10px',
            border: '1px solid rgba(0,0,0,0.08)',
            boxShadow: 'inset 0 1px 0 rgba(0,0,0,0.02)',
          }}>
            <Icon name="branch" size={12} color="var(--gray-500)"/>
            <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>feat/checkout-v2</span>
            <Icon name="chevron-down" size={11} color="var(--gray-500)"/>
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>vs <span className="mono">main</span></span>
          <div style={{ flex: 1 }} />
          <div className="seg" style={{ height: 28 }}>
            <div className="active">Diff</div>
            <div>Storyline</div>
            <div>Conversation</div>
          </div>
          <div style={{ flex: 1 }} />
          <div className="btn"><Icon name="sparkle" size={11} color="var(--purple)"/> Summarize</div>
          <div className="btn"><Icon name="copy" size={11}/> Copy</div>
          <div className="btn btn-success"><Icon name="gh" size={11} color="#fff"/> Open PR</div>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Source list: workspaces */}
          <B_Sidebar width={180}>
            <B_SLLabel>Workspaces</B_SLLabel>
            <B_SLRow icon={<Icon name="dot-circle" size={11} color="var(--blue)"/>} label="checkout-v2" active />
            <B_SLRow icon={<Icon name="dot-circle" size={11} color="var(--gray-400)"/>} label="stripe-webhook" />
            <B_SLLabel>Reviewing</B_SLLabel>
            <B_SLRow icon={<Icon name="dot-circle" size={11} color="var(--orange)"/>} label="jon/sso-okta" count={4} />
            <B_SLRow icon={<Icon name="dot-circle" size={11} color="var(--purple)"/>} label="mira/dashboard" count={3} />
          </B_Sidebar>

          {/* Files */}
          <div style={{ width: 280, flex: '0 0 280px', borderRight: '1px solid var(--hairline)', background: '#fcfbfa', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--hairline-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--gray-800)' }}>11 files</span>
              <span style={{ fontSize: 11, color: 'var(--gray-500)' }}>
                <span style={{ color: 'var(--green-d)' }}>+412</span>{' '}
                <span style={{ color: 'var(--red-d)' }}>−87</span>
              </span>
              <div style={{ flex: 1 }} />
              <Icon name="menu" size={12} color="var(--gray-500)"/>
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {FILES.map((f, i) => <B_FileRow key={f.path} f={f} active={i === 2} />)}
            </div>
          </div>

          {/* Diff */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--gray-50)' }}>
            <div style={{
              padding: '8px 16px',
              background: '#fff',
              borderBottom: '1px solid var(--hairline)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span className="badge badge-green">A</span>
              <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>src/checkout/steps/PaymentStep.tsx</span>
              <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>+84 −0</span>
              <div style={{ flex: 1 }} />
              <div className="seg" style={{ height: 22 }}>
                <div>Split</div>
                <div className="active">Unified</div>
              </div>
              <div className="btn"><Icon name="eye" size={11}/> Viewed</div>
            </div>

            <div style={{ flex: 1, overflow: 'hidden' }}>
              <table className="diff" style={{ background: '#fff' }}>
                <tbody>
                  {DIFF_PAYMENT.map((l, i) => renderDiffRow(l, i))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function B_FileRow({ f, active }) {
  const ch = { added: 'A', modified: 'M', removed: 'D', renamed: 'R' }[f.status];
  const chColor = { added: 'var(--green-d)', modified: '#a08000', removed: 'var(--red-d)', renamed: 'var(--purple)' }[f.status];
  const parts = f.path.split('/'); const file = parts.pop(); const dir = parts.join('/');
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7,
      padding: '5px 12px',
      background: active ? 'var(--blue)' : 'transparent',
      color: active ? '#fff' : 'var(--gray-800)',
      borderBottom: '1px solid ' + (active ? 'transparent' : 'var(--hairline-2)'),
    }}>
      <span className="mono" style={{
        fontSize: 10, fontWeight: 700,
        color: active ? '#fff' : chColor,
        width: 14, height: 14, borderRadius: 3,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: active ? 'rgba(255,255,255,0.22)' : 'transparent',
        border: active ? 'none' : '1px solid ' + chColor + '55',
      }}>{ch}</span>
      <div style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: active ? 600 : 500 }}>{file}</div>
        {dir && <div style={{ fontSize: 10.5, opacity: active ? 0.85 : 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dir}</div>}
      </div>
      {f.comments > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 10.5, opacity: active ? 1 : 0.6 }}>
        <Icon name="comment-fill" size={9} color={active ? '#fff' : 'var(--gray-500)'} />{f.comments}
      </span>}
      <span style={{ fontSize: 10.5, opacity: active ? 0.9 : 0.7 }}>
        {f.add > 0 && <span style={{ color: active ? '#fff' : 'var(--green-d)' }}>+{f.add}</span>}
        {f.add > 0 && f.del > 0 && ' '}
        {f.del > 0 && <span style={{ color: active ? 'rgba(255,255,255,0.92)' : 'var(--red-d)' }}>−{f.del}</span>}
      </span>
    </div>
  );
}


Object.assign(window, { B_Workspaces, B_LocalReview, B_Sidebar, B_SLRow, B_SLLabel });
