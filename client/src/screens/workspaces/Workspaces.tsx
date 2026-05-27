import { type ReactNode, useEffect, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { TitleBar } from '../../components/TitleBar';
import { getActiveRepo, githubPrs, repoSummary } from '../../tauri';
import {
  type BranchRow,
  type ExternalPrRow,
  STUB_BRANCHES,
  STUB_WORKSPACES,
  type WorkspaceRow,
  type WorkspaceState,
  YOU,
  externalPrFromGithub,
} from './data';

type Show = 'all' | 'yours' | 'review';
type Kind = 'self-review' | 'ready-to-share' | 'in-review' | 'open-prs';

function slugFromRemote(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/[:/]([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Stub buckets never change; live PRs arrive async.
const yoursBranches = STUB_BRANCHES.filter((b) => b.author === YOU);
const yoursReadyToShare = STUB_WORKSPACES.filter((w) => w.author === YOU && !w.prNumber);
const yoursInReview = STUB_WORKSPACES.filter((w) => w.author === YOU && w.prNumber);
const reviewInReview = STUB_WORKSPACES.filter((w) => w.author !== YOU && w.prNumber);

export function Workspaces() {
  const [repoSlug, setRepoSlug] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [externals, setExternals] = useState<ExternalPrRow[]>([]);
  const [show, setShow] = useState<Show>('all');
  const [kind, setKind] = useState<Kind | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    (async () => {
      const repo = await getActiveRepo();
      if (!repo) return;
      setRepoPath(repo.path);
      try {
        const sum = await repoSummary(repo.path);
        setRepoSlug(slugFromRemote(sum.remoteUrl));
      } catch {
        // Non-fatal: the rail just shows the folder name instead of a slug.
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [authored, reviewing] = await Promise.all([
          githubPrs('author'),
          githubPrs('reviewer'),
        ]);
        setExternals([
          ...authored.map((p) => externalPrFromGithub(p, 'author')),
          ...reviewing.map((p) => externalPrFromGithub(p, 'reviewer')),
        ]);
      } catch (e) {
        console.warn('workspaces_github_prs_failed', e);
      }
    })();
  }, []);

  const q = query.trim().toLowerCase();
  const matchBranch = (b: BranchRow) =>
    !q || b.branch.toLowerCase().includes(q) || b.author.toLowerCase().includes(q);
  const matchWorkspace = (w: WorkspaceRow) =>
    !q ||
    w.title.toLowerCase().includes(q) ||
    w.branch.toLowerCase().includes(q) ||
    w.author.toLowerCase().includes(q) ||
    (!!w.prNumber && `#${w.prNumber}`.includes(q));
  const matchExternal = (p: ExternalPrRow) =>
    !q ||
    p.title.toLowerCase().includes(q) ||
    p.author.toLowerCase().includes(q) ||
    `#${p.prNumber}`.includes(q);

  const externalsAuthor = externals.filter((p) => p.role === 'author');
  const externalsReviewer = externals.filter((p) => p.role === 'reviewer');

  // Counts (kind filter is independent of the rail counts, like the design).
  const kindCounts = {
    'self-review': STUB_BRANCHES.length,
    'ready-to-share': STUB_WORKSPACES.filter((w) => !w.prNumber).length,
    'in-review': STUB_WORKSPACES.filter((w) => w.prNumber).length,
    'open-prs': externals.length,
  };
  const yoursCount =
    yoursBranches.length + yoursReadyToShare.length + yoursInReview.length + externalsAuthor.length;
  const reviewCount = reviewInReview.length + externalsReviewer.length;

  const showKind = (k: Kind) => kind === null || kind === k;
  const toggleKind = (k: Kind) => setKind((cur) => (cur === k ? null : k));

  const showYours = show !== 'review';
  const showReview = show !== 'yours';

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title="Stage" />
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Left filter rail */}
          <div
            style={{
              width: 200,
              flex: '0 0 200px',
              borderRight: '1px solid var(--hairline)',
              padding: '14px 10px',
              background: '#fbfaf8',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 6px 8px',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-700)' }}>
                Workspaces
              </div>
              <button
                type="button"
                onClick={() => console.info('workspaces_new_stub', 'rail-plus')}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'default' }}
                aria-label="New workspace"
              >
                <Icon name="plus" size={13} color="var(--gray-500)" />
              </button>
            </div>

            <div className="section-label" style={{ padding: '0 6px' }}>
              Show
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <FilterRow
                label="Everything"
                count={yoursCount + reviewCount}
                active={show === 'all'}
                onClick={() => setShow('all')}
              />
              <FilterRow
                label="Authored by you"
                count={yoursCount}
                dot="var(--blue)"
                active={show === 'yours'}
                onClick={() => setShow('yours')}
              />
              <FilterRow
                label="Awaiting your review"
                count={reviewCount}
                dot="var(--orange)"
                active={show === 'review'}
                onClick={() => setShow('review')}
              />
            </div>

            <div className="section-label" style={{ marginTop: 14, padding: '0 6px' }}>
              Filter by kind
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <FilterRow
                icon={<Icon name="eye" size={11} />}
                label="Self-Review"
                count={kindCounts['self-review']}
                sub="no workspace"
                active={kind === 'self-review'}
                onClick={() => toggleKind('self-review')}
              />
              <FilterRow
                icon={<Icon name="branch" size={11} />}
                label="Ready to share"
                count={kindCounts['ready-to-share']}
                sub="not on GitHub"
                active={kind === 'ready-to-share'}
                onClick={() => toggleKind('ready-to-share')}
              />
              <FilterRow
                icon={<Icon name="doc-stack" size={11} />}
                label="In review"
                count={kindCounts['in-review']}
                sub="workspace + PR"
                active={kind === 'in-review'}
                onClick={() => toggleKind('in-review')}
              />
              <FilterRow
                icon={<Icon name="gh" size={11} />}
                label="Open PRs"
                count={kindCounts['open-prs']}
                sub="no workspace"
                active={kind === 'open-prs'}
                onClick={() => toggleKind('open-prs')}
              />
            </div>

            <div style={{ flex: 1 }} />

            <div className="section-label" style={{ marginTop: 14, padding: '0 6px' }}>
              Repository
            </div>
            <div style={{ padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="folder" size={13} color="var(--gray-500)" />
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>
                {repoSlug ?? (repoPath ? basename(repoPath) : '—')}
              </span>
            </div>
            {repoPath && (
              <div
                style={{ padding: '0 10px 4px 28px', color: 'var(--gray-500)', fontSize: 11 }}
                className="mono"
              >
                {repoPath}
              </div>
            )}
          </div>

          {/* Main */}
          <div
            style={{
              flex: 1,
              padding: '14px 18px',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <div
                  style={{
                    position: 'absolute',
                    left: 9,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--gray-400)',
                    display: 'flex',
                  }}
                >
                  <Icon name="search" size={13} />
                </div>
                <input
                  className="input lg"
                  placeholder="Search by branch, title, author or PR #…"
                  style={{ paddingLeft: 28 }}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn btn-lg"
                onClick={() => console.info('workspaces_fetch_stub')}
              >
                <Icon name="branch" size={12} color="var(--gray-700)" /> Fetch
              </button>
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => console.info('workspaces_new_stub', 'toolbar')}
              >
                <Icon name="plus" size={12} color="#fff" /> New workspace
              </button>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: showYours && showReview ? '1fr 1fr' : '1fr',
                gap: 16,
                flex: 1,
                minHeight: 0,
              }}
            >
              {showYours && (
                <Column
                  icon={<Avatar name="You" size="lg" />}
                  title="Authored by you"
                  count={yoursCount}
                  tint="rgba(0,122,255,0.04)"
                  border="rgba(0,122,255,0.16)"
                  accent="var(--blue)"
                >
                  {showKind('self-review') && yoursBranches.filter(matchBranch).length > 0 && (
                    <Bucket
                      color="var(--orange)"
                      title="Self-Review"
                      hint="no workspace"
                      count={yoursBranches.length}
                    >
                      {yoursBranches.filter(matchBranch).map((b) => (
                        <BranchRowCompact key={b.id} b={b} />
                      ))}
                    </Bucket>
                  )}
                  {showKind('ready-to-share') &&
                    yoursReadyToShare.filter(matchWorkspace).length > 0 && (
                      <Bucket
                        color="var(--blue)"
                        title="Ready to share"
                        hint="not on GitHub"
                        count={yoursReadyToShare.length}
                      >
                        {yoursReadyToShare.filter(matchWorkspace).map((w) => (
                          <WorkspaceRowCompact
                            key={w.id}
                            w={w}
                            active={w.id === 'ws-eslint-bump'}
                          />
                        ))}
                      </Bucket>
                    )}
                  {showKind('in-review') && yoursInReview.filter(matchWorkspace).length > 0 && (
                    <Bucket
                      color="var(--purple)"
                      title="In review"
                      hint="workspace + PR"
                      count={yoursInReview.length}
                    >
                      {yoursInReview.filter(matchWorkspace).map((w) => (
                        <WorkspaceRowCompact key={w.id} w={w} />
                      ))}
                    </Bucket>
                  )}
                  {showKind('open-prs') && externalsAuthor.filter(matchExternal).length > 0 && (
                    <Bucket
                      color="var(--gray-400)"
                      title="Open PRs"
                      hint="on GitHub, no workspace"
                      count={externalsAuthor.length}
                    >
                      {externalsAuthor.filter(matchExternal).map((p) => (
                        <ExternalRowCompact key={p.id} p={p} />
                      ))}
                    </Bucket>
                  )}
                </Column>
              )}

              {showReview && (
                <Column
                  icon={
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        background: 'rgba(255,149,0,0.18)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Icon name="eye" size={14} color="var(--orange)" />
                    </div>
                  }
                  title="Awaiting your review"
                  count={reviewCount}
                  tint="rgba(255,149,0,0.04)"
                  border="rgba(255,149,0,0.18)"
                  accent="var(--orange)"
                >
                  {showKind('in-review') && reviewInReview.filter(matchWorkspace).length > 0 && (
                    <Bucket
                      color="var(--purple)"
                      title="In review"
                      hint="workspace + PR"
                      count={reviewInReview.length}
                    >
                      {reviewInReview.filter(matchWorkspace).map((w) => (
                        <WorkspaceRowCompact key={w.id} w={w} reviewing />
                      ))}
                    </Bucket>
                  )}
                  {showKind('open-prs') && externalsReviewer.filter(matchExternal).length > 0 && (
                    <Bucket
                      color="var(--gray-400)"
                      title="Open PRs"
                      hint="on GitHub, no workspace"
                      count={externalsReviewer.length}
                    >
                      {externalsReviewer.filter(matchExternal).map((p) => (
                        <ExternalRowCompact key={p.id} p={p} reviewing />
                      ))}
                    </Bucket>
                  )}
                </Column>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

function FilterRow({
  label,
  count,
  active,
  dot,
  sub,
  icon,
  onClick,
}: {
  label: string;
  count: number;
  active?: boolean;
  dot?: string;
  sub?: string;
  icon?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 5,
        border: 'none',
        textAlign: 'left',
        cursor: 'default',
        background: active ? 'rgba(0,0,0,0.06)' : 'transparent',
        color: 'var(--gray-800)',
        fontSize: 12.5,
        fontFamily: 'inherit',
        fontWeight: active ? 600 : 500,
      }}
    >
      {dot && (
        <span style={{ width: 7, height: 7, borderRadius: 4, background: dot, flex: '0 0 7px' }} />
      )}
      {icon && <span style={{ color: 'var(--gray-500)', display: 'flex' }}>{icon}</span>}
      {!dot && !icon && <span style={{ width: 7, height: 7, flex: '0 0 7px' }} />}
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {sub && (
        <span style={{ fontSize: 10.5, color: 'var(--gray-400)', fontWeight: 500 }}>{sub}</span>
      )}
      <span style={{ color: 'var(--gray-500)', fontSize: 11.5, fontWeight: 500, marginLeft: 4 }}>
        {count}
      </span>
    </button>
  );
}

function Column({
  icon,
  title,
  count,
  tint,
  border,
  accent,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  tint: string;
  border: string;
  accent: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        background: tint,
        border: `1px solid ${border}`,
        borderRadius: 'var(--r-lg)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 14px',
          background: '#fff',
          borderBottom: `1px solid ${border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        {icon}
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: -0.01,
              color: 'var(--gray-900)',
            }}
          >
            {title}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 1 }}>
            {count} item{count === 1 ? '' : 's'}
          </div>
        </div>
        <span style={{ width: 6, height: 24, borderRadius: 3, background: accent }} />
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Bucket({
  color,
  title,
  hint,
  count,
  children,
}: {
  color: string;
  title: string;
  hint: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 6,
          paddingLeft: 2,
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: 4, background: color }} />
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            color: 'var(--gray-800)',
            letterSpacing: 0.02,
          }}
        >
          {title}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--gray-500)' }}>· {hint}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: 'var(--gray-500)', fontWeight: 600 }}>{count}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}

function rowShell(active?: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: '#fff',
    border: `1px solid ${active ? 'rgba(0,122,255,0.5)' : 'var(--hairline)'}`,
    borderRadius: 'var(--r-md)',
    padding: '8px 10px',
    boxShadow: active ? '0 0 0 3px var(--blue-tint)' : 'var(--sh-1)',
    minWidth: 0,
  };
}

function BranchRowCompact({ b }: { b: BranchRow }) {
  return (
    <div style={rowShell()}>
      <Icon name="branch" size={12} color="var(--gray-500)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            className="mono"
            style={{
              fontSize: 12,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {b.branch}
          </span>
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--gray-500)',
            marginTop: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ color: 'var(--green-d)' }}>+{b.added}</span>{' '}
          <span style={{ color: 'var(--red-d)' }}>−{b.removed}</span> · {b.updated}
        </div>
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => console.info('workspaces_self_review_stub', b.id)}
      >
        <Icon name="play" size={10} color="var(--gray-700)" /> Self-Review
      </button>
    </div>
  );
}

const STATES: Record<WorkspaceState, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: '' },
  'ready-to-share': { label: 'Ready to share', cls: 'badge-blue' },
  'in-review': { label: 'In review', cls: 'badge-blue' },
  reviewing: { label: 'Reviewing', cls: 'badge-purple' },
  requested: { label: 'Changes requested', cls: 'badge-orange' },
  approved: { label: 'Approved', cls: 'badge-green' },
};

function WorkspaceRowCompact({
  w,
  active,
  reviewing,
}: {
  w: WorkspaceRow;
  active?: boolean;
  reviewing?: boolean;
}) {
  const st = STATES[w.state];
  return (
    <div style={rowShell(active)}>
      {reviewing && <Avatar name={w.author} size="sm" />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: '0 1 auto',
            }}
          >
            {w.title}
          </span>
          {w.prNumber && (
            <span className="badge" style={{ background: 'rgba(0,0,0,0.06)', flex: '0 0 auto' }}>
              #{w.prNumber}
            </span>
          )}
          <span className={`badge ${st.cls}`} style={{ flex: '0 0 auto' }}>
            {st.label}
          </span>
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--gray-500)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            overflow: 'hidden',
          }}
        >
          <span
            className="mono"
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '40%',
            }}
          >
            {w.branch}
          </span>
          <span>
            <span style={{ color: 'var(--green-d)' }}>+{w.added}</span>{' '}
            <span style={{ color: 'var(--red-d)' }}>−{w.removed}</span>
          </span>
          {w.storyline > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="doc-stack" size={9} color="var(--gray-500)" /> {w.storyline}
            </span>
          )}
          {w.comments > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="comment-fill" size={9} color="var(--gray-400)" /> {w.comments}
            </span>
          )}
        </div>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--gray-500)', flex: '0 0 auto' }}>{w.updated}</div>
    </div>
  );
}

function ExternalRowCompact({ p, reviewing }: { p: ExternalPrRow; reviewing?: boolean }) {
  return (
    <div style={rowShell()}>
      {reviewing ? (
        <Avatar name={p.author} size="sm" />
      ) : (
        <Icon name="gh" size={13} color="var(--gray-600)" />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {p.title}
          </span>
          <span
            className="badge"
            style={{
              background: 'rgba(0,0,0,0.06)',
              flex: '0 0 auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
            }}
          >
            <Icon name="gh" size={9} color="var(--gray-700)" /> #{p.prNumber}
          </span>
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--gray-500)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            overflow: 'hidden',
          }}
        >
          <span>{reviewing ? p.author : 'You'}</span>
          <span>·</span>
          <span>{p.updated}</span>
        </div>
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => console.info('workspaces_review_stub', p.id)}
      >
        <Icon name="play" size={10} color="var(--gray-700)" /> Review
      </button>
    </div>
  );
}
