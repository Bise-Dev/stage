import { Avatar } from '../../components/Avatar';
import { Markdown } from '../../components/Markdown';
import type { GithubReviewComment } from '../../tauri';
import { type GithubCommentThread, threadAnchor } from './githubReview';

/** One comment row: avatar + login, then the body as Markdown. Shared by the
 *  root and every reply so a thread reads as a single conversation. */
function CommentRow({ c }: { c: GithubReviewComment }) {
  const login = c.user?.login ?? 'ghost';
  return (
    <div style={{ display: 'flex', gap: 8, padding: '6px 0' }}>
      <Avatar name={login} size="sm" />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gray-700)', marginBottom: 1 }}>
          {login}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.45 }}>
          <Markdown>{c.body}</Markdown>
        </div>
      </div>
    </div>
  );
}

/**
 * A GitHub review-comment thread rendered read-only (posting/replies are Step
 * 4). The root comment plus its replies as one card. `offDiff` flags a thread
 * whose anchored line is no longer in the rendered diff — surfaced (never
 * dropped) in the off-diff band with the original line it pointed at, so review
 * activity is always visible (fail loud, CLAUDE.md).
 */
export function GithubThread({
  thread,
  offDiff = false,
}: {
  thread: GithubCommentThread;
  offDiff?: boolean;
}) {
  const anchor = threadAnchor(thread);
  return (
    <div
      style={{
        background: offDiff ? 'rgba(255,149,0,0.04)' : '#fff',
        border: `1px solid ${offDiff ? 'rgba(255,149,0,0.30)' : 'var(--hairline)'}`,
        borderRadius: 'var(--r-md)',
        padding: '8px 10px',
        boxShadow: 'var(--sh-1)',
        margin: '6px 0',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 2,
          paddingBottom: 4,
          borderBottom: '1px solid var(--hairline-2)',
        }}
      >
        <span
          className="badge"
          style={{
            background: 'rgba(0,0,0,0.06)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
          }}
        >
          <span className="mono" style={{ fontSize: 10 }}>
            GitHub
          </span>
        </span>
        {anchor && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              fontWeight: 600,
              color: offDiff ? '#b56500' : 'var(--blue-press)',
              letterSpacing: 0.04,
            }}
          >
            {anchor.side === 'LEFT' ? 'old ' : ''}L{anchor.line}
          </span>
        )}
        {offDiff && (
          <span
            className="badge badge-orange"
            title="The anchored line left the current diff — shown here so it isn't lost"
          >
            off-diff
          </span>
        )}
      </div>
      <CommentRow c={thread.root} />
      {thread.replies.map((r) => (
        <div key={r.id} style={{ borderTop: '1px solid var(--hairline-2)' }}>
          <CommentRow c={r} />
        </div>
      ))}
    </div>
  );
}
