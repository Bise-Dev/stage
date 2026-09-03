import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import type { DebriefView, NoteAnchor, SelfReviewNoteView } from '../../tauri';
import { Composer } from './Composer';
import { Thread } from './Thread';

/**
 * Top-bar home for the notes that have no place in the diff (v6-light L9 §3c
 * N2/N3): general (un-anchored) feedback on the whole change, plus notes whose
 * anchored file is no longer in the current diff — both lived in the Debrief
 * rail before it was removed. A button with an open-note badge opens an
 * anchored popover (RepoMenu idiom: outside click / Esc dismisses).
 */

type NoteOps = {
  onCreateNote: (anchor: NoteAnchor | null, body: string) => Promise<void>;
  onReplyNote: (id: string, body: string) => Promise<void>;
  onResolveNote: (id: string) => Promise<void>;
  onReopenNote: (id: string) => Promise<void>;
  onDeleteNote: (id: string) => Promise<void>;
};

function formatWhen(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function NotesPopover({
  debrief,
  notes,
  visibleAnchors,
  ...noteOps
}: NoteOps & {
  debrief: DebriefView | null;
  notes: SelfReviewNoteView[];
  /** Paths with a file block on screen right now — the files of the diff in
   *  the current scope. Anchored notes on anything else are invisible inline,
   *  so they surface here (never silently orphaned). */
  visibleAnchors: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const general = useMemo(() => notes.filter((n) => n.anchor === null), [notes]);
  // File path → its orphaned notes (anchored, but no block on screen shows them).
  const orphansByFile = useMemo(() => {
    const m = new Map<string, SelfReviewNoteView[]>();
    for (const n of notes) {
      if (!n.anchor || visibleAnchors.has(n.anchor.file)) continue;
      const arr = m.get(n.anchor.file) ?? [];
      arr.push(n);
      m.set(n.anchor.file, arr);
    }
    return m;
  }, [notes, visibleAnchors]);

  const openCount =
    general.filter((n) => n.status === 'open').length +
    [...orphansByFile.values()].flat().filter((n) => n.status === 'open').length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: '0 0 auto' }}>
      <button
        type="button"
        className="btn"
        onClick={() => setOpen((o) => !o)}
        title="General notes on the whole change"
        style={open ? { background: 'var(--gray-100)' } : undefined}
      >
        <Icon name="comment-fill" size={12} color="var(--gray-600)" /> Notes
        {openCount > 0 && (
          <span className="badge badge-orange" style={{ marginLeft: 6 }}>
            {openCount}
          </span>
        )}
      </button>

      {open && (
        // biome-ignore lint/a11y/useSemanticElements: anchored popover; a styled div with role="dialog" matches the existing RepoMenu/NewReviewModal pattern rather than a native <dialog>.
        <div
          role="dialog"
          aria-label="General notes"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            width: 420,
            maxHeight: '70vh',
            display: 'flex',
            flexDirection: 'column',
            background: '#fff',
            borderRadius: 'var(--r-lg)',
            boxShadow: 'var(--sh-pop)',
            zIndex: 40,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--hairline)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Icon name="comment-fill" size={13} color="var(--gray-700)" />
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--gray-900)' }}>
              General notes
            </span>
            {debrief && (
              <span style={{ fontSize: 11, color: 'var(--gray-500)' }}>
                {debrief.chapters.length} chapter{debrief.chapters.length === 1 ? '' : 's'} ·
                updated {formatWhen(debrief.updatedAt)}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setAdding(true)}
              title="Add general feedback (not tied to a file)"
              style={{ color: 'var(--blue)', padding: '0 4px', height: 20 }}
            >
              <Icon name="plus" size={11} color="var(--blue)" /> Note
            </button>
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: '10px 14px' }}>
            {adding && (
              <Composer
                placeholder="General feedback on the whole change…"
                autoFocus
                onSave={(body) => {
                  const trimmed = body.trim();
                  if (!trimmed) {
                    setAdding(false);
                    return;
                  }
                  noteOps
                    .onCreateNote(null, trimmed)
                    .then(() => setAdding(false))
                    .catch(() => {
                      // Error surfaced via the hook's banner; keep the composer
                      // open so the author doesn't lose what they typed.
                    });
                }}
                onCancel={() => setAdding(false)}
              />
            )}
            {general.length === 0 && !adding && (
              <div style={{ fontSize: 12, color: 'var(--gray-500)', padding: '4px 0 8px' }}>
                No general notes yet — feedback here covers the whole change rather than one line.
              </div>
            )}
            {general.map((n) => (
              <Thread
                key={n.id}
                note={n}
                onReply={noteOps.onReplyNote}
                onResolve={noteOps.onResolveNote}
                onReopen={noteOps.onReopenNote}
                onDelete={noteOps.onDeleteNote}
              />
            ))}

            {orphansByFile.size > 0 && (
              <>
                <div
                  className="section-label"
                  style={{ padding: '12px 0 4px', color: 'var(--gray-500)' }}
                >
                  Other notes
                </div>
                <div style={{ fontSize: 11, color: 'var(--gray-500)', marginBottom: 6 }}>
                  Anchored to files with nothing on screen — gone from the diff, or changed only in
                  the working tree while “+ Uncommitted” is off.
                </div>
                {[...orphansByFile.entries()].map(([file, fileNotes]) => (
                  <div key={file} style={{ marginBottom: 8 }}>
                    <div
                      className="mono"
                      title={file}
                      style={{
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: 'var(--gray-700)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        padding: '2px 0',
                      }}
                    >
                      {file}
                    </div>
                    {fileNotes.map((n) => (
                      <Thread
                        key={n.id}
                        note={n}
                        onReply={noteOps.onReplyNote}
                        onResolve={noteOps.onResolveNote}
                        onReopen={noteOps.onReopenNote}
                        onDelete={noteOps.onDeleteNote}
                      />
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
