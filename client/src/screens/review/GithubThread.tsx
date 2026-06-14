import { useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import type { GithubReviewComment } from '../../tauri';
import { Composer } from '../selfReview/Composer';
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
 * A GitHub review-comment thread: the root comment plus its replies as one card.
 * `offDiff` flags a thread whose anchored line is no longer in the rendered diff
 * — surfaced (never dropped) in the off-diff band with the original line it
 * pointed at, so review activity is always visible (fail loud, CLAUDE.md).
 *
 * When `onReply` is supplied (Step 4 — the PR isn't archived), a Reply affordance
 * opens an inline `Composer` that posts a threaded reply write-through to GitHub.
 * Omit it for a read-only/archived thread.
 */
export function GithubThread({
  thread,
  offDiff = false,
  onReply,
}: {
  thread: GithubCommentThread;
  offDiff?: boolean;
  onReply?: (rootId: number, body: string) => Promise<void>;
}) {
  const anchor = threadAnchor(thread);
  const [replying, setReplying] = useState(false);
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

      {onReply && (
        <div style={{ borderTop: '1px solid var(--hairline-2)', marginTop: 2, paddingTop: 4 }}>
          {replying ? (
            <Composer
              placeholder="Reply…"
              autoFocus
              onSave={(body) => {
                const trimmed = body.trim();
                if (!trimmed) {
                  setReplying(false);
                  return;
                }
                // Return the promise so the composer locks Save until it settles
                // (guards against a double-click posting the reply twice).
                return onReply(thread.root.id, trimmed)
                  .then(() => setReplying(false))
                  .catch(() => {
                    // Error surfaced in the screen's banner; keep the composer
                    // open so the reply text isn't lost (fail loud, CLAUDE.md).
                  });
              }}
              onCancel={() => setReplying(false)}
            />
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setReplying(true)}
              style={{ color: 'var(--blue)', padding: '0 4px', height: 22 }}
            >
              <Icon name="comment-fill" size={10} color="var(--blue)" /> Reply
            </button>
          )}
        </div>
      )}
    </div>
  );
}
