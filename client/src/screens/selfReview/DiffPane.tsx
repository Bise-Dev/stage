import { DiffModeEnum, DiffViewWithMultiSelect, SplitSide } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import type { SelfReviewFileChange } from '../../tauri';
import { Composer } from './Composer';
import { Thread } from './Thread';
import { inferDiffLanguage } from './markdown';
import type { Comment, ComposerTarget, LineAnchor, Side } from './types';

const STATUS_BADGE = {
  added: { label: 'added', cls: 'badge-green' },
  modified: { label: 'modified', cls: 'badge-orange' },
  deleted: { label: 'deleted', cls: 'badge-red' },
  renamed: { label: 'renamed', cls: 'badge-purple' },
} as const;

export type ViewMode = 'split' | 'unified';
export type ViewLayout = 'scroll' | 'single';

export type DiffPaneHandle = {
  /** Scrolls the named file's block into view (used in `scroll` layout). */
  scrollFileIntoView(path: string): void;
};

type DiffPaneProps = {
  files: SelfReviewFileChange[];
  viewLayout: ViewLayout;
  /** Which file the sidebar has selected; in 'single' layout determines what
   *  is rendered, in 'scroll' layout it's only the scroll target. */
  selectedPath: string | null;
  viewMode: ViewMode;
  viewed: Set<string>;
  onToggleViewed(path: string): void;
  comments: Comment[];
  composer: ComposerTarget | null;
  onStartFileComment(filePath: string): void;
  onStartReply(parentId: string): void;
  onSaveComposer(body: string): void;
  /** Bypasses the composer state — used by the library's widget slot. */
  onSaveLineComment(anchor: LineAnchor, body: string): void;
  onCancelComposer(): void;
  onDeleteComment(id: string): void;
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
 * DiffFile or wipe the library's widget store.
 */
export function DiffPane({
  files,
  viewLayout,
  selectedPath,
  viewMode,
  viewed,
  onToggleViewed,
  comments,
  composer,
  onStartFileComment,
  onStartReply,
  onSaveComposer,
  onSaveLineComment,
  onCancelComposer,
  onDeleteComment,
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
        visibleFiles.map((f) => (
          <LazyFileBlock
            key={f.path}
            file={f}
            registerRef={(el) => {
              if (el) fileRefs.current.set(f.path, el);
              else fileRefs.current.delete(f.path);
            }}
            viewMode={viewMode}
            isViewed={viewed.has(f.path)}
            onToggleViewed={() => onToggleViewed(f.path)}
            comments={comments.filter((c) => c.anchor.filePath === f.path)}
            composer={composer}
            onStartFileComment={onStartFileComment}
            onStartReply={onStartReply}
            onSaveComposer={onSaveComposer}
            onSaveLineComment={onSaveLineComment}
            onCancelComposer={onCancelComposer}
            onDeleteComment={onDeleteComment}
          />
        ))
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
 * it stays mounted — unmounting would lose composer state and comments
 * in flight.
 */
type LazyFileBlockProps = Omit<FileBlockProps, 'file'> & {
  file: SelfReviewFileChange;
  registerRef(el: HTMLDivElement | null): void;
};
function LazyFileBlock({ registerRef, ...rest }: LazyFileBlockProps) {
  const [mounted, setMounted] = useState(false);
  const localRef = useRef<HTMLDivElement>(null);
  const setRef = (el: HTMLDivElement | null) => {
    localRef.current = el;
    registerRef(el);
  };

  useEffect(() => {
    if (mounted) return;
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
  }, [mounted]);

  if (mounted) {
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
}

type FileBlockProps = {
  file: SelfReviewFileChange;
  viewMode: ViewMode;
  isViewed: boolean;
  onToggleViewed(): void;
  comments: Comment[];
  composer: ComposerTarget | null;
  onStartFileComment(filePath: string): void;
  onStartReply(parentId: string): void;
  onSaveComposer(body: string): void;
  onSaveLineComment(anchor: LineAnchor, body: string): void;
  onCancelComposer(): void;
  onDeleteComment(id: string): void;
};

function FileBlock({
  file,
  viewMode,
  isViewed,
  onToggleViewed,
  comments,
  composer,
  onStartFileComment,
  onStartReply,
  onSaveComposer,
  onSaveLineComment,
  onCancelComposer,
  onDeleteComment,
}: FileBlockProps) {
  const badge = STATUS_BADGE[file.status];

  const fileLevel = comments.filter((c) => c.anchor.kind === 'file');
  const dangling = comments.filter((c) => c.anchor.kind === 'dangling');
  const lineComments = comments.filter((c) => c.anchor.kind === 'line');

  // Memoize the `data` prop. The library's internal useMemo deps on `data`
  // by reference (line 1593 of the lib bundle); a fresh object literal every
  // render makes it rebuild the DiffFile, and a downstream useEffect then
  // clears the widget store — so clicking "+" never opens the slot. Only
  // rebuild when the actual patch content changes.
  const diffData = useMemo(() => {
    // Only set `fileLang` when we know it's a lowlight-supported language;
    // unknown extensions (e.g. `bun.lock`) trip a noisy "not support current
    // lang: <ext> yet" warning otherwise. The library falls back to a plain
    // (unhighlighted) render when fileLang is absent.
    const lang = inferDiffLanguage(file.path);
    return {
      oldFile: { fileName: file.oldPath ?? file.path, fileLang: lang },
      newFile: { fileName: file.path, fileLang: lang },
      hunks: [file.patch],
    };
  }, [file.path, file.oldPath, file.patch]);

  // Bucket inline comments by side + line for the library's extendData API.
  const extendData = useMemo(() => {
    const oldFile: Record<string, { data: { commentIds: string[]; lineNumber: number } }> = {};
    const newFile: Record<string, { data: { commentIds: string[]; lineNumber: number } }> = {};
    for (const c of lineComments) {
      if (c.anchor.kind !== 'line') continue;
      const target = c.anchor.side === 'left' ? oldFile : newFile;
      // Attach to the *end* of the range (Q10-B: widget below the last line).
      const key = String(c.anchor.lineEnd);
      const bucket = target[key]?.data ?? { commentIds: [], lineNumber: c.anchor.lineEnd };
      bucket.commentIds.push(c.id);
      target[key] = { data: bucket };
    }
    return { oldFile, newFile };
  }, [lineComments]);

  // The library passes us its SplitSide enum; map to our 'left'|'right'.
  const sideToOurs = (s: SplitSide): Side => (s === SplitSide.old ? 'left' : 'right');

  // The library's widget store, captured via `onCreateUseWidgetHook` so we
  // can programmatically open the widget slot from `onMultiSelectComplete`
  // (the user expects drag-release → composer; out of the box the library
  // only opens via clicking "+" after the drag, which costs a second click).
  // Type loosely — `createDiffWidgetStore`'s return type isn't exported.
  type WidgetHook = {
    getReadonlyState: () => { setWidget: (arg: { side?: SplitSide; lineNumber?: number }) => void };
  };
  const widgetHookRef = useRef<WidgetHook | null>(null);

  /**
   * Bypass the library's `onMultiSelectComplete` path. The wrapper filters
   * results when `result.lines.length === 0`, and the manager produces
   * empty `lines` for our DiffFile because we don't pass `newFile.content`
   * (the line-number→line-data lookup needs it). Instead we listen for
   * mouseup ourselves, pull the *range* directly from the manager via the
   * imperative ref — which is populated correctly — and open the widget
   * slot at the end line.
   *
   * `pendingRangeRef` carries the range hint into `renderWidgetLine`
   * because the library's `multiResultRef` also stays empty (same filter).
   */
  type DvRef = {
    getSelectionResult: () => {
      range: { side: 'old' | 'new'; startLineNumber: number; endLineNumber: number };
      lines: unknown[];
    } | null;
    clearSelection?: () => void;
  };
  const dvRef = useRef<DvRef | null>(null);
  const pendingRangeRef = useRef<{
    side: SplitSide;
    start: number;
    end: number;
    filePath: string;
  } | null>(null);

  useEffect(() => {
    const onUp = () => {
      const result = dvRef.current?.getSelectionResult?.();
      if (!result?.range) return;
      const { side: rawSide, startLineNumber, endLineNumber } = result.range;
      const side = rawSide === 'old' ? SplitSide.old : SplitSide.new;
      const start = Math.min(startLineNumber, endLineNumber);
      const end = Math.max(startLineNumber, endLineNumber);
      pendingRangeRef.current = { side, start, end, filePath: file.path };
      widgetHookRef.current?.getReadonlyState().setWidget({ side, lineNumber: end });
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, [file.path]);

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
          onClick={() => onStartFileComment(file.path)}
          title="Add a file-level comment"
        >
          <Icon name="comment-fill" size={11} /> Comment
        </button>
        <button
          type="button"
          className="btn"
          onClick={onToggleViewed}
          style={
            isViewed ? { background: 'rgba(52,199,89,0.14)', color: 'var(--green-d)' } : undefined
          }
        >
          <Icon name={isViewed ? 'check' : 'eye'} size={11} /> {isViewed ? 'Viewed' : 'Mark viewed'}
        </button>
      </div>

      {/* Dangling band */}
      {dangling.length > 0 && (
        <div
          style={{
            padding: '6px 14px',
            background: 'rgba(255,149,0,0.06)',
            borderBottom: '1px solid rgba(255,149,0,0.18)',
            fontSize: 11.5,
            color: '#b56500',
          }}
        >
          {dangling.length} comment{dangling.length === 1 ? '' : 's'} no longer attached — anchor
          lines were edited or removed. Copy them out (Copy as markdown) or delete below.
        </div>
      )}

      {/* File-level + dangling threads above the diff */}
      {(fileLevel.length > 0 ||
        dangling.length > 0 ||
        composer?.kind === 'new-file' ||
        (composer?.kind === 'reply' &&
          [...fileLevel, ...dangling].some((c) => c.id === composer.parentId))) && (
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--hairline-2)' }}>
          {[...fileLevel, ...dangling].map((c) => (
            <Thread
              key={c.id}
              comment={c}
              composer={composer}
              onStartReply={onStartReply}
              onSaveComposer={onSaveComposer}
              onCancelComposer={onCancelComposer}
              onDelete={onDeleteComment}
            />
          ))}
          {composer?.kind === 'new-file' && composer.anchor.filePath === file.path && (
            <Composer
              placeholder="File-level comment…"
              onSave={onSaveComposer}
              onCancel={onCancelComposer}
              autoFocus
            />
          )}
        </div>
      )}

      {/* The diff itself — only when there's a patch to render. The library
          renders its own `.diff-tailwindcss-wrapper` internally, so we don't
          need to add one ourselves. The `self-review-diff` wrapper scopes
          the hover-"+" CSS overlay (see styles.css) so it doesn't leak to
          any other diff-view consumer in the future. */}
      {file.patch && !file.isBinary && !file.isTruncated ? (
        <div className="self-review-diff">
          <DiffViewWithMultiSelect
            // biome-ignore lint/suspicious/noExplicitAny: ref shape isn't exported as a usable name
            ref={dvRef as unknown as React.Ref<any>}
            data={diffData}
            diffViewMode={viewMode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
            diffViewHighlight
            // Bypass the library's width-based widget gating. Without this it
            // gates "render the widget content" on a measured `.unified-diff-
            // table-wrapper` width — the measurement lags the first paint, so
            // the widget row appears empty until the next resize event.
            diffViewWrap
            // No "+" gutter icon: it sits at `left-[100%] translate-x-[-50%]`,
            // straddling the line-number / code boundary — exactly where the
            // user wants to start a drag. Its onMouseDown calls
            // e.stopPropagation(), so the multi-select manager underneath
            // never sees the pointerdown and the drag never starts. Instead
            // every entry goes through the multi-select pipeline:
            // `onMultiSelectComplete` fires on mouseup for both a single-line
            // click (start === end) and a real drag, and we programmatically
            // open the widget via the captured store hook below. GitHub's
            // model, end-to-end uniform.
            diffViewAddWidget={false}
            extendData={extendData}
            enableMultiSelect
            onCreateUseWidgetHook={(hook) => {
              widgetHookRef.current = hook as unknown as WidgetHook;
            }}
            renderWidgetLine={({ lineNumber, fromLineNumber, side, onClose }) => {
              // Prefer the range from our document-mouseup listener
              // (`pendingRangeRef`) since the library's internal range cache
              // gets cleared by its empty-lines filter. Fall back to the
              // library's lineNumber/fromLineNumber for any other path.
              const ourSide = sideToOurs(side);
              const pending = pendingRangeRef.current;
              const useRange = pending && pending.side === side && pending.filePath === file.path;
              const start = useRange
                ? pending.start
                : Math.min(lineNumber, fromLineNumber ?? lineNumber);
              const end = useRange
                ? pending.end
                : Math.max(lineNumber, fromLineNumber ?? lineNumber);
              const rangeLabel = start === end ? `L${start}` : `L${start}–L${end}`;
              return (
                <div style={{ padding: '4px 12px' }}>
                  <Composer
                    label={rangeLabel}
                    placeholder="Leave a comment…"
                    onSave={(b) => {
                      onSaveLineComment(
                        {
                          kind: 'line',
                          filePath: file.path,
                          side: ourSide,
                          lineStart: start,
                          lineEnd: end,
                        },
                        b,
                      );
                      pendingRangeRef.current = null;
                      onClose();
                    }}
                    onCancel={() => {
                      onCancelComposer();
                      pendingRangeRef.current = null;
                      onClose();
                    }}
                    autoFocus
                  />
                </div>
              );
            }}
            renderExtendLine={({ data }) => {
              const ids: string[] = data?.commentIds ?? [];
              const threads = ids
                .map((id) => lineComments.find((c) => c.id === id))
                .filter((c): c is Comment => Boolean(c));
              if (threads.length === 0) return null;
              return (
                <div style={{ padding: '4px 12px' }}>
                  {threads.map((c) => (
                    <Thread
                      key={c.id}
                      comment={c}
                      composer={composer}
                      onStartReply={onStartReply}
                      onSaveComposer={onSaveComposer}
                      onCancelComposer={onCancelComposer}
                      onDelete={onDeleteComment}
                    />
                  ))}
                </div>
              );
            }}
          />
        </div>
      ) : (
        <div
          style={{
            padding: '20px 14px',
            fontSize: 12,
            color: 'var(--gray-500)',
            background: 'var(--gray-50)',
          }}
        >
          {file.isBinary
            ? 'Binary file — not shown.'
            : file.isTruncated
              ? 'Diff too large to render inline (clipped at 256 KB). Use `git diff` to inspect.'
              : 'Empty diff.'}
        </div>
      )}
    </div>
  );
}
