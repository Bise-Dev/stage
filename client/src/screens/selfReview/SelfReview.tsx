import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { TitleBar } from '../../components/TitleBar';
import {
  type BaseOptions,
  type BranchInfo,
  getActiveRepo,
  gitFetch,
  gitLocalBranches,
  repoSummary,
  selfReviewBaseOptions,
} from '../../tauri';
import { DebriefRail } from './DebriefRail';
import { DiffPane, type DiffPaneHandle, type ViewLayout, type ViewMode } from './DiffPane';
import { FileList } from './FileList';
import { Subheader } from './Subheader';
import { ResizeHandle, useColumnWidth } from './columnResize';
import { notesToMarkdown } from './markdown';
import { useSelfReviewDebrief } from './useSelfReviewDebrief';
import { useSelfReviewDiff } from './useSelfReviewDiff';
import { clearViewed, loadViewed, setViewed } from './viewedStore';

/**
 * Self-Review screen root.
 *
 * Reads the active repo + default branch on mount (Q11-B: not passed in;
 * truth lives on disk). Wires the diff hook, comments hook, mark-viewed
 * store, and the Subheader / FileList / DiffPane layout. ESC exits to
 * Workspaces.
 */
const LAYOUT_KEY = 'selfReview:viewLayout';
const BASE_KEY_PREFIX = 'selfReview:base:';

function loadLayout(): ViewLayout {
  return localStorage.getItem(LAYOUT_KEY) === 'single' ? 'single' : 'scroll';
}

export function SelfReview({
  onExit,
  seedBaseFromDebrief = false,
}: { onExit: () => void; seedBaseFromDebrief?: boolean }) {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  // The base ref the `base`-scope diff compares against. Defaults to the
  // repo's default branch but is an author-chosen branch picker (note: the
  // comparison should be configurable). `null` until bootstrap resolves it.
  const [baseRef, setBaseRefState] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [baseOptions, setBaseOptions] = useState<BaseOptions | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('unified');
  const [viewLayout, setViewLayoutState] = useState<ViewLayout>(loadLayout);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [viewed, setViewedState] = useState<Set<string>>(new Set());
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const filterRef = useRef<HTMLInputElement>(null);
  const diffPaneRef = useRef<DiffPaneHandle>(null);

  const setViewLayout = useCallback((v: ViewLayout) => {
    localStorage.setItem(LAYOUT_KEY, v);
    setViewLayoutState(v);
  }, []);

  // Resizable file-list + Debrief-rail columns (persisted, clamped).
  const fileListCol = useColumnWidth('selfReview:fileListWidth', 260, 180, 480, 'right');
  const railCol = useColumnWidth('selfReview:railWidth', 360, 280, 560, 'left');

  // Resolve active repo + default branch on mount. Fail loud per CLAUDE.md:
  // surface the message instead of falling back to "main".
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const r = await getActiveRepo();
        if (!r) {
          setBootstrapError('No active repository — pick one from the Workspaces screen.');
          return;
        }
        setRepoPath(r.path);
        const sum = await repoSummary(r.path);
        setDefaultBranch(sum.defaultBranch);
        const opts = await selfReviewBaseOptions();
        setBaseOptions(opts);
        // Resolve the base: a previously-picked branch wins, else the recommended
        // ref (the remote default when fetched — ADR-0016 — so a stale local
        // default in a worktree doesn't skew the diff).
        const persisted = localStorage.getItem(`${BASE_KEY_PREFIX}${r.path}`);
        setBaseRefState(persisted ?? opts.recommended);
        setBranches(await gitLocalBranches());
      } catch (e) {
        console.warn('self_review_bootstrap_failed', e);
        setBootstrapError(String(e));
      }
    })();
  }, []);

  const setBaseRef = useCallback(
    (b: string) => {
      if (repoPath) localStorage.setItem(`${BASE_KEY_PREFIX}${repoPath}`, b);
      setBaseRefState(b);
    },
    [repoPath],
  );

  // Refresh the remote-tracking refs so the base diff reflects the current
  // remote default. After fetch, re-read base options (behind-count + last-fetch
  // time); the diff hook refreshes via the repo watcher.
  const [fetching, setFetching] = useState(false);
  const refreshBase = useCallback(async () => {
    setFetching(true);
    try {
      await gitFetch();
      setBaseOptions(await selfReviewBaseOptions());
    } catch (e) {
      console.warn('self_review_fetch_failed', e);
      setBootstrapError(String(e));
    } finally {
      setFetching(false);
    }
  }, []);

  const { diff, scope, setScope, loading, error, uncommittedCount } = useSelfReviewDiff(
    repoPath,
    baseRef,
  );

  // Cycle-1 author↔agent loop: the agent-authored Debrief + the author's
  // Review notes, both from the local store (ADR-0011/0012). Review notes are
  // the single annotation concept — every diff comment is one, persisted and
  // agent-readable. The markdown export is a secondary convenience sourced from
  // these same notes.
  const {
    debrief,
    notes,
    error: debriefError,
    createNote,
    replyNote,
    resolveNote,
    reopenNote,
    deleteNote,
  } = useSelfReviewDebrief(repoPath);

  // `stage open` path (ADR-0014): seed the base from the Debrief's stored base
  // so the author sees the same Base-scope diff the agent narrated, overriding
  // the per-repo localStorage default. Non-persisting (for this open only) and
  // applied once, when the Debrief first loads.
  const seededBaseRef = useRef(false);
  useEffect(() => {
    if (seedBaseFromDebrief && debrief && !seededBaseRef.current) {
      seededBaseRef.current = true;
      setBaseRefState(debrief.base);
    }
  }, [seedBaseFromDebrief, debrief]);

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

  // The set of file paths the Debrief narrates — used both to order the file
  // list and to draw the "Other files" divider below the narrated group.
  const debriefPaths = useMemo(() => new Set((debrief?.steps ?? []).map((s) => s.file)), [debrief]);

  // The single ordered file list driving the left column, the scroll-mode diff
  // stack, and the on-open selection. When a Debrief exists, its steps order the
  // files they narrate (ascending `order`); every other file sinks below in the
  // diff's original (path) order. `step.order` is treated as a pure sort key, so
  // this works in any scope — a Debrief step whose file isn't in the current
  // diff simply contributes no row. With no Debrief it's the diff order verbatim.
  // Array.prototype.sort is stable, so returning 0 preserves the path order for
  // the non-narrated tail.
  const orderedFiles = useMemo(() => {
    const files = diff?.files ?? [];
    if (debriefPaths.size === 0) return files;
    const orderOf = new Map((debrief?.steps ?? []).map((s) => [s.file, s.order]));
    return [...files].sort((a, b) => {
      const ai = orderOf.get(a.path);
      const bi = orderOf.get(b.path);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return 0;
    });
  }, [diff, debrief, debriefPaths]);

  // Mark-viewed state, persisted per (repoPath, branch). Reload when either
  // changes. We do NOT clear on scope change (Q8: viewed is sticky across
  // toggles and commits — it tracks the user's brain, not the file's git
  // state). We intentionally key on `diff?.currentBranch` rather than `diff`:
  // a watcher-driven refresh keeps the same currentBranch and shouldn't
  // re-read the store on every keystroke.
  // Branch-keyed by design: we depend on the derived `branchKey`, not `diff`,
  // so a watcher refresh that keeps the same branch doesn't re-read the store.
  const branchKey = diff?.currentBranch ?? null;
  useEffect(() => {
    if (!repoPath || !branchKey) return;
    let cancelled = false;
    loadViewed(repoPath, branchKey).then((s) => {
      if (!cancelled) setViewedState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [repoPath, branchKey]);

  // Mirror `viewed` into a ref so toggleViewed can read the current set without
  // listing `viewed` in its deps. Marking one file viewed then no longer
  // recreates the callback — which previously cascaded a re-render through
  // every mounted FileBlock (the callback is passed down to all of them).
  const viewedRef = useRef(viewed);
  viewedRef.current = viewed;

  const toggleViewed = useCallback(
    (path: string) => {
      if (!repoPath || !diff) return;
      const isOn = viewedRef.current.has(path);
      setViewedState((prev) => {
        const next = new Set(prev);
        if (isOn) next.delete(path);
        else next.add(path);
        return next;
      });
      setViewed(repoPath, diff.currentBranch, path, !isOn).catch((e) =>
        console.warn('self_review_viewed_persist_failed', e),
      );
    },
    [repoPath, diff],
  );

  const onClearViewed = useCallback(async () => {
    if (!repoPath || !diff) return;
    setViewedState(new Set());
    try {
      await clearViewed(repoPath, diff.currentBranch);
    } catch (e) {
      console.warn('self_review_viewed_clear_failed', e);
    }
  }, [repoPath, diff]);

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

  // File selection auto-tracks the head of the ordered list, so the sidebar
  // always has a highlighted row and — until the author makes a deliberate
  // pick — stays pinned to the top. The pin matters for `stage open`: the diff
  // and the Debrief load on separate async paths, so the list can reorder after
  // the first file is already selected; without the re-pin the author would
  // land on the alphabetical-first file instead of the first Debrief step.
  const userPickedRef = useRef(false);
  useEffect(() => {
    if (!diff) return;
    const head = orderedFiles[0]?.path ?? null;
    const valid = selectedPath && orderedFiles.some((f) => f.path === selectedPath);
    if (!valid) {
      setSelectedPath(head);
    } else if (!userPickedRef.current && selectedPath !== head) {
      setSelectedPath(head);
    }
  }, [diff, orderedFiles, selectedPath]);

  const onSelectFile = useCallback(
    (path: string) => {
      userPickedRef.current = true;
      setSelectedPath(path);
      // In scroll mode, the diff pane has every file stacked; clicking a
      // file in the sidebar scrolls its block into view. In single mode
      // it just swaps which file is rendered.
      if (viewLayout === 'scroll') {
        diffPaneRef.current?.scrollFileIntoView(path);
      }
    },
    [viewLayout],
  );

  // Per-file note counts for the sidebar badge — anchored notes only (general
  // notes have no file to attribute to).
  const noteCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) {
      const file = n.anchor?.file;
      if (file) m.set(file, (m.get(file) ?? 0) + 1);
    }
    return m;
  }, [notes]);

  const onCopy = useCallback(async () => {
    if (!diff) return;
    try {
      const md = notesToMarkdown(diff, notes);
      await navigator.clipboard.writeText(md);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch (e) {
      console.warn('self_review_copy_failed', e);
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 2000);
    }
  }, [diff, notes]);

  const onReadyToShare = useCallback(() => {
    // Stubbed entry to the future Workspace-creation flow (see CONTEXT.md
    // "Ready to share" gesture). The Storyline composer that this opens is
    // a separate PR.
    console.info('self_review_ready_to_share_stub', diff?.currentBranch ?? null);
  }, [diff]);

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title={`Stage — ${diff?.currentBranch ?? '…'}`} />

        <Subheader
          diff={diff}
          scope={scope}
          uncommittedCount={uncommittedCount}
          defaultBranch={defaultBranch}
          baseRef={baseRef}
          baseOptions={baseOptions}
          branches={branches}
          viewedCount={viewed.size}
          onExit={onExit}
          onScopeChange={setScope}
          onBaseChange={setBaseRef}
          onRefreshBase={refreshBase}
          fetching={fetching}
          onCopyAsMarkdown={onCopy}
          onReadyToShare={onReadyToShare}
          copyState={copyState}
        />

        {bootstrapError && <div style={errorBanner}>{bootstrapError}</div>}
        {error && <div style={errorBanner}>{error}</div>}
        {debriefError && <div style={errorBanner}>{debriefError}</div>}

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <FileList
            files={orderedFiles}
            debriefPaths={debriefPaths}
            filter={filter}
            setFilter={setFilter}
            filterRef={filterRef}
            selectedPath={selectedPath}
            onSelect={onSelectFile}
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
              viewLayout={viewLayout}
              selectedPath={selectedPath}
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
              files={diff?.files ?? []}
              selectedPath={selectedPath}
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
