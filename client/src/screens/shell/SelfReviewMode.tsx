import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRailCollapsed } from '../../components/CollapsibleRail';
import { selfReviewDebriefMarkSeen } from '../../tauri';
import {
  DiffPane,
  type DiffPaneHandle,
  type ViewLayout,
  type ViewMode,
} from '../selfReview/DiffPane';
import { FileList, committedId } from '../selfReview/FileList';
import { NotesPopover } from '../selfReview/NotesPopover';
import { Subheader } from '../selfReview/Subheader';
import { ResizeHandle, useColumnWidth } from '../selfReview/columnResize';
import { notesToMarkdown } from '../selfReview/markdown';
import { clearViewed, loadViewed, setViewed } from '../selfReview/viewedMarks';
import { ChapterBanner, type ChapterBannerData } from './ChapterBanner';
import type { ShellModeBodyProps } from './modes';
import { useSectionedDiff } from './useSectionedDiff';

/**
 * Self-Review mode of the review shell — the one review surface (v6-light L7):
 * the author's iterative pass over their own diff, with the agent's Debrief
 * folded in rather than shown as a separate mode (§3b M1). Since L9 (§3c) the
 * Debrief renders as the chapter-grouped file list on the left plus a
 * collapsed chapter banner above each chapter's first file diff — the right
 * rail is gone; general and orphaned notes live in the top-bar notes popover.
 * Opening this surface on a branch that has a Debrief marks it seen (M3); a
 * Debrief whose recorded head the branch has moved past is called out in a
 * warning banner, since its chapters narrate a diff that no longer holds.
 *
 * Scope model (flag F4): the committed diff (`merge_base(base, HEAD) → HEAD`)
 * is the reviewable unit; "+ Uncommitted" folds the working tree in as a
 * separate section.
 */
const LAYOUT_KEY = 'selfReview:viewLayout';
const VIEWMODE_KEY = 'selfReview:viewMode';

function loadLayout(): ViewLayout {
  return localStorage.getItem(LAYOUT_KEY) === 'single' ? 'single' : 'scroll';
}
function loadViewMode(): ViewMode {
  return localStorage.getItem(VIEWMODE_KEY) === 'split' ? 'split' : 'unified';
}

export function SelfReviewMode({ shell, debriefState, onExit }: ShellModeBodyProps) {
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

  // Resizable file-list column (persisted, clamped), collapsible to the
  // shared rail strip (M2).
  const fileListCol = useColumnWidth('selfReview:fileListWidth', 260, 180, 480, 'right');
  const [fileListCollapsed, toggleFileListCollapsed] = useRailCollapsed(
    'selfReview:fileListCollapsed',
  );

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

  // Opening Self-Review on a branch that has a Debrief is what "seen" means
  // (§3b M3) — once per head SHA; a fresh agent pass re-runs this. Loud but
  // non-blocking on failure: the banner explains it, the next open retries.
  const markedRef = useRef<string | null>(null);
  const [markSeenError, setMarkSeenError] = useState<string | null>(null);
  useEffect(() => {
    if (!debrief || markedRef.current === debrief.headSha) return;
    markedRef.current = debrief.headSha;
    selfReviewDebriefMarkSeen().catch((e) => {
      markedRef.current = null; // retry on next open
      setMarkSeenError(`Couldn't mark this debrief as seen — ${String(e)}`);
    });
  }, [debrief]);

  // The Debrief's narrated files, flattened across its chapters in
  // presentation order (ADR-0025).
  const debriefFileOrder = useMemo(
    () => (debrief?.chapters ?? []).flatMap((c) => c.files),
    [debrief],
  );
  const debriefPaths = useMemo(() => new Set(debriefFileOrder), [debriefFileOrder]);
  // Title + files per chapter for the grouped file list (L9 §3c N1).
  const fileListChapters = useMemo(
    () => (debrief?.chapters ?? []).map((c) => ({ title: c.title, files: c.files })),
    [debrief],
  );

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

  // The Debrief's inline presence (§3b M1): a collapsed chapter banner above
  // the chapter's FIRST file present in the committed diff.
  const chapterBanners = useMemo(() => {
    const m = new Map<string, ChapterBannerData>();
    const inDiff = new Set((committed?.files ?? []).map((f) => f.path));
    (debrief?.chapters ?? []).forEach((ch, i) => {
      const first = ch.files.find((f) => inDiff.has(f));
      if (first && !m.has(first)) {
        m.set(first, {
          index: i + 1,
          title: ch.title,
          intro: ch.intro,
          fileCount: ch.files.length,
        });
      }
    });
    return m;
  }, [debrief, committed]);
  const renderBefore = useCallback(
    (path: string) => {
      const ch = chapterBanners.get(path);
      return ch ? <ChapterBanner chapter={ch} /> : null;
    },
    [chapterBanners],
  );

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

  const selectedUncommittedFiles = includeUncommitted ? (workdir?.files ?? []) : null;

  // Anchored notes on files outside the committed diff have no inline home —
  // the notes popover surfaces them (L9 §3c N2).
  const committedPaths = useMemo(
    () => new Set((committed?.files ?? []).map((f) => f.path)),
    [committed],
  );

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
        onExit={onExit}
        onBaseChange={setBaseRef}
        onRefreshBase={shell.refreshBase}
        fetching={shell.fetching}
        onCopyAsMarkdown={onCopy}
        copyState={copyState}
        notesControl={
          <NotesPopover
            debrief={debrief}
            notes={notes}
            committedPaths={committedPaths}
            onCreateNote={createNote}
            onReplyNote={replyNote}
            onResolveNote={resolveNote}
            onReopenNote={reopenNote}
            onDeleteNote={deleteNote}
          />
        }
      />

      {/* The agent's account was written against a commit the branch has
          since moved past — say so, and say why it matters, before the author
          reads chapters that may narrate code that no longer exists. */}
      {debrief?.freshness === 'outdated' && (
        <div style={warnBanner}>
          This debrief is outdated — the agent wrote it for commit{' '}
          <code style={shaStyle}>{shortSha(debrief.headSha)}</code>
          {headSha ? (
            <>
              , and the branch has moved on to <code style={shaStyle}>{shortSha(headSha)}</code>
            </>
          ) : (
            ', and the branch has moved on'
          )}
          . Its chapters and intros describe the older diff, so they may narrate code that has since
          changed or disappeared. Ask the agent to rewrite the debrief for the current head.
        </div>
      )}

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
      {markSeenError && <div style={errorBanner}>{markSeenError}</div>}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <FileList
          files={orderedFiles}
          uncommittedFiles={selectedUncommittedFiles}
          chapters={fileListChapters}
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
          collapsed={fileListCollapsed}
          onToggleCollapsed={toggleFileListCollapsed}
        />
        {!fileListCollapsed && (
          <ResizeHandle
            onResizeStart={fileListCol.onResizeStart}
            onResizeKey={fileListCol.onResizeKey}
            ariaLabel="Resize file list"
          />
        )}

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
            renderBefore={renderBefore}
            onCreateNote={createNote}
            onReplyNote={replyNote}
            onResolveNote={resolveNote}
            onReopenNote={reopenNote}
            onDeleteNote={deleteNote}
          />
        </div>
      </div>
    </>
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

/** First 7 chars — the short form git itself prints. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

const shaStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
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
