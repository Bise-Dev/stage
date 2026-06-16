import {
  type Ref,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Icon } from '../../components/Icon';
import type { NoteAnchor, SelfReviewFileChange, SelfReviewNoteView, Side } from '../../tauri';
import { type CommentRange, CommentableFileDiff, type ViewMode } from './CommentableFileDiff';
import { Composer } from './Composer';
import { Thread } from './Thread';

const STATUS_BADGE = {
  added: { label: 'added', cls: 'badge-green' },
  modified: { label: 'modified', cls: 'badge-orange' },
  deleted: { label: 'deleted', cls: 'badge-red' },
  renamed: { label: 'renamed', cls: 'badge-purple' },
} as const;

// Shared empty slice so files with no notes get a *stable* reference — keeps
// React.memo on FileBlock from re-rendering them when an unrelated file's
// notes change.
const EMPTY_NOTES: SelfReviewNoteView[] = [];

// A line note anchors inline at the *end* of its range (the widget sits below
// the last selected line). Module-scope (pure) so the render callbacks that use
// it aren't forced to list it as a dependency.
const lineEndOf = (n: SelfReviewNoteView): number => n.anchor?.lineEnd ?? n.anchor?.lineStart ?? 0;

// `ViewMode` lives with the shared diff surface (CommentableFileDiff); re-export
// it here so existing importers (SelfReview.tsx) are unaffected.
export type { ViewMode };
export type ViewLayout = 'scroll' | 'single';

export type DiffPaneHandle = {
  /** Scrolls the named file's block into view (used in `scroll` layout). */
  scrollFileIntoView(path: string): void;
};

/** The note operations DiffPane needs — a subset of the Debrief hook. */
type NoteOps = {
  /** Create a note; `anchor` is null for general feedback. */
  onCreateNote(anchor: NoteAnchor | null, body: string): Promise<void>;
  onReplyNote(id: string, body: string): Promise<void>;
  onResolveNote(id: string): Promise<void>;
  onReopenNote(id: string): Promise<void>;
  onDeleteNote(id: string): Promise<void>;
};

type DiffPaneProps = NoteOps & {
  files: SelfReviewFileChange[];
  viewLayout: ViewLayout;
  /** Which file the sidebar has selected; in 'single' layout determines what
   *  is rendered, in 'scroll' layout it's only the scroll target. */
  selectedPath: string | null;
  viewMode: ViewMode;
  viewed: Set<string>;
  onToggleViewed(path: string): void;
  /** All Review notes for the branch; DiffPane buckets them by file/anchor. */
  notes: SelfReviewNoteView[];
  /** React 19 ref-as-prop. Parent supplies a `useRef<DiffPaneHandle>(null)`. */
  ref?: Ref<DiffPaneHandle>;
};

/**
 * Renders one or many file diffs depending on `viewLayout`.
 *
 * - `scroll`: every file stacked vertically (GitHub-style). The sidebar
 *   acts as a jump-list — clicking a file scrolls its block into view.
 * - `single`: only the selected file is rendered. Lighter on first paint
 *   for diffs with many files, at the cost of needing sidebar clicks to
 *   move between files.
 *
 * Each FileBlock owns its own `DiffViewWithMultiSelect` and memoizes its
 * `data` prop, so a parent re-render doesn't rebuild the underlying
 * DiffFile or wipe the library's widget store. The blocks themselves are
 * `React.memo`'d and every prop crossing into them is referentially stable
 * (see the per-file note slices, the stable `registerRef`/`onToggleViewed`
 * callbacks, and the note ops from the Debrief hook), so marking one file
 * viewed or adding a note to one file commits only that block — not all N
 * mounted blocks.
 *
 * Diff annotations are **Review notes** (ADR-0012): the gutter drag and the
 * file-header "Note" button create line- and file-anchored notes; the rail
 * shows the same notes plus general (un-anchored) ones.
 */
export function DiffPane({
  files,
  viewLayout,
  selectedPath,
  viewMode,
  viewed,
  onToggleViewed,
  notes,
  onCreateNote,
  onReplyNote,
  onResolveNote,
  onReopenNote,
  onDeleteNote,
  ref,
}: DiffPaneProps) {
  const fileRefs = useRef(new Map<string, HTMLDivElement>());
  useImperativeHandle(
    ref,
    () => ({
      scrollFileIntoView(path: string) {
        fileRefs.current.get(path)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }),
    [],
  );

  // One stable ref registrar for every block — passed straight through, so a
  // block's `ref` callback identity doesn't change on parent re-renders.
  const registerFileRef = useCallback((path: string, el: HTMLDivElement | null) => {
    if (el) fileRefs.current.set(path, el);
    else fileRefs.current.delete(path);
  }, []);

  // Bundle the note ops once. They're already stable (useCallback in the
  // Debrief hook); memoizing the bundle keeps the spread below from minting a
  // fresh object literal each render.
  const noteOps: NoteOps = useMemo(
    () => ({ onCreateNote, onReplyNote, onResolveNote, onReopenNote, onDeleteNote }),
    [onCreateNote, onReplyNote, onResolveNote, onReopenNote, onDeleteNote],
  );

  // Bucket notes by file once, instead of `notes.filter(...)` per file per
  // render. Crucially we preserve each slice's array identity when its content
  // is unchanged: a note mutation replaces the whole `notes` array with fresh
  // objects, so without this every block would re-render on any note change.
  // With it, only the file whose notes actually changed gets a new slice.
  const prevSlicesRef = useRef<Map<string, SelfReviewNoteView[]>>(new Map());
  const prevSigsRef = useRef<Map<string, string>>(new Map());
  const notesByFile = useMemo(() => {
    const grouped = new Map<string, SelfReviewNoteView[]>();
    for (const n of notes) {
      const file = n.anchor?.file;
      if (!file) continue;
      const arr = grouped.get(file);
      if (arr) arr.push(n);
      else grouped.set(file, [n]);
    }
    const prevSlices = prevSlicesRef.current;
    const prevSigs = prevSigsRef.current;
    const nextSlices = new Map<string, SelfReviewNoteView[]>();
    const nextSigs = new Map<string, string>();
    for (const [path, arr] of grouped) {
      const sig = JSON.stringify(arr);
      const reused = prevSlices.get(path);
      if (reused && prevSigs.get(path) === sig) {
        nextSlices.set(path, reused);
      } else {
        nextSlices.set(path, arr);
      }
      nextSigs.set(path, sig);
    }
    prevSlicesRef.current = nextSlices;
    prevSigsRef.current = nextSigs;
    return nextSlices;
  }, [notes]);

  const visibleFiles =
    viewLayout === 'scroll' ? files : files.filter((f) => f.path === selectedPath);

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        background: 'var(--gray-50)',
        overflow: 'auto',
        padding: '12px 14px',
      }}
    >
      {visibleFiles.length === 0 ? (
        <div
          style={{
            padding: '40px 20px',
            textAlign: 'center',
            color: 'var(--gray-500)',
            fontSize: 13,
          }}
        >
          {files.length === 0
            ? 'No changes to review on this branch.'
            : 'Pick a file from the sidebar.'}
        </div>
      ) : (
        visibleFiles.map((f) => {
          const isViewed = viewed.has(f.path);
          // Viewed files collapse to a header-only row in scroll mode
          // (GitHub's behavior — clears clutter as the author moves
          // through their review). In single mode the user has explicitly
          // navigated to a file, so don't second-guess them.
          const collapsed = isViewed && viewLayout === 'scroll';
          return (
            <LazyFileBlock
              key={f.path}
              file={f}
              registerRef={registerFileRef}
              viewMode={viewMode}
              collapsed={collapsed}
              isViewed={isViewed}
              onToggleViewed={onToggleViewed}
              notes={notesByFile.get(f.path) ?? EMPTY_NOTES}
              {...noteOps}
            />
          );
        })
      )}
    </div>
  );
}

/**
 * Lazy-mount wrapper around FileBlock for the `scroll` layout. Big PRs
 * stacked all the FileBlocks at once paid the tokenize-and-render cost
 * eagerly for every file, which made scrolling and even typing in a
 * composer noticeably laggy. Each file now starts as a fixed-height
 * placeholder and swaps in the real FileBlock once it crosses near the
 * viewport (IntersectionObserver with a 600px rootMargin). Once mounted
 * it stays mounted — unmounting would lose composer state and notes
 * in flight.
 *
 * Memoized: a parent re-render (e.g. marking *another* file viewed) shouldn't
 * touch this block at all, since every prop it receives is referentially
 * stable.
 */
type LazyFileBlockProps = FileBlockProps & {
  registerRef(path: string, el: HTMLDivElement | null): void;
};
const LazyFileBlock = memo(function LazyFileBlock({ registerRef, ...rest }: LazyFileBlockProps) {
  const [mounted, setMounted] = useState(false);
  const localRef = useRef<HTMLDivElement>(null);
  const path = rest.file.path;
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      localRef.current = el;
      registerRef(path, el);
    },
    [registerRef, path],
  );

  // Collapsed files render as a tiny header-only row; no need to defer them
  // behind an IntersectionObserver — the cost is already minimal and
  // making them eager keeps the toggle (mark unviewed) immediately
  // responsive when the user scans the list.
  const eager = mounted || rest.collapsed;

  useEffect(() => {
    if (eager) return;
    const node = localRef.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setMounted(true);
          obs.disconnect();
        }
      },
      // Preload before they hit the viewport so scrolling feels smooth.
      { rootMargin: '600px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [eager]);

  if (eager) {
    return (
      <div ref={setRef}>
        <FileBlock {...rest} />
      </div>
    );
  }

  // Cheap estimate of the rendered block's height so the scrollbar stays
  // close to truthful before the real mount. 18px per line + ~80px chrome,
  // clamped so a 10k-line file doesn't reserve the whole window.
  const lines = rest.file.additions + rest.file.deletions;
  const estimated = Math.min(800, 80 + lines * 18);
  const badge = STATUS_BADGE[rest.file.status];
  return (
    <div
      ref={setRef}
      style={{
        background: '#fff',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r-md)',
        marginBottom: 14,
        minHeight: estimated,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: 36,
          flex: '0 0 36px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 14px',
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <span
          className="mono"
          style={{ fontSize: 12.5, color: 'var(--gray-800)', fontWeight: 500 }}
        >
          {rest.file.path}
        </span>
        <span className={`badge ${badge.cls}`}>{badge.label}</span>
        <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
          +{rest.file.additions} −{rest.file.deletions}
        </span>
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11.5,
          color: 'var(--gray-400)',
        }}
      >
        scroll to load
      </div>
    </div>
  );
});

type FileBlockProps = NoteOps & {
  file: SelfReviewFileChange;
  viewMode: ViewMode;
  /** When true, render only the header row — the user has marked the file
   *  viewed and we're in scroll layout (see DiffPane). */
  collapsed: boolean;
  isViewed: boolean;
  /** Stable parent callback; the block calls it with its own `file.path`. */
  onToggleViewed(path: string): void;
  /** Notes anchored to this file (line- or file-level). */
  notes: SelfReviewNoteView[];
};

const FileBlock = memo(function FileBlock({
  file,
  viewMode,
  collapsed,
  isViewed,
  onToggleViewed,
  notes,
  onCreateNote,
  onReplyNote,
  onResolveNote,
  onReopenNote,
  onDeleteNote,
}: FileBlockProps) {
  const badge = STATUS_BADGE[file.status];
  // A file-level note composer toggled by the header "Note" button. Line-level
  // creation goes through the library's widget slot (renderWidgetLine) and
  // reply composers live inside each Thread, so this is the only local
  // composer state the block needs.
  const [addingFile, setAddingFile] = useState(false);

  // Partition the file's notes:
  //  - inline line notes: a fresh line anchor renders at its line via extendData;
  //  - band notes: file-level notes (no line range) and *outdated* line notes
  //    whose anchored lines are gone — they have no inline slot, so they sit in
  //    a band above the diff (they also live in the rail).
  // All hooks below run unconditionally, *before* the collapsed early-return,
  // so the hook order is stable when a file toggles between collapsed and
  // expanded on the same fiber.
  const lineNotes = useMemo(
    () => notes.filter((n) => n.anchor?.lineStart != null && !n.outdated),
    [notes],
  );
  const fileLevel = useMemo(
    () => notes.filter((n) => n.anchor != null && n.anchor.lineStart == null),
    [notes],
  );
  const outdated = useMemo(
    () => notes.filter((n) => n.anchor?.lineStart != null && n.outdated),
    [notes],
  );
  const bandNotes = useMemo(() => [...fileLevel, ...outdated], [fileLevel, outdated]);

  // Project the inline line-notes onto the shared diff surface: each renders at
  // the *end* of its range (the widget sits below the last line). The shared
  // CommentableFileDiff owns the library wiring; here we only say *where* threads
  // anchor and *how* to render them (a local Thread) + *how* to create one.
  const inlineAnchors = useMemo(
    () => lineNotes.map((n) => ({ side: n.anchor?.side ?? 'right', line: lineEndOf(n) })),
    [lineNotes],
  );

  const renderInline = useCallback(
    (side: Side, line: number) => {
      const threads = lineNotes.filter(
        (n) => (n.anchor?.side ?? 'right') === side && lineEndOf(n) === line,
      );
      if (threads.length === 0) return null;
      return threads.map((n) => (
        <Thread
          key={n.id}
          note={n}
          onReply={onReplyNote}
          onResolve={onResolveNote}
          onReopen={onReopenNote}
          onDelete={onDeleteNote}
        />
      ));
    },
    [lineNotes, onReplyNote, onResolveNote, onReopenNote, onDeleteNote],
  );

  const handleCreate = useCallback(
    (range: CommentRange, body: string) =>
      onCreateNote(
        { file: file.path, lineStart: range.lineStart, lineEnd: range.lineEnd, side: range.side },
        body,
      ),
    [file.path, onCreateNote],
  );

  // Header-only render when collapsed. We keep the same chrome so the
  // toggle stays in place — clicking "Viewed" again expands the file back.
  if (collapsed) {
    return (
      <div
        style={{
          background: '#fff',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--r-md)',
          marginBottom: 14,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 36,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 14px',
          }}
        >
          <span
            className="mono"
            style={{ fontSize: 12.5, color: 'var(--gray-500)', fontWeight: 500 }}
          >
            {file.path}
          </span>
          <span className={`badge ${badge.cls}`}>{badge.label}</span>
          <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
            +{file.additions} −{file.deletions}
          </span>
          {notes.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--gray-500)' }}>
              · {notes.length} note{notes.length === 1 ? '' : 's'}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="btn"
            onClick={() => onToggleViewed(file.path)}
            style={{ background: 'rgba(52,199,89,0.14)', color: 'var(--green-d)' }}
          >
            <Icon name="check" size={11} /> Viewed
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r-md)',
        marginBottom: 14,
        overflow: 'hidden',
      }}
    >
      {/* File header */}
      <div
        style={{
          height: 36,
          flex: '0 0 36px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 14px',
          borderBottom: '1px solid var(--hairline)',
          background: '#fff',
        }}
      >
        <span
          className="mono"
          style={{ fontSize: 12.5, color: 'var(--gray-800)', fontWeight: 500 }}
        >
          {file.path}
        </span>
        <span className={`badge ${badge.cls}`}>{badge.label}</span>
        <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
          +{file.additions} −{file.deletions}
        </span>
        {file.isBinary && (
          <span className="badge" style={{ background: 'rgba(0,0,0,0.06)' }}>
            binary
          </span>
        )}
        {file.isTruncated && (
          <span className="badge badge-orange" title="Diff was clipped at 256 KB">
            truncated
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn"
          onClick={() => setAddingFile(true)}
          title="Add a file-level Review note"
        >
          <Icon name="comment-fill" size={11} /> Note
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onToggleViewed(file.path)}
          style={
            isViewed ? { background: 'rgba(52,199,89,0.14)', color: 'var(--green-d)' } : undefined
          }
        >
          <Icon name={isViewed ? 'check' : 'eye'} size={11} /> {isViewed ? 'Viewed' : 'Mark viewed'}
        </button>
      </div>

      {/* Outdated band */}
      {outdated.length > 0 && (
        <div
          style={{
            padding: '6px 14px',
            background: 'rgba(255,149,0,0.06)',
            borderBottom: '1px solid rgba(255,149,0,0.18)',
            fontSize: 11.5,
            color: '#b56500',
          }}
        >
          {outdated.length} note{outdated.length === 1 ? '' : 's'} lost their anchor — the lines
          were edited or removed. Resolve or delete below (they also remain in the rail).
        </div>
      )}

      {/* File-level + outdated notes above the diff */}
      {(bandNotes.length > 0 || addingFile) && (
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--hairline-2)' }}>
          {bandNotes.map((n) => (
            <Thread
              key={n.id}
              note={n}
              onReply={onReplyNote}
              onResolve={onResolveNote}
              onReopen={onReopenNote}
              onDelete={onDeleteNote}
            />
          ))}
          {addingFile && (
            <Composer
              placeholder="File-level note…"
              autoFocus
              onSave={(body) => {
                const trimmed = body.trim();
                if (!trimmed) {
                  setAddingFile(false);
                  return;
                }
                onCreateNote(
                  { file: file.path, lineStart: null, lineEnd: null, side: null },
                  trimmed,
                )
                  .then(() => setAddingFile(false))
                  .catch(() => {
                    // Error surfaced via the hook's banner; keep the composer
                    // open so the author doesn't lose what they typed.
                  });
              }}
              onCancel={() => setAddingFile(false)}
            />
          )}
        </div>
      )}

      {/* The diff + inline-comment surface, shared with the reviewer storyline
          (Step 4). It owns the @git-diff-view wiring (drag→Composer, inline
          thread slots); here we feed it the line-note anchors, a Thread renderer,
          and the create handler. Binary/truncated/empty fallbacks live inside it. */}
      <CommentableFileDiff
        file={file}
        viewMode={viewMode}
        inlineAnchors={inlineAnchors}
        renderInline={renderInline}
        onCreate={handleCreate}
        composerPlaceholder="Leave a note…"
      />
    </div>
  );
});
