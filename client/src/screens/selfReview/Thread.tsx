import { useState } from 'react';
import { Icon } from '../../components/Icon';
import type { NoteAnchor, NoteStatus, SelfReviewNoteView } from '../../tauri';
import { Composer } from './Composer';

const STATUS: Record<NoteStatus, { label: string; cls: string }> = {
  open: { label: 'open', cls: 'badge-orange' },
  addressed: { label: 'addressed', cls: 'badge-blue' },
  resolved: { label: 'resolved', cls: 'badge-green' },
};

/** Short header text for the anchor — matches the composer's label so the read
 *  view matches the write view. `null` anchor = general (un-anchored) note. */
function anchorLabel(anchor: NoteAnchor | null): string {
  if (!anchor) return 'general';
  if (anchor.lineStart == null) return 'file';
  if (anchor.lineEnd == null || anchor.lineEnd === anchor.lineStart) return `L${anchor.lineStart}`;
  return `L${anchor.lineStart}–L${anchor.lineEnd}`;
}

/**
 * A Review note rendered as a threaded conversation (ADR-0012): the opening
 * author body, its author/agent replies, and the author's actions (reply,
 * resolve/reopen, delete). Used inline at a diff line (via the DiffView widget
 * slot) and in the file-level band above the diff. Owns its own reply-composer
 * open state so each thread toggles independently.
 */
export function Thread({
  note,
  onReply,
  onResolve,
  onReopen,
  onDelete,
}: {
  note: SelfReviewNoteView;
  onReply: (id: string, body: string) => Promise<void>;
  onResolve: (id: string) => Promise<void>;
  onReopen: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [replying, setReplying] = useState(false);
  const status = STATUS[note.status];
  const resolved = note.status === 'resolved';

  return (
    <div
      style={{
        background: note.outdated ? 'rgba(255,149,0,0.04)' : '#fff',
        border: `1px solid ${note.outdated ? 'rgba(255,149,0,0.30)' : 'var(--hairline)'}`,
        borderRadius: 'var(--r-md)',
        padding: '8px 10px',
        boxShadow: 'var(--sh-1)',
        margin: '6px 0',
        fontSize: 12.5,
        color: 'var(--gray-800)',
        opacity: resolved ? 0.8 : 1,
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
        <span className={`badge ${status.cls}`}>{status.label}</span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            fontWeight: 600,
            color: note.outdated ? '#b56500' : 'var(--blue-press)',
            letterSpacing: 0.04,
          }}
        >
          {anchorLabel(note.anchor)}
        </span>
        {note.outdated && (
          <span
            className="badge badge-orange"
            title="The anchored lines/file left the diff — this feedback may be obsolete"
          >
            outdated
          </span>
        )}
      </div>
      <div style={{ whiteSpace: 'pre-wrap' }}>{note.body}</div>

      {note.replies.map((r) => (
        <div
          key={r.id}
          style={{
            marginTop: 6,
            paddingTop: 6,
            borderTop: '1px solid var(--hairline-2)',
            whiteSpace: 'pre-wrap',
            color: r.author === 'agent' ? 'var(--gray-600)' : 'var(--gray-800)',
          }}
        >
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              color: r.author === 'agent' ? 'var(--green-d)' : 'var(--blue-press)',
              marginRight: 6,
              textTransform: 'uppercase',
            }}
          >
            {r.author}
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
          onClick={() => setReplying((v) => !v)}
          style={{ color: 'var(--blue)', padding: '0 4px', height: 20 }}
        >
          <Icon name="comment-fill" size={10} color="var(--blue)" /> Reply
        </button>
        <div style={{ flex: 1 }} />
        {resolved ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onReopen(note.id)}
            style={{ color: 'var(--blue)', padding: '0 4px', height: 20 }}
          >
            Reopen
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onResolve(note.id)}
            style={{ color: 'var(--green-d)', padding: '0 4px', height: 20 }}
          >
            <Icon name="check" size={10} color="var(--green-d)" /> Resolve
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onDelete(note.id)}
          style={{ color: 'var(--red-d)', padding: '0 4px', height: 20 }}
        >
          Delete
        </button>
      </div>

      {replying && (
        <Composer
          placeholder="Reply…"
          autoFocus
          onSave={(body) => {
            const trimmed = body.trim();
            if (!trimmed) {
              setReplying(false);
              return;
            }
            onReply(note.id, trimmed)
              .then(() => setReplying(false))
              .catch(() => {
                // Error surfaced via the hook's banner; keep the composer open
                // so the author doesn't lose what they typed.
              });
          }}
          onCancel={() => setReplying(false)}
        />
      )}
    </div>
  );
}
