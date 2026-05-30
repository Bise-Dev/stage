import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TitleBar } from '../../components/TitleBar';
import { getActiveRepo, repoSummary } from '../../tauri';
import { DiffPane, type ViewMode } from './DiffPane';
import { FileList } from './FileList';
import { Subheader } from './Subheader';
import { useSelfReviewComments } from './useSelfReviewComments';
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
export function SelfReview({ onExit }: { onExit: () => void }) {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('unified');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [viewed, setViewedState] = useState<Set<string>>(new Set());
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const filterRef = useRef<HTMLInputElement>(null);

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
      } catch (e) {
        console.warn('self_review_bootstrap_failed', e);
        setBootstrapError(String(e));
      }
    })();
  }, []);

  const { diff, scope, setScope, loading, error } = useSelfReviewDiff(repoPath, defaultBranch);
  const {
    comments,
    composer,
    startLineComment,
    startFileComment,
    startReply,
    saveCurrent,
    saveLineComment,
    cancelComposer,
    deleteComment,
    copyAsMarkdown,
  } = useSelfReviewComments(diff);

  // Mark-viewed state, persisted per (repoPath, branch). Reload when either
  // changes. We do NOT clear on scope change (Q8: viewed is sticky across
  // toggles and commits — it tracks the user's brain, not the file's git
  // state). We intentionally key on `diff?.currentBranch` rather than `diff`:
  // a watcher-driven refresh keeps the same currentBranch and shouldn't
  // re-read the store on every keystroke.
  const branchKey = diff?.currentBranch ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: branch-keyed by design (see comment)
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

  const toggleViewed = useCallback(
    (path: string) => {
      if (!repoPath || !diff) return;
      const next = new Set(viewed);
      const isOn = next.has(path);
      if (isOn) next.delete(path);
      else next.add(path);
      setViewedState(next);
      setViewed(repoPath, diff.currentBranch, path, !isOn).catch((e) =>
        console.warn('self_review_viewed_persist_failed', e),
      );
    },
    [repoPath, diff, viewed],
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

  // File selection auto-tracks the first file when the diff loads, so the
  // sidebar always has a highlighted row.
  useEffect(() => {
    if (!diff) return;
    if (!selectedPath || !diff.files.some((f) => f.path === selectedPath)) {
      setSelectedPath(diff.files[0]?.path ?? null);
    }
  }, [diff, selectedPath]);

  const onSelectFile = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const commentCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) {
      m.set(c.anchor.filePath, (m.get(c.anchor.filePath) ?? 0) + 1);
    }
    return m;
  }, [comments]);

  // One-file-at-a-time render: pick the selected file (or null if none),
  // and pre-filter comments down to that file so DiffPane doesn't do it on
  // every re-render. Both memos cheap; the win is that only ONE
  // <DiffViewWithMultiSelect> ever lives, so scope toggles don't pay
  // tokenize+highlight for every changed file in the diff.
  const selectedFile = useMemo(
    () => diff?.files.find((f) => f.path === selectedPath) ?? null,
    [diff, selectedPath],
  );
  const commentsForSelected = useMemo(
    () => (selectedFile ? comments.filter((c) => c.anchor.filePath === selectedFile.path) : []),
    [comments, selectedFile],
  );

  const onCopy = useCallback(async () => {
    try {
      await copyAsMarkdown();
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch (e) {
      console.warn('self_review_copy_failed', e);
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 2000);
    }
  }, [copyAsMarkdown]);

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
          defaultBranch={defaultBranch}
          viewedCount={viewed.size}
          onExit={onExit}
          onScopeChange={setScope}
          onCopyAsMarkdown={onCopy}
          onReadyToShare={onReadyToShare}
          copyState={copyState}
        />

        {bootstrapError && <div style={errorBanner}>{bootstrapError}</div>}
        {error && <div style={errorBanner}>{error}</div>}

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <FileList
            files={diff?.files ?? []}
            filter={filter}
            setFilter={setFilter}
            filterRef={filterRef}
            selectedPath={selectedPath}
            onSelect={onSelectFile}
            viewed={viewed}
            onToggleViewed={toggleViewed}
            onClearViewed={onClearViewed}
            commentCounts={commentCounts}
          />

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {/* Diff toolbar: split/unified + transient loading hint */}
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
              <div className="seg">
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
              <div style={{ flex: 1 }} />
              {loading && (
                <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>refreshing…</span>
              )}
            </div>
            <DiffPane
              file={selectedFile}
              fileCount={diff?.files.length ?? 0}
              viewMode={viewMode}
              isViewed={selectedFile ? viewed.has(selectedFile.path) : false}
              onToggleViewed={() => selectedFile && toggleViewed(selectedFile.path)}
              comments={selectedFile ? commentsForSelected : []}
              composer={composer}
              onStartLineComment={startLineComment}
              onStartFileComment={startFileComment}
              onStartReply={startReply}
              onSaveComposer={saveCurrent}
              onSaveLineComment={saveLineComment}
              onCancelComposer={cancelComposer}
              onDeleteComment={deleteComment}
            />
          </div>
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
