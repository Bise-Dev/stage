import { Icon } from '../../components/Icon';
import { Composer } from './Composer';
import type { Anchor, Comment, ComposerTarget } from './types';

/** Short header text for the anchor — same shape as the composer's label
 *  so the read view matches the write view. */
function anchorLabel(anchor: Anchor): string {
  if (anchor.kind === 'line') {
    return anchor.lineStart === anchor.lineEnd
      ? `L${anchor.lineStart}`
      : `L${anchor.lineStart}–L${anchor.lineEnd}`;
  }
  if (anchor.kind === 'file') return 'file';
  // dangling: show the original target so the user can still trace what it
  // pointed at, even though the lines/file are gone.
  const orig = anchor.originalAnchor;
  if (orig.kind === 'line') {
    return orig.lineStart === orig.lineEnd
      ? `L${orig.lineStart}`
      : `L${orig.lineStart}–L${orig.lineEnd}`;
  }
  return 'file';
}

/**
 * Top-level comment + flat ordered replies (Q10-F). Used both for inline
 * (line-anchored) comments via the DiffView widget slot and for file-level
 * comments rendered in the band above the diff.
 */
export function Thread({
  comment,
  composer,
  onStartReply,
  onSaveComposer,
  onCancelComposer,
  onDelete,
}: {
  comment: Comment;
  composer: ComposerTarget | null;
  onStartReply: (parentId: string) => void;
  onSaveComposer: (body: string) => void;
  onCancelComposer: () => void;
  onDelete: (id: string) => void;
}) {
  const replyOpen = composer?.kind === 'reply' && composer.parentId === comment.id;
  const isDangling = comment.anchor.kind === 'dangling';

  return (
    <div
      style={{
        background: isDangling ? 'rgba(255,149,0,0.04)' : '#fff',
        border: `1px solid ${isDangling ? 'rgba(255,149,0,0.30)' : 'var(--hairline)'}`,
        borderRadius: 'var(--r-md)',
        padding: '8px 10px',
        boxShadow: 'var(--sh-1)',
        margin: '6px 0',
        fontSize: 12.5,
        color: 'var(--gray-800)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 4,
          paddingBottom: 4,
          borderBottom: '1px solid var(--hairline-2)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            fontWeight: 600,
            color: isDangling ? '#b56500' : 'var(--blue-press)',
            letterSpacing: 0.04,
          }}
        >
          {anchorLabel(comment.anchor)}
        </span>
        {isDangling && (
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              color: '#b56500',
              textTransform: 'uppercase',
              letterSpacing: 0.04,
            }}
          >
            Dangling — anchor lost on edit
          </span>
        )}
      </div>
      <div style={{ whiteSpace: 'pre-wrap' }}>{comment.body}</div>
      {comment.replies.map((r) => (
        <div
          key={r.id}
          style={{
            marginTop: 6,
            paddingTop: 6,
            borderTop: '1px solid var(--hairline-2)',
            whiteSpace: 'pre-wrap',
          }}
        >
          <span
            aria-label="reply"
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--gray-400)',
              marginRight: 6,
            }}
          >
            *
          </span>
          {r.body}
        </div>
      ))}
      <div
        style={{
          display: 'flex',
          gap: 6,
          marginTop: 6,
          paddingTop: 6,
          borderTop: '1px solid var(--hairline-2)',
        }}
      >
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onStartReply(comment.id)}
          style={{ color: 'var(--blue)', padding: '0 4px', height: 20 }}
        >
          <Icon name="comment-fill" size={10} color="var(--blue)" /> Reply
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onDelete(comment.id)}
          style={{ color: 'var(--red-d)', padding: '0 4px', height: 20 }}
        >
          Delete
        </button>
      </div>
      {replyOpen && (
        <Composer
          placeholder="Reply…"
          onSave={onSaveComposer}
          onCancel={onCancelComposer}
          autoFocus
        />
      )}
    </div>
  );
}
