import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import {
  reviewDraftCreate,
  reviewDraftGet,
  selfReviewDoneGet,
  selfReviewDoneSet,
} from '../../tauri';
import { DebriefRail } from '../selfReview/DebriefRail';
import {
  DiffPane,
  type DiffPaneHandle,
  type ViewLayout,
  type ViewMode,
} from '../selfReview/DiffPane';
import { FileList, committedId } from '../selfReview/FileList';
import { Subheader } from '../selfReview/Subheader';
import { ResizeHandle, useColumnWidth } from '../selfReview/columnResize';
import { notesToMarkdown } from '../selfReview/markdown';
import { clearViewed, loadViewed, setViewed } from '../selfReview/viewedMarks';
import type { ShellModeBodyProps } from './modes';
import { useSectionedDiff } from './useSectionedDiff';

/**
 * Self-Review mode of the review shell (v6-light L5) — the author-only
 * iterative stage, re-housed from the standalone SelfReview screen.
 *
 * Scope model (flag F4): the committed diff (`merge_base(base, HEAD) → HEAD`)
 * is the reviewable unit; "+ Uncommitted" folds the working tree in as a
 * separate section. "Mark reviewed" (flag F3) is the mode primary. The
 * Debrief rail stays (flag F9) as the agent-context / Q&A home.
 */
const LAYOUT_KEY = 'selfReview:viewLayout';
const VIEWMODE_KEY = 'selfReview:viewMode';

function loadLayout(): ViewLayout {
  return localStorage.getItem(LAYOUT_KEY) === 'single' ? 'single' : 'scroll';
}
function loadViewMode(): ViewMode {
  return localStorage.getItem(VIEWMODE_KEY) === 'split' ? 'split' : 'unified';
}

export function SelfReviewMode({
  shell,
  debriefState,
  onExit,
  onEnterStoryline,
}: ShellModeBodyProps) {
  const { repoPath, defaultBranch, baseRef, setBaseRef, branches, baseOptions } = shell;
  const [viewMode, setViewModeState] = useState<ViewMode>(loadViewMode);
  const [viewLayout, setViewLayoutState] = useState<ViewLayout>(loadLayout);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [viewed, setViewedState] = useState<Set<string>>(new Set());
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [localError, setLocalError] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const diffPaneRef = useRef<DiffPaneHandle>(null);

  const setViewLayout = useCallback((v: ViewLayout) => {
    localStorage.setItem(LAYOUT_KEY, v);
    setViewLayoutState(v);
  }, []);
  // Persisted split/unified choice (v6-light L5 — previously reset per mount).
  const setViewMode = useCallback((v: ViewMode) => {
    localStorage.setItem(VIEWMODE_KEY, v);
    setViewModeState(v);
  }, []);

  // Resizable file-list + Debrief-rail columns (persisted, clamped).
  const fileListCol = useColumnWidth('selfReview:fileListWidth', 260, 180, 480, 'right');
  const railCol = useColumnWidth('selfReview:railWidth', 360, 280, 560, 'left');

  const {
    committed,
    workdir,
    includeUncommitted,
    setIncludeUncommitted,
    uncommittedCount,
    loading,
    error,
  } = useSectionedDiff(repoPath, baseRef);

  const {
    debrief,
    notes,
    error: debriefError,
    createNote,
    replyNote,
    resolveNote,
    reopenNote,
    deleteNote,
  } = debriefState;

  // The rail starts closed and auto-opens once when a Debrief first appears, so
  // the agent path is discoverable without intruding on the non-agent path.
  // After that the author's toggle wins (we never auto-close or re-open).
  const [railOpen, setRailOpen] = useState(false);
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (debrief && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setRailOpen(true);
    }
  }, [debrief]);
  const openNoteCount = useMemo(() => notes.filter((n) => n.status === 'open').length, [notes]);

  // The Debrief's narrated files, flattened across its chapters in
  // presentation order (ADR-0025).
  const debriefFileOrder = useMemo(
    () => (debrief?.chapters ?? []).flatMap((c) => c.files),
    [debrief],
  );
  const debriefPaths = useMemo(() => new Set(debriefFileOrder), [debriefFileOrder]);

  // The committed section's ordered file list (see the pre-shell SelfReview
  // for the full rationale): Debrief chapters order the files they narrate,
  // everything else keeps the diff's path order below them.
  const orderedFiles = useMemo(() => {
    const files = committed?.files ?? [];
    if (debriefPaths.size === 0) return files;
    const orderOf = new Map(debriefFileOrder.map((file, i) => [file, i]));
    return [...files].sort((a, b) => {
      const ai = orderOf.get(a.path);
      const bi = orderOf.get(b.path);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return 0;
    });
  }, [committed, debriefFileOrder, debriefPaths]);

  const currentBranch = workdir?.currentBranch ?? null;
  const headSha = committed?.headSha ?? null;

  // Mark-viewed state, engine-backed per (repo, branch) and content-anchored
  // (F2b): reload on branch/head changes so only currently-valid marks show.
  useEffect(() => {
    if (!repoPath || !currentBranch) return;
    // Deliberate `headSha` dependency: marks are content-anchored, so a
    // commit/checkout must re-read which marks are still valid.
    void headSha;
    let cancelled = false;
    loadViewed(repoPath, currentBranch).then(
      (s) => {
        if (!cancelled) setViewedState(s);
      },
      (e) => {
        // Loud per CLAUDE.md: a failed load (or legacy import) lands in the
        // screen's error slot, not a silent empty set.
        if (!cancelled) setLocalError(String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repoPath, currentBranch, headSha]);

  const viewedRef = useRef(viewed);
  viewedRef.current = viewed;

  const toggleViewed = useCallback(
    (path: string) => {
      if (!repoPath || !currentBranch) return;
      const isOn = viewedRef.current.has(path);
      setViewedState((prev) => {
        const next = new Set(prev);
        if (isOn) next.delete(path);
        else next.add(path);
        return next;
      });
      setViewed(repoPath, currentBranch, path, !isOn).catch((e) => {
        // The mark didn't persist — say so (CLAUDE.md fail-loud) and undo the
        // optimistic flip so the checkbox shows the stored truth.
        console.warn('self_review_viewed_persist_failed', e);
        setLocalError(String(e));
        setViewedState((prev) => {
          const next = new Set(prev);
          if (isOn) next.add(path);
          else next.delete(path);
          return next;
        });
      });
    },
    [repoPath, currentBranch],
  );

  const onClearViewed = useCallback(async () => {
    if (!repoPath || !currentBranch) return;
    setViewedState(new Set());
    try {
      await clearViewed(repoPath, currentBranch);
    } catch (e) {
      console.warn('self_review_viewed_clear_failed', e);
      setLocalError(String(e));
    }
  }, [repoPath, currentBranch]);

  // "Mark reviewed" (flag F3): explicit, SHA-bound; the engine derives
  // validity at read time, so a new head silently withdraws it — we re-read
  // on head changes for the same reason viewed marks do.
  const [doneAt, setDoneAt] = useState<number | null>(null);
  useEffect(() => {
    if (!currentBranch) return;
    void headSha;
    let cancelled = false;
    selfReviewDoneGet(currentBranch).then(
      (d) => {
        if (!cancelled) setDoneAt(d);
      },
      (e) => {
        console.warn('self_review_done_get_failed', e);
        if (!cancelled) setLocalError(String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [currentBranch, headSha]);

  const onToggleDone = useCallback(async () => {
    if (!currentBranch) return;
    const next = doneAt === null;
    try {
      await selfReviewDoneSet(currentBranch, next);
      setDoneAt(await selfReviewDoneGet(currentBranch));
    } catch (e) {
      console.warn('self_review_done_set_failed', e);
      setLocalError(String(e));
    }
  }, [currentBranch, doneAt]);

  // Cmd/Ctrl-F focuses the filter input; Escape (when not in an input) exits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
      } else if (e.key === 'Escape') {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          onExit();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  // File selection auto-tracks the head of the ordered list until the author
  // makes a deliberate pick (see the pre-shell SelfReview for the `stage
  // open` re-pin rationale).
  const userPickedRef = useRef(false);
  useEffect(() => {
    if (!committed) return;
    const head = orderedFiles[0] ? committedId(orderedFiles[0].path) : null;
    const validIds = new Set([
      ...orderedFiles.map((f) => committedId(f.path)),
      ...(includeUncommitted ? (workdir?.files ?? []).map((f) => `u:${f.path}`) : []),
    ]);
    const valid = selectedId !== null && validIds.has(selectedId);
    if (!valid) {
      setSelectedId(head);
    } else if (!userPickedRef.current && selectedId !== head) {
      setSelectedId(head);
    }
  }, [committed, orderedFiles, selectedId, includeUncommitted, workdir]);

  const onSelectId = useCallback(
    (id: string) => {
      userPickedRef.current = true;
      setSelectedId(id);
      if (viewLayout === 'scroll') {
        diffPaneRef.current?.scrollFileIntoView(id);
      }
    },
    [viewLayout],
  );
  // The rail selects by raw path (committed section).
  const onSelectFile = useCallback((path: string) => onSelectId(committedId(path)), [onSelectId]);

  // Per-file note counts for the sidebar badge — anchored notes only.
  const noteCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) {
      const file = n.anchor?.file;
      if (file) m.set(file, (m.get(file) ?? 0) + 1);
    }
    return m;
  }, [notes]);

  const onCopy = useCallback(async () => {
    if (!committed || !currentBranch) return;
    try {
      const md = notesToMarkdown(currentBranch, committed.baseRef, committed.files, notes);
      await navigator.clipboard.writeText(md);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch (e) {
      console.warn('self_review_copy_failed', e);
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 2000);
    }
  }, [committed, currentBranch, notes]);

  // "Ready to share" (WS-2 #60, kept per flag F5): a branch with an existing
  // draft jumps straight into the composer; otherwise the modal collects the
  // Review title + base first.
  const [readyToShareOpen, setReadyToShareOpen] = useState(false);
  const [readyToShareError, setReadyToShareError] = useState<string | null>(null);
  const onReadyToShare = useCallback(async () => {
    try {
      const existing = await reviewDraftGet();
      if (existing) {
        onEnterStoryline();
        return;
      }
    } catch (e) {
      console.warn('self_review_draft_probe_failed', e);
      setReadyToShareError(String(e));
      return;
    }
    setReadyToShareError(null);
    setReadyToShareOpen(true);
  }, [onEnterStoryline]);

  const selectedUncommittedFiles = includeUncommitted ? (workdir?.files ?? []) : null;

  return (
    <>
      <Subheader
        branch={currentBranch ?? '…'}
        fileCount={committed?.stats.filesChanged ?? 0}
        added={committed?.stats.added ?? 0}
        removed={committed?.stats.removed ?? 0}
        ready={committed !== null}
        defaultBranch={defaultBranch}
        baseRef={baseRef}
        baseOptions={baseOptions}
        branches={branches}
        viewedCount={viewed.size}
        includeUncommitted={includeUncommitted}
        uncommittedCount={uncommittedCount}
        onToggleUncommitted={setIncludeUncommitted}
        doneAt={doneAt}
        onToggleDone={onToggleDone}
        onExit={onExit}
        onBaseChange={setBaseRef}
        onRefreshBase={shell.refreshBase}
        fetching={shell.fetching}
        onCopyAsMarkdown={onCopy}
        onReadyToShare={onReadyToShare}
        copyState={copyState}
      />

      {/* Committed-only scope + a dirty tree: say what the review does NOT
          cover (flag F4's warning banner). */}
      {!includeUncommitted && (uncommittedCount ?? 0) > 0 && (
        <div style={warnBanner}>
          {uncommittedCount} uncommitted file{uncommittedCount === 1 ? ' is' : 's are'} not part of
          this review — fold {uncommittedCount === 1 ? 'it' : 'them'} in with “+ Uncommitted”.
        </div>
      )}

      {localError && <div style={errorBanner}>{localError}</div>}
      {error && <div style={errorBanner}>{error}</div>}
      {debriefError && <div style={errorBanner}>{debriefError}</div>}
      {readyToShareError && <div style={errorBanner}>{readyToShareError}</div>}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <FileList
          files={orderedFiles}
          uncommittedFiles={selectedUncommittedFiles}
          debriefPaths={debriefPaths}
          filter={filter}
          setFilter={setFilter}
          filterRef={filterRef}
          selectedId={selectedId}
          onSelect={onSelectId}
          viewed={viewed}
          onToggleViewed={toggleViewed}
          onClearViewed={onClearViewed}
          noteCounts={noteCounts}
          width={fileListCol.width}
        />
        <ResizeHandle
          onResizeStart={fileListCol.onResizeStart}
          onResizeKey={fileListCol.onResizeKey}
          ariaLabel="Resize file list"
        />

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Diff toolbar: layout toggle (scroll/single) on the left,
              split/unified on the right, transient loading hint between. */}
          <div
            style={{
              height: 32,
              flex: '0 0 32px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '0 14px',
              borderBottom: '1px solid var(--hairline)',
              background: '#fff',
            }}
          >
            <div className="seg" aria-label="Diff layout">
              <button
                type="button"
                onClick={() => setViewLayout('scroll')}
                className={viewLayout === 'scroll' ? 'active' : undefined}
                title="Scroll through all files (GitHub-style)"
              >
                Scroll
              </button>
              <button
                type="button"
                onClick={() => setViewLayout('single')}
                className={viewLayout === 'single' ? 'active' : undefined}
                title="Show one file at a time"
              >
                Single
              </button>
            </div>
            <div style={{ flex: 1 }} />
            {loading && (
              <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>refreshing…</span>
            )}
            <div className="seg" aria-label="Diff view mode">
              <button
                type="button"
                onClick={() => setViewMode('split')}
                className={viewMode === 'split' ? 'active' : undefined}
              >
                Split
              </button>
              <button
                type="button"
                onClick={() => setViewMode('unified')}
                className={viewMode === 'unified' ? 'active' : undefined}
              >
                Unified
              </button>
            </div>
            {!railOpen && (
              <button
                type="button"
                className="btn"
                onClick={() => setRailOpen(true)}
                title="Show the agent Debrief rail"
                style={debrief ? { borderColor: 'var(--blue-tint-2)' } : undefined}
              >
                <Icon name="doc-stack" size={12} /> Debrief
                {openNoteCount > 0 && (
                  <span className="badge badge-orange" style={{ marginLeft: 6 }}>
                    {openNoteCount}
                  </span>
                )}
              </button>
            )}
          </div>
          <DiffPane
            ref={diffPaneRef}
            files={orderedFiles}
            uncommittedFiles={selectedUncommittedFiles}
            viewLayout={viewLayout}
            selectedId={selectedId}
            viewMode={viewMode}
            viewed={viewed}
            onToggleViewed={toggleViewed}
            notes={notes}
            onCreateNote={createNote}
            onReplyNote={replyNote}
            onResolveNote={resolveNote}
            onReopenNote={reopenNote}
            onDeleteNote={deleteNote}
          />
        </div>

        {railOpen && (
          <ResizeHandle
            onResizeStart={railCol.onResizeStart}
            onResizeKey={railCol.onResizeKey}
            ariaLabel="Resize Debrief rail"
          />
        )}
        {railOpen && (
          <DebriefRail
            debrief={debrief}
            notes={notes}
            files={committed?.files ?? []}
            selectedPath={selectedId?.startsWith('c:') ? selectedId.slice(2) : null}
            viewed={viewed}
            width={railCol.width}
            onSelectFile={onSelectFile}
            onToggleViewed={toggleViewed}
            onCreateNote={createNote}
            onReplyNote={replyNote}
            onResolveNote={resolveNote}
            onReopenNote={reopenNote}
            onDeleteNote={deleteNote}
            onClose={() => setRailOpen(false)}
          />
        )}
      </div>
      {readyToShareOpen && (
        <ReadyToShareModal
          branch={currentBranch ?? ''}
          initialBase={baseRef ?? baseOptions?.recommended ?? 'origin/main'}
          baseChoices={[
            ...new Set(
              [baseOptions?.recommended, baseOptions?.remoteDefault, baseRef ?? undefined].filter(
                (b): b is string => Boolean(b),
              ),
            ),
          ]}
          onClose={() => setReadyToShareOpen(false)}
          onCreated={onEnterStoryline}
        />
      )}
    </>
  );
}

/**
 * The "Ready to share" gesture (WS-2 #60): name the Review (WS-3 #61), pick
 * its base, and create the per-machine draft for the current branch — then
 * drop straight into the storyline composer. Local-only: nothing reaches
 * GitHub until Publish.
 */
function ReadyToShareModal({
  branch,
  initialBase,
  baseChoices,
  onClose,
  onCreated,
}: {
  branch: string;
  initialBase: string;
  baseChoices: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [base, setBase] = useState(initialBase);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await reviewDraftCreate(title.trim() || branch, base.trim() || 'main');
      onClose();
      onCreated();
    } catch (e) {
      // Fail loud (CLAUDE.md): surface the engine's message verbatim in the
      // modal; never close on a swallowed error.
      console.warn('review_draft_create_failed', e);
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: overlay modal, role="dialog" matches the app's existing modal pattern rather than a native <dialog>.
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Ready to share"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 420,
          background: '#fff',
          borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--sh-pop)',
          padding: 18,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--gray-900)', marginBottom: 6 }}>
          Ready to share
        </div>
        <div style={{ fontSize: 12, color: 'var(--gray-600)', marginBottom: 14, lineHeight: 1.5 }}>
          Start a storyline for <span className="mono">{branch}</span>. This stays local — nothing
          is pushed to GitHub until you publish.
        </div>

        <label
          htmlFor="rts-title"
          style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gray-600)' }}
        >
          Title (optional)
        </label>
        <input
          id="rts-title"
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={branch || 'Review title'}
          style={{ display: 'block', width: '100%', margin: '4px 0 12px' }}
        />

        <label
          htmlFor="rts-base"
          style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gray-600)' }}
        >
          Base branch
        </label>
        <input
          id="rts-base"
          list="rts-base-choices"
          className="input mono"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          style={{ display: 'block', width: '100%', margin: '4px 0 14px' }}
        />
        <datalist id="rts-base-choices">
          {baseChoices.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>

        {error && (
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--red-d)',
              background: 'rgba(255,59,48,0.08)',
              border: '1px solid rgba(255,59,48,0.20)',
              borderRadius: 'var(--r-sm)',
              padding: '6px 10px',
              marginBottom: 8,
            }}
          >
            Couldn't create the review: {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={submitting || base.trim().length === 0}
            style={{ opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? 'Starting…' : 'Start storyline'}
          </button>
        </div>
      </div>
    </div>
  );
}

const errorBanner: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--red-d)',
  background: 'rgba(255,59,48,0.08)',
  border: '1px solid rgba(255,59,48,0.20)',
  borderRadius: 'var(--r-sm)',
  padding: '6px 10px',
  margin: '8px 16px 0',
};

const warnBanner: React.CSSProperties = {
  fontSize: 11.5,
  color: '#b56500',
  background: 'rgba(255,149,0,0.08)',
  border: '1px solid rgba(255,149,0,0.22)',
  borderRadius: 'var(--r-sm)',
  padding: '6px 10px',
  margin: '8px 16px 0',
};
