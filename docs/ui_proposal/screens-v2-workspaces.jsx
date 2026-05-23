/* screens-v2-workspaces.jsx — v2: authored vs awaiting-review primary axis
   Two columns: "Authored by you" / "Awaiting your review".
   Four sub-buckets total: Branches, Local review, Public review, Open PRs (no workspace).
*/

function V2_Workspaces() {
  const branches    = BRANCHES_V2.filter(w => w.kind === 'branch');
  const locals      = BRANCHES_V2.filter(w => w.kind === 'local');
  const publics     = BRANCHES_V2.filter(w => w.kind === 'public');
  const externalsMe = EXTERNAL_PRS.filter(p => p.role === 'author');
  const externalsRv = EXTERNAL_PRS.filter(p => p.role === 'reviewer');

  const yoursBranches = branches.filter(b => b.author === 'You');
  const yoursLocals   = locals.filter(w => w.author === 'You');
  const yoursPublics  = publics.filter(w => w.author === 'You');
  const reviewPublics = publics.filter(w => w.author !== 'You');

  const yoursCount  = yoursBranches.length + yoursLocals.length + yoursPublics.length + externalsMe.length;
  const reviewCount = reviewPublics.length + externalsRv.length;

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage" />
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

          {/* Left filter rail */}
          <div style={{ width: 200, flex: '0 0 200px', borderRight: '1px solid var(--hairline)', padding: '14px 10px', background: '#fbfaf8', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px 8px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-700)' }}>Workspaces</div>
              <Icon name="plus" size={13} color="var(--gray-500)"/>
            </div>

            <div className="section-label" style={{ padding: '0 6px' }}>Show</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <V2_FilterRow label="Everything" count={yoursCount + reviewCount} active />
              <V2_FilterRow label="Authored by you"      count={yoursCount}  dot="var(--blue)" />
              <V2_FilterRow label="Awaiting your review" count={reviewCount} dot="var(--orange)" />
            </div>

            <div className="section-label" style={{ marginTop: 14, padding: '0 6px' }}>Filter by kind</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <V2_FilterRow icon={<Icon name="branch" size={11}/>} label="Branches"      count={branches.length} sub="no workspace" />
              <V2_FilterRow icon={<Icon name="play"   size={11}/>} label="Local review"  count={locals.length}   sub="not on GitHub" />
              <V2_FilterRow icon={<Icon name="doc-stack" size={11}/>} label="Public review" count={publics.length} sub="workspace + PR" />
              <V2_FilterRow icon={<Icon name="gh"     size={11}/>} label="Open PRs"      count={EXTERNAL_PRS.length} sub="no workspace yet" />
            </div>

            <div style={{ flex: 1 }}/>

            <div className="section-label" style={{ marginTop: 14, padding: '0 6px' }}>Repository</div>
            <div style={{ padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="folder" size={13} color="var(--gray-500)"/>
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>acme/payments</span>
            </div>
            <div style={{ padding: '0 10px 4px 28px', color: 'var(--gray-500)', fontSize: 11 }}>
              ~/code/acme-payments
            </div>
          </div>

          {/* Main */}
          <div style={{ flex: 1, padding: '14px 18px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <div style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--gray-400)' }}>
                  <Icon name="search" size={13} />
                </div>
                <input className="input lg" placeholder="Search by branch, title, author or PR #…" style={{ paddingLeft: 28 }} />
              </div>
              <div className="btn btn-lg"><Icon name="branch" size={12} color="var(--gray-700)"/> Fetch</div>
              <div className="btn btn-lg"><Icon name="gh" size={12} color="var(--gray-700)"/> Import PR</div>
              <div className="btn btn-primary btn-lg"><Icon name="plus" size={12} color="#fff" /> New workspace</div>
            </div>

            {/* Two columns: yours / awaiting review */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, flex: 1, minHeight: 0 }}>

              {/* AUTHORED BY YOU */}
              <V2_Column
                icon={<Avatar name="You" size="md" />}
                title="Authored by you"
                count={yoursCount}
                tint="rgba(0,122,255,0.04)"
                border="rgba(0,122,255,0.16)"
                accent="var(--blue)"
              >
                {yoursBranches.length > 0 && (
                  <V2_Bucket color="var(--gray-400)" title="Branches" hint="no workspace" count={yoursBranches.length}>
                    {yoursBranches.map(b => <V2_BranchRowCompact key={b.id} b={b} />)}
                  </V2_Bucket>
                )}
                {yoursLocals.length > 0 && (
                  <V2_Bucket color="var(--blue)" title="Local review" hint="not on GitHub" count={yoursLocals.length}>
                    {yoursLocals.map(w => <V2_WorkspaceRowCompact key={w.id} w={w} active={w.id === 'ws-eslint-bump'} />)}
                  </V2_Bucket>
                )}
                {yoursPublics.length > 0 && (
                  <V2_Bucket color="var(--purple)" title="Public review" hint="workspace + PR" count={yoursPublics.length}>
                    {yoursPublics.map(w => <V2_WorkspaceRowCompact key={w.id} w={w} />)}
                  </V2_Bucket>
                )}
                {externalsMe.length > 0 && (
                  <V2_Bucket color="var(--orange)" title="Open PRs" hint="on GitHub, no workspace yet" count={externalsMe.length}>
                    {externalsMe.map(p => <V2_ExternalRowCompact key={p.id} p={p} />)}
                  </V2_Bucket>
                )}
              </V2_Column>

              {/* AWAITING YOUR REVIEW */}
              <V2_Column
                icon={<div style={{ width: 28, height: 28, borderRadius: 14, background: 'rgba(255,149,0,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="eye" size={14} color="var(--orange)"/></div>}
                title="Awaiting your review"
                count={reviewCount}
                tint="rgba(255,149,0,0.04)"
                border="rgba(255,149,0,0.18)"
                accent="var(--orange)"
              >
                {reviewPublics.length > 0 && (
                  <V2_Bucket color="var(--purple)" title="Public review" hint="workspace + PR" count={reviewPublics.length}>
                    {reviewPublics.map(w => <V2_WorkspaceRowCompact key={w.id} w={w} reviewing />)}
                  </V2_Bucket>
                )}
                {externalsRv.length > 0 && (
                  <V2_Bucket color="var(--orange)" title="Open PRs" hint="on GitHub, no workspace yet" count={externalsRv.length}>
                    {externalsRv.map(p => <V2_ExternalRowCompact key={p.id} p={p} reviewing />)}
                  </V2_Bucket>
                )}
              </V2_Column>

            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


function V2_FilterRow({ label, count, active, dot, sub, icon }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '5px 10px', borderRadius: 5,
      background: active ? 'rgba(0,0,0,0.06)' : 'transparent',
      color: 'var(--gray-800)', fontSize: 12.5,
      fontWeight: active ? 600 : 500,
    }}>
      {dot && <span style={{ width: 7, height: 7, borderRadius: 4, background: dot, flex: '0 0 7px' }}/>}
      {icon && <span style={{ color: 'var(--gray-500)', display: 'flex' }}>{icon}</span>}
      {!dot && !icon && <span style={{ width: 7, height: 7, flex: '0 0 7px' }}/>}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {sub && <span style={{ fontSize: 10.5, color: 'var(--gray-400)', fontWeight: 500 }}>{sub}</span>}
      <span style={{ color: 'var(--gray-500)', fontSize: 11.5, fontWeight: 500, marginLeft: 4 }}>{count}</span>
    </div>
  );
}


function V2_Column({ icon, title, count, tint, border, accent, children }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      minWidth: 0, minHeight: 0,
      background: tint,
      border: '1px solid ' + border,
      borderRadius: 'var(--r-lg)',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '12px 14px',
        background: '#fff',
        borderBottom: '1px solid ' + border,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        {icon}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: -0.01, color: 'var(--gray-900)' }}>{title}</div>
          <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 1 }}>{count} item{count === 1 ? '' : 's'}</div>
        </div>
        <span style={{ width: 6, height: 24, borderRadius: 3, background: accent }}/>
      </div>
      <div style={{
        flex: 1, minHeight: 0,
        overflow: 'hidden',
        padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>{children}</div>
    </div>
  );
}


function V2_Bucket({ color, title, hint, count, children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, paddingLeft: 2 }}>
        <span style={{ width: 7, height: 7, borderRadius: 4, background: color }}/>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--gray-800)', letterSpacing: 0.02 }}>{title}</span>
        <span style={{ fontSize: 10.5, color: 'var(--gray-500)' }}>· {hint}</span>
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 10.5, color: 'var(--gray-500)', fontWeight: 600 }}>{count}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {children}
      </div>
    </div>
  );
}


/* Compact row primitives */

function V2_BranchRowCompact({ b }) {
  return (
    <div style={V2_rowShell()}>
      <Icon name="branch" size={12} color="var(--gray-500)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="mono" style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.branch}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--gray-500)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--green-d)' }}>+{b.added}</span> <span style={{ color: 'var(--red-d)' }}>−{b.removed}</span> · {b.updated}
        </div>
      </div>
      <div className="btn"><Icon name="play" size={10} color="var(--gray-700)"/> Start</div>
    </div>
  );
}

function V2_WorkspaceRowCompact({ w, active, reviewing }) {
  const states = {
    'draft':       { label: 'Draft',             cls: '' },
    'local-ready': { label: 'Ready to share',    cls: 'badge-blue' },
    'in-review':   { label: 'In review',         cls: 'badge-blue' },
    'reviewing':   { label: 'Reviewing',         cls: 'badge-purple' },
    'requested':   { label: 'Changes requested', cls: 'badge-orange' },
    'approved':    { label: 'Approved',          cls: 'badge-green' },
  };
  const st = states[w.state];
  return (
    <div style={V2_rowShell(active)}>
      {reviewing && <Avatar name={w.author} size="sm" />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto' }}>
            {w.title}
          </span>
          {w.prNumber && <span className="badge" style={{ background: 'rgba(0,0,0,0.06)', flex: '0 0 auto' }}>#{w.prNumber}</span>}
          <span className={'badge ' + st.cls} style={{ flex: '0 0 auto' }}>{st.label}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--gray-500)', display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' }}>{w.branch}</span>
          <span><span style={{ color: 'var(--green-d)' }}>+{w.added}</span> <span style={{ color: 'var(--red-d)' }}>−{w.removed}</span></span>
          {w.storyline > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Icon name="doc-stack" size={9} color="var(--gray-500)"/> {w.storyline}</span>}
          {w.comments > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Icon name="comment-fill" size={9} color="var(--gray-400)"/> {w.comments}</span>}
        </div>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--gray-500)', flex: '0 0 auto' }}>{w.updated}</div>
    </div>
  );
}

function V2_ExternalRowCompact({ p, reviewing }) {
  return (
    <div style={V2_rowShell()}>
      {reviewing
        ? <Avatar name={p.author} size="sm" />
        : <Icon name="gh" size={13} color="var(--gray-600)" />
      }
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
          <span className="badge" style={{ background: 'rgba(0,0,0,0.06)', flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Icon name="gh" size={9} color="var(--gray-700)"/> #{p.prNumber}
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--gray-500)', display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' }}>{p.branch}</span>
          <span><span style={{ color: 'var(--green-d)' }}>+{p.added}</span> <span style={{ color: 'var(--red-d)' }}>−{p.removed}</span></span>
          <span>·</span>
          <span>{p.updated}</span>
        </div>
      </div>
      <div className="btn" style={{ background: 'var(--blue)', color: '#fff', borderColor: 'rgba(0,0,0,0.10)' }}>
        <Icon name="play" size={10} color="#fff"/> Start workspace
      </div>
    </div>
  );
}

function V2_rowShell(active) {
  return {
    display: 'flex', alignItems: 'center', gap: 10,
    background: '#fff',
    border: '1px solid ' + (active ? 'rgba(0,122,255,0.5)' : 'var(--hairline)'),
    borderRadius: 'var(--r-md)',
    padding: '8px 10px',
    boxShadow: active ? '0 0 0 3px var(--blue-tint)' : 'var(--sh-1)',
    minWidth: 0,
  };
}


Object.assign(window, { V2_Workspaces });
