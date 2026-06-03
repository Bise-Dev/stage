import { useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from '../../components/Icon';
import type {
  Debrief,
  NoteAnchor,
  NoteStatus,
  ReviewNoteView,
  SelfReviewFileChange,
} from '../../tauri';
import { Composer } from './Composer';

/**
 * The Debrief rail — the author's view of the agent's self-review (ADR-0011,
 * CONTEXT.md "Debrief"). Lists the agent's ordered steps (file + markdown
 * intro), each driving the diff (click a step → scroll its file into view),
 * and the **Review notes** anchored to each file: their status, the agent's
 * reply, an `outdated` flag, and resolve/reopen actions. The author adds new
 * notes here; the agent reads them back via the `stage` CLI.
 *
 * Note creation is file-anchored in this first cut (the data model + commands
 * carry an optional line range; a line-level gutter affordance is a follow-up).
 */

const NOTE_STATUS: Record<NoteStatus, { label: string; cls: string }> = {
  open: { label: 'open', cls: 'badge-orange' },
  addressed: { label: 'addressed', cls: 'badge-blue' },
  resolved: { label: 'resolved', cls: 'badge-green' },
};

function formatWhen(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function anchorRange(anchor: NoteAnchor): string | null {
  if (anchor.lineStart == null) return null;
  if (anchor.lineEnd == null || anchor.lineEnd === anchor.lineStart) return `L${anchor.lineStart}`;
  return `L${anchor.lineStart}–L${anchor.lineEnd}`;
}

export function DebriefRail({
  debrief,
  notes,
  files,
  selectedPath,
  onSelectFile,
  onCreateNote,
  onResolveNote,
  onReopenNote,
  onClose,
}: {
  debrief: Debrief | null;
  notes: ReviewNoteView[];
  files: SelfReviewFileChange[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onCreateNote: (anchor: NoteAnchor, body: string) => Promise<void>;
  onResolveNote: (id: string) => Promise<void>;
  onReopenNote: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  // Path → notes, in store order (newest first from the backend).
  const notesByFile = useMemo(() => {
    const m = new Map<string, ReviewNoteView[]>();
    for (const n of notes) {
      const arr = m.get(n.anchor.file) ?? [];
      arr.push(n);
      m.set(n.anchor.file, arr);
    }
    return m;
  }, [notes]);

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
          <>
            <span className="badge mono" style={{ background: 'rgba(0,0,0,0.06)' }}>
              {debrief.base}
            </span>
            {openCount > 0 && (
              <span className="badge badge-orange">
                {openCount} open note{openCount === 1 ? '' : 's'}
              </span>
            )}
          </>
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
                notes={notesByFile.get(step.file) ?? []}
                onSelect={() => onSelectFile(step.file)}
                onCreateNote={onCreateNote}
                onResolveNote={onResolveNote}
                onReopenNote={onReopenNote}
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
                    notes={notesByFile.get(file) ?? []}
                    onSelect={() => onSelectFile(file)}
                    onCreateNote={onCreateNote}
                    onResolveNote={onResolveNote}
                    onReopenNote={onReopenNote}
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

function StepCard({
  file,
  intro,
  meta,
  inDiff,
  active,
  notes,
  onSelect,
  onCreateNote,
  onResolveNote,
  onReopenNote,
}: {
  file: string;
  intro: string | null;
  meta: SelfReviewFileChange | undefined;
  inDiff: boolean;
  active: boolean;
  notes: ReviewNoteView[];
  onSelect: () => void;
  onCreateNote: (anchor: NoteAnchor, body: string) => Promise<void>;
  onResolveNote: (id: string) => Promise<void>;
  onReopenNote: (id: string) => Promise<void>;
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
      {/* File header — click to drive the diff */}
      <button
        type="button"
        onClick={onSelect}
        title={file}
        style={{
          width: '100%',
          textAlign: 'left',
          border: 'none',
          background: active ? 'var(--blue-tint)' : 'transparent',
          cursor: 'default',
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          padding: '8px 10px',
          fontFamily: 'inherit',
        }}
      >
        <span
          className="mono"
          style={{
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
      </button>

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
            <NoteCard
              key={n.id}
              note={n}
              onResolve={() => onResolveNote(n.id)}
              onReopen={() => onReopenNote(n.id)}
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
              onCreateNote({ file, lineStart: null, lineEnd: null }, trimmed)
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

function NoteCard({
  note,
  onResolve,
  onReopen,
}: {
  note: ReviewNoteView;
  onResolve: () => void;
  onReopen: () => void;
}) {
  const status = NOTE_STATUS[note.status];
  const range = anchorRange(note.anchor);
  const resolved = note.status === 'resolved';

  return (
    <div
      style={{
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r-sm)',
        padding: '6px 8px',
        margin: '6px 0',
        background: resolved ? 'var(--gray-50)' : '#fff',
        fontSize: 12,
        color: 'var(--gray-800)',
        opacity: resolved ? 0.75 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span className={`badge ${status.cls}`}>{status.label}</span>
        {range && (
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--blue-press)' }}>
            {range}
          </span>
        )}
        {note.outdated && (
          <span
            className="badge badge-orange"
            title="The anchored file left the diff — this feedback may be obsolete"
          >
            outdated
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: 'var(--gray-400)' }}>{formatWhen(note.createdAt)}</span>
      </div>
      <div style={{ whiteSpace: 'pre-wrap' }}>{note.body}</div>

      {note.agentReply && (
        <div
          style={{
            marginTop: 6,
            paddingTop: 6,
            borderTop: '1px solid var(--hairline-2)',
            whiteSpace: 'pre-wrap',
            color: 'var(--gray-600)',
          }}
        >
          <span
            style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--green-d)', marginRight: 6 }}
          >
            AGENT
          </span>
          {note.agentReply}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: 6,
          marginTop: 6,
          paddingTop: 6,
          borderTop: '1px solid var(--hairline-2)',
        }}
      >
        <div style={{ flex: 1 }} />
        {resolved ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onReopen}
            style={{ color: 'var(--blue)', padding: '0 4px', height: 20 }}
          >
            Reopen
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onResolve}
            style={{ color: 'var(--green-d)', padding: '0 4px', height: 20 }}
          >
            <Icon name="check" size={10} color="var(--green-d)" /> Resolve
          </button>
        )}
      </div>
    </div>
  );
}
