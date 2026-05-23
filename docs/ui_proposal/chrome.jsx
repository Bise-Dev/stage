/* chrome.jsx — shared primitives for both directions
   Window frame, traffic lights, avatars, diff lines, comments. */

const COLORS = ['#FF9500','#34C759','#5AC8FA','#AF52DE','#FF2D55','#007AFF','#FF3B30','#FFCC00'];
function hashHue(name) {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}
function initials(name) {
  return name.split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

function Avatar({ name, size = 'md', src }) {
  const cls = size === 'sm' ? 'avatar sm' : size === 'lg' ? 'avatar lg' : 'avatar';
  return (
    <div className={cls} style={{ background: hashHue(name) }}>
      {initials(name)}
    </div>
  );
}

function TrafficLights() {
  return (
    <div className="tl">
      <span className="tl-dot tl-r"></span>
      <span className="tl-dot tl-y"></span>
      <span className="tl-dot tl-g"></span>
    </div>
  );
}

function TitleBar({ title, vibrant, right }) {
  return (
    <div className={'win-titlebar' + (vibrant ? ' vibrant' : '')}>
      <TrafficLights />
      <div className="win-title">{title}</div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>{right}</div>
    </div>
  );
}

/* Icons — minimal hairline strokes, SF-symbol-ish */
function Icon({ name, size = 14, color = 'currentColor' }) {
  const s = size;
  const stroke = { stroke: color, strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'branch': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <circle cx="3.5" cy="3" r="1.4" /><circle cx="3.5" cy="11" r="1.4" /><circle cx="10.5" cy="3" r="1.4" />
        <path d="M3.5 4.4v5.2M10.5 4.4v1.6a2 2 0 0 1-2 2H5.5" />
      </svg>
    );
    case 'search': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <circle cx="6" cy="6" r="4" /><path d="M9.2 9.2L12 12" />
      </svg>
    );
    case 'plus': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}><path d="M7 2v10M2 7h10" /></svg>
    );
    case 'gear': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <circle cx="7" cy="7" r="2" />
        <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.7 2.7l1.1 1.1M10.2 10.2l1.1 1.1M2.7 11.3l1.1-1.1M10.2 3.8l1.1-1.1" />
      </svg>
    );
    case 'chevron-down': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}><path d="M3 5l4 4 4-4" /></svg>
    );
    case 'chevron-right': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}><path d="M5 3l4 4-4 4" /></svg>
    );
    case 'chevron-left': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}><path d="M9 3L5 7l4 4" /></svg>
    );
    case 'check': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}><path d="M2.5 7.5l3 3 6-7" /></svg>
    );
    case 'check-circle': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <circle cx="7" cy="7" r="5.5" /><path d="M4.5 7l2 2 3-4" />
      </svg>
    );
    case 'x-circle': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <circle cx="7" cy="7" r="5.5" /><path d="M5 5l4 4M9 5l-4 4" />
      </svg>
    );
    case 'dot-circle': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <circle cx="7" cy="7" r="5.5" /><circle cx="7" cy="7" r="1.6" fill={color} stroke="none" />
      </svg>
    );
    case 'file': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <path d="M3 1.5h5l3 3v8H3z" /><path d="M8 1.5V4.5h3" />
      </svg>
    );
    case 'folder': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <path d="M1.5 4V3a1 1 0 0 1 1-1h2.5l1.2 1.5h5.3a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
      </svg>
    );
    case 'copy': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <rect x="2.5" y="4.5" width="7" height="8" rx="1" /><path d="M5 4.5V2.5h6.5v8H9.5" />
      </svg>
    );
    case 'comment': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <path d="M2 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6l-3 2v-2H4a2 2 0 0 1-2-2z" />
      </svg>
    );
    case 'comment-fill': return (
      <svg width={s} height={s} viewBox="0 0 14 14"><path d="M2 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6l-3 2v-2H4a2 2 0 0 1-2-2z" fill={color}/></svg>
    );
    case 'sparkle': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <path d="M7 1.5v3M7 9.5v3M1.5 7h3M9.5 7h3M3.2 3.2l2 2M8.8 8.8l2 2M10.8 3.2l-2 2M5.2 8.8l-2 2" />
      </svg>
    );
    case 'menu': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}><path d="M2 4h10M2 7h10M2 10h10" /></svg>
    );
    case 'grip': return (
      <svg width={s} height={s} viewBox="0 0 14 14" fill={color}>
        <circle cx="4" cy="3" r="1" /><circle cx="10" cy="3" r="1" />
        <circle cx="4" cy="7" r="1" /><circle cx="10" cy="7" r="1" />
        <circle cx="4" cy="11" r="1" /><circle cx="10" cy="11" r="1" />
      </svg>
    );
    case 'play': return (
      <svg width={s} height={s} viewBox="0 0 14 14"><path d="M4 3v8l7-4z" fill={color}/></svg>
    );
    case 'arrow-right': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}><path d="M2.5 7h9M8 3.5L11.5 7 8 10.5" /></svg>
    );
    case 'arrow-up-right': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}><path d="M4 10L10 4M5 4h5v5" /></svg>
    );
    case 'doc-stack': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <rect x="3" y="3" width="8" height="9" rx="1.2" /><path d="M5 1.5h6a1 1 0 0 1 1 1V10" />
      </svg>
    );
    case 'gh': return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill={color}>
        <path d="M8 0a8 8 0 0 0-2.5 15.6c.4.1.6-.2.6-.4v-1.4c-2.3.5-2.8-1-2.8-1-.4-1-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.4.7.1-.5.3-.9.5-1.1-1.8-.2-3.7-.9-3.7-4 0-.9.3-1.6.8-2.2-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 2 .1 2.1.5.6.8 1.3.8 2.2 0 3.1-1.9 3.8-3.7 4 .3.3.6.8.6 1.6v2.3c0 .2.1.5.6.4A8 8 0 0 0 8 0" />
      </svg>
    );
    case 'eye': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <path d="M1 7s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4z" /><circle cx="7" cy="7" r="1.6" />
      </svg>
    );
    case 'open-window': return (
      <svg width={s} height={s} viewBox="0 0 14 14" {...stroke}>
        <rect x="1.5" y="2.5" width="11" height="9" rx="1" /><path d="M1.5 5h11" />
      </svg>
    );
    default: return <span style={{ display: 'inline-block', width: s, height: s }}/>;
  }
}

/* Diff renderer.
   lines: array of { kind: 'ctx'|'add'|'del'|'hunk', n1, n2, text, comment? }
*/
function DiffTable({ lines, withSplit }) {
  return (
    <table className="diff">
      <tbody>
        {lines.map((l, i) => {
          if (l.kind === 'hunk') {
            return (
              <tr key={i} className="hunk">
                <td colSpan={withSplit ? 5 : 4}>{l.text}</td>
              </tr>
            );
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
        })}
      </tbody>
    </table>
  );
}

/* Very simple syntax highlighter for shell / dockerfile / ts / py. */
function Code({ text }) {
  if (text === '' || text == null) return null;
  const tokens = [];
  // Comments
  let m = text.match(/^(\s*)(#.*)$/);
  if (m) {
    return (<><span>{m[1]}</span><span className="t-com">{m[2]}</span></>);
  }
  m = text.match(/^(\s*)(\/\/.*)$/);
  if (m) {
    return (<><span>{m[1]}</span><span className="t-com">{m[2]}</span></>);
  }
  // simple tokenization
  const KW = /\b(FROM|RUN|COPY|ENV|WORKDIR|CMD|EXPOSE|ARG|AS|export|const|let|var|function|return|if|else|import|from|as|def|class|async|await|new|true|false|null|None|True|False|self|this)\b/g;
  const STR = /(['"`])([^'"`\\]|\\.)*\1/g;
  const NUM = /\b(\d+(?:\.\d+)?)\b/;
  // crude pass: split by quotes first, then by keywords
  const out = [];
  let rest = text;
  let key = 0;
  // strings
  const segs = [];
  let last = 0;
  rest.replace(/(['"`])(?:[^'"`\\]|\\.)*\1/g, (full, q, off) => {
    if (off > last) segs.push({ t: rest.slice(last, off), s: false });
    segs.push({ t: full, s: true });
    last = off + full.length;
    return full;
  });
  if (last < rest.length) segs.push({ t: rest.slice(last), s: false });
  segs.forEach((seg, i) => {
    if (seg.s) {
      out.push(<span key={key++} className="t-str">{seg.t}</span>);
      return;
    }
    // keyword pass
    let s = seg.t;
    const parts = [];
    let li = 0;
    s.replace(KW, (kw, off) => {
      if (off > li) parts.push({ t: s.slice(li, off), k: 'plain' });
      parts.push({ t: kw, k: 'kw' });
      li = off + kw.length;
      return kw;
    });
    if (li < s.length) parts.push({ t: s.slice(li), k: 'plain' });
    parts.forEach(p => {
      if (p.k === 'kw') out.push(<span key={key++} className="t-kw">{p.t}</span>);
      else {
        // numbers
        const subs = p.t.split(/(\d+(?:\.\d+)?)/g);
        subs.forEach((sub, j) => {
          if (/^\d/.test(sub)) out.push(<span key={key++} className="t-num">{sub}</span>);
          else out.push(<span key={key++}>{sub}</span>);
        });
      }
    });
  });
  return <>{out}</>;
}

/* Comment thread block for inline placement inside diff. */
function CommentBlock({ author, when, text, replies, ai }) {
  return (
    <div style={{ background: '#fff', borderTop: '1px solid var(--hairline)', borderBottom: '1px solid var(--hairline)', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Avatar name={author} size="sm" />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gray-800)' }}>{author}</span>
            {ai && <span className="badge badge-purple">AI</span>}
            <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>{when}</span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.45 }}>{text}</div>
          {replies && replies.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--hairline)' }}>
              <Avatar name={r.author} size="sm" />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-800)' }}>
                  {r.author} <span style={{ fontWeight: 400, color: 'var(--gray-500)', marginLeft: 4 }}>{r.when}</span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--gray-800)', marginTop: 2, lineHeight: 1.45 }}>{r.text}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Avatar, TrafficLights, TitleBar, Icon, DiffTable, Code, CommentBlock, hashHue, initials });
