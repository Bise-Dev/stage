import { useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from '../../components/Icon';
import type { Debrief, NoteAnchor, ReviewNoteView, SelfReviewFileChange } from '../../tauri';
import { Composer } from './Composer';
import { Thread } from './Thread';

/**
 * The Debrief rail — the author's view of the agent's self-review (ADR-0011,
 * CONTEXT.md "Debrief"). Lists the agent's ordered steps (file + markdown
 * intro), each driving the diff (click a step → scroll its file into view),
 * and the **Review notes** anchored to each file. It is also the home for
 * notes with no inline anchor: general (un-anchored) feedback and notes whose
 * anchored lines left the diff (ADR-0012). Anchored notes also render inline in
 * the diff; the rail is the index + overview.
 */

/** Note operations the rail forwards to each Thread / composer. */
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

export function DebriefRail({
  debrief,
  notes,
  files,
  selectedPath,
  viewed,
  onSelectFile,
  onToggleViewed,
  onClose,
  ...noteOps
}: NoteOps & {
  debrief: Debrief | null;
  notes: ReviewNoteView[];
  files: SelfReviewFileChange[];
  selectedPath: string | null;
  /** The shared mark-viewed set (same store the file list + diff use). */
  viewed: Set<string>;
  onSelectFile: (path: string) => void;
  onToggleViewed: (path: string) => void;
  onClose: () => void;
}) {
  // Path → anchored notes, in store order (newest first from the backend).
  const notesByFile = useMemo(() => {
    const m = new Map<string, ReviewNoteView[]>();
    for (const n of notes) {
      const file = n.anchor?.file;
      if (!file) continue;
      const arr = m.get(file) ?? [];
      arr.push(n);
      m.set(file, arr);
    }
    return m;
  }, [notes]);

  const general = useMemo(() => notes.filter((n) => n.anchor === null), [notes]);

  const fileMeta = useMemo(() => {
    const m = new Map<string, SelfReviewFileChange>();
    for (const f of files) m.set(f.path, f);
    return m;
  }, [files]);

  const steps = debrief ? [...debrief.steps].sort((a, b) => a.order - b.order) : [];
  const stepFiles = new Set(steps.map((s) => s.file));
  // Notes whose file isn't a Debrief step (the agent dropped the file from a
  // later pass, or the note predates this Debrief) — surface them so feedback
  // is never silently orphaned.
  const orphanFiles = [...notesByFile.keys()].filter((f) => !stepFiles.has(f));

  const openCount = notes.filter((n) => n.status === 'open').length;

  return (
    <div
      style={{
        width: 360,
        flex: '0 0 360px',
        borderLeft: '1px solid var(--hairline)',
        background: '#fbfaf8',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* Rail header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: '1px solid var(--hairline)',
          background: '#fff',
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--gray-800)' }}>
          Agent Debrief
        </span>
        {debrief && (
          <span className="badge mono" style={{ background: 'rgba(0,0,0,0.06)' }}>
            {debrief.base}
          </span>
        )}
        {openCount > 0 && (
          <span className="badge badge-orange">
            {openCount} open note{openCount === 1 ? '' : 's'}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onClose}
          title="Hide the Debrief rail"
          style={{ padding: '0 6px' }}
        >
          <Icon name="chevron-right" size={12} color="var(--gray-500)" />
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '10px 12px' }}>
        <GeneralNotes notes={general} {...noteOps} />

        {!debrief ? (
          <div
            style={{ fontSize: 12, color: 'var(--gray-500)', lineHeight: 1.5, padding: '8px 2px' }}
          >
            No Debrief yet for this branch. Ask your coding agent to run the{' '}
            <span className="mono">self-review-debrief</span> skill — it writes an ordered,
            annotated account of its changes here for you to review.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 11, color: 'var(--gray-500)', marginBottom: 8 }}>
              {steps.length} step{steps.length === 1 ? '' : 's'} · updated{' '}
              {formatWhen(debrief.updatedAt)}
            </div>
            {steps.map((step) => (
              <StepCard
                key={step.file}
                file={step.file}
                intro={step.intro}
                meta={fileMeta.get(step.file)}
                inDiff={fileMeta.has(step.file)}
                active={step.file === selectedPath}
                isViewed={viewed.has(step.file)}
                notes={notesByFile.get(step.file) ?? []}
                onSelect={() => onSelectFile(step.file)}
                onToggleViewed={() => onToggleViewed(step.file)}
                {...noteOps}
              />
            ))}

            {orphanFiles.length > 0 && (
              <>
                <div
                  className="section-label"
                  style={{ padding: '12px 2px 4px', color: 'var(--gray-500)' }}
                >
                  Notes on other files
                </div>
                {orphanFiles.map((file) => (
                  <StepCard
                    key={file}
                    file={file}
                    intro={null}
                    meta={fileMeta.get(file)}
                    inDiff={fileMeta.has(file)}
                    active={file === selectedPath}
                    isViewed={viewed.has(file)}
                    notes={notesByFile.get(file) ?? []}
                    onSelect={() => onSelectFile(file)}
                    onToggleViewed={() => onToggleViewed(file)}
                    {...noteOps}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** General (un-anchored) feedback — the rail is its only home (ADR-0012). */
function GeneralNotes({
  notes,
  onCreateNote,
  onReplyNote,
  onResolveNote,
  onReopenNote,
  onDeleteNote,
}: NoteOps & { notes: ReviewNoteView[] }) {
  const [adding, setAdding] = useState(false);

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 2px 4px',
        }}
      >
        <span className="section-label" style={{ color: 'var(--gray-500)' }}>
          General notes
        </span>
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
      {notes.map((n) => (
        <Thread
          key={n.id}
          note={n}
          onReply={onReplyNote}
          onResolve={onResolveNote}
          onReopen={onReopenNote}
          onDelete={onDeleteNote}
        />
      ))}
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
            onCreateNote(null, trimmed)
              .then(() => setAdding(false))
              .catch(() => {
                // Error surfaced via the hook's banner; keep the composer open.
              });
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function StepCard({
  file,
  intro,
  meta,
  inDiff,
  active,
  isViewed,
  notes,
  onSelect,
  onToggleViewed,
  onCreateNote,
  onReplyNote,
  onResolveNote,
  onReopenNote,
  onDeleteNote,
}: NoteOps & {
  file: string;
  intro: string | null;
  meta: SelfReviewFileChange | undefined;
  inDiff: boolean;
  active: boolean;
  isViewed: boolean;
  notes: ReviewNoteView[];
  onSelect: () => void;
  onToggleViewed: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const name = file.split('/').pop() ?? file;
  const dir = file.slice(0, file.length - name.length);

  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${active ? 'var(--blue-tint-2)' : 'var(--hairline)'}`,
        borderRadius: 'var(--r-md)',
        boxShadow: 'var(--sh-1)',
        marginBottom: 10,
        overflow: 'hidden',
      }}
    >
      {/* File header — two rows: filename, then viewed + counts. */}
      <div style={{ background: active ? 'var(--blue-tint)' : 'transparent' }}>
        {/* Row 1: filename — click to drive the diff. */}
        <button
          type="button"
          onClick={onSelect}
          title={file}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            border: 'none',
            background: 'transparent',
            cursor: 'default',
            padding: '8px 10px 2px',
            fontFamily: 'inherit',
          }}
        >
          <span
            className="mono"
            style={{
              display: 'block',
              fontSize: 12,
              fontWeight: 600,
              color: active ? 'var(--blue-press)' : 'var(--gray-800)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {dir && <span style={{ color: 'var(--gray-400)', fontWeight: 400 }}>{dir}</span>}
            {name}
          </span>
        </button>
        {/* Row 2: viewed checkbox + additions/deletions (or a stale flag). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px 8px' }}>
          <span
            // biome-ignore lint/a11y/useSemanticElements: mirrors the FileList row checkbox; a native checkbox inherits OS styling we don't want.
            role="checkbox"
            aria-checked={isViewed}
            aria-label="Mark viewed"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onToggleViewed();
            }}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                onToggleViewed();
              }
            }}
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              border: '1px solid var(--gray-300)',
              background: isViewed ? 'var(--green-d)' : '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: 10,
              flex: '0 0 14px',
              cursor: 'default',
            }}
          >
            {isViewed ? '✓' : ''}
          </span>
          <span style={{ fontSize: 10.5, color: 'var(--gray-500)' }}>
            {isViewed ? 'Viewed' : 'Mark viewed'}
          </span>
          <div style={{ flex: 1 }} />
          {meta ? (
            <span style={{ fontSize: 10.5, color: 'var(--gray-500)', whiteSpace: 'nowrap' }}>
              <span style={{ color: 'var(--green-d)' }}>+{meta.additions}</span>{' '}
              <span style={{ color: 'var(--red-d)' }}>−{meta.deletions}</span>
            </span>
          ) : (
            <span
              className="badge badge-orange"
              title="This file is no longer in the current diff (stale step)"
            >
              stale
            </span>
          )}
        </div>
      </div>

      {/* Agent intro (markdown) */}
      {intro && (
        <div
          className="md"
          style={{
            padding: '6px 10px 8px',
            borderTop: '1px solid var(--hairline-2)',
            fontSize: 12,
          }}
        >
          <Markdown remarkPlugins={[remarkGfm]}>{intro}</Markdown>
        </div>
      )}

      {/* Review notes for this file */}
      {notes.length > 0 && (
        <div style={{ padding: '4px 10px 2px', borderTop: '1px solid var(--hairline-2)' }}>
          {notes.map((n) => (
            <Thread
              key={n.id}
              note={n}
              onReply={onReplyNote}
              onResolve={onResolveNote}
              onReopen={onReopenNote}
              onDelete={onDeleteNote}
            />
          ))}
        </div>
      )}

      {/* Add-note affordance */}
      <div style={{ padding: '4px 10px 8px', borderTop: '1px solid var(--hairline-2)' }}>
        {adding ? (
          <Composer
            placeholder={`Review note on ${name}…`}
            autoFocus
            onSave={(body) => {
              const trimmed = body.trim();
              if (!trimmed) {
                setAdding(false);
                return;
              }
              onCreateNote({ file, lineStart: null, lineEnd: null, side: null }, trimmed)
                .then(() => setAdding(false))
                .catch(() => {
                  // Error surfaced via the hook's banner; keep the composer
                  // open so the author doesn't lose what they typed.
                });
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setAdding(true)}
            disabled={!inDiff}
            title={inDiff ? 'Add a Review note on this file' : 'File is not in the current diff'}
            style={{
              color: 'var(--blue)',
              padding: '0 4px',
              height: 22,
              opacity: inDiff ? 1 : 0.5,
            }}
          >
            <Icon name="plus" size={11} color="var(--blue)" /> Review note
          </button>
        )}
      </div>
    </div>
  );
}
