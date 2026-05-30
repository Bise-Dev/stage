import { DiffModeEnum, DiffViewWithMultiSelect, SplitSide } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { useMemo } from 'react';
import { Icon } from '../../components/Icon';
import type { SelfReviewFileChange } from '../../tauri';
import { Composer } from './Composer';
import { Thread } from './Thread';
import type { Comment, ComposerTarget, LineAnchor, Side } from './types';

const STATUS_BADGE = {
  added: { label: 'added', cls: 'badge-green' },
  modified: { label: 'modified', cls: 'badge-orange' },
  deleted: { label: 'deleted', cls: 'badge-red' },
  renamed: { label: 'renamed', cls: 'badge-purple' },
} as const;

export type ViewMode = 'split' | 'unified';

/**
 * Renders the currently-selected file. Matches the design's "Local review"
 * layout (one file at a time, sidebar drives selection) and avoids the
 * stacked-files perf hit on scope toggles — only one
 * `<DiffViewWithMultiSelect>` lives at any moment, so we don't pay
 * tokenize+highlight for every changed file on every refetch.
 */
export function DiffPane({
  file,
  fileCount,
  viewMode,
  isViewed,
  onToggleViewed,
  comments,
  composer,
  onStartLineComment,
  onStartFileComment,
  onStartReply,
  onSaveComposer,
  onSaveLineComment,
  onCancelComposer,
  onDeleteComment,
}: {
  file: SelfReviewFileChange | null;
  /** Total file count — used only for the empty-state copy. */
  fileCount: number;
  viewMode: ViewMode;
  isViewed: boolean;
  onToggleViewed(): void;
  comments: Comment[];
  composer: ComposerTarget | null;
  onStartLineComment(anchor: LineAnchor): void;
  onStartFileComment(filePath: string): void;
  onStartReply(parentId: string): void;
  onSaveComposer(body: string): void;
  /** Bypasses the composer state — used by the library's widget slot. */
  onSaveLineComment(anchor: LineAnchor, body: string): void;
  onCancelComposer(): void;
  onDeleteComment(id: string): void;
}) {
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
      {file === null ? (
        <div
          style={{
            padding: '40px 20px',
            textAlign: 'center',
            color: 'var(--gray-500)',
            fontSize: 13,
          }}
        >
          {fileCount === 0
            ? 'No changes to review on this branch.'
            : 'Pick a file from the sidebar.'}
        </div>
      ) : (
        <FileBlock
          // Keying on path forces a clean remount when the user switches
          // files — cheaper than letting the library try to diff its
          // internal AST against a totally different patch.
          key={file.path}
          file={file}
          viewMode={viewMode}
          isViewed={isViewed}
          onToggleViewed={onToggleViewed}
          comments={comments}
          composer={composer}
          onStartLineComment={onStartLineComment}
          onStartFileComment={onStartFileComment}
          onStartReply={onStartReply}
          onSaveComposer={onSaveComposer}
          onSaveLineComment={onSaveLineComment}
          onCancelComposer={onCancelComposer}
          onDeleteComment={onDeleteComment}
        />
      )}
    </div>
  );
}

function FileBlock({
  file,
  viewMode,
  isViewed,
  onToggleViewed,
  comments,
  composer,
  onStartLineComment,
  onStartFileComment,
  onStartReply,
  onSaveComposer,
  onSaveLineComment,
  onCancelComposer,
  onDeleteComment,
}: {
  file: SelfReviewFileChange;
  viewMode: ViewMode;
  isViewed: boolean;
  onToggleViewed(): void;
  comments: Comment[];
  composer: ComposerTarget | null;
  onStartLineComment(anchor: LineAnchor): void;
  onStartFileComment(filePath: string): void;
  onStartReply(parentId: string): void;
  onSaveComposer(body: string): void;
  onSaveLineComment(anchor: LineAnchor, body: string): void;
  onCancelComposer(): void;
  onDeleteComment(id: string): void;
}) {
  const badge = STATUS_BADGE[file.status];

  const fileLevel = comments.filter((c) => c.anchor.kind === 'file');
  const dangling = comments.filter((c) => c.anchor.kind === 'dangling');
  const lineComments = comments.filter((c) => c.anchor.kind === 'line');

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

      {/* The diff itself — only when there's a patch to render */}
      {/* `.diff-tailwindcss-wrapper` scopes every tailwind utility in the
          library's bundled CSS (~230 selectors). Without it the `+` button
          is permanently visible (invisible utility never activates), the
          widget row that opens on click has no positioning so it renders
          empty, and the multi-select highlight has no styling. The library
          expects the host to provide this wrapper. */}
      {file.patch && !file.isBinary && !file.isTruncated ? (
        <div className="diff-tailwindcss-wrapper">
          <DiffViewWithMultiSelect
            data={{
              oldFile: { fileName: file.oldPath ?? file.path },
              newFile: { fileName: file.path },
              hunks: [file.patch],
            }}
            diffViewMode={viewMode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
            diffViewHighlight
            // Bypass the library's width-based widget gating. Without this it
            // gates "render the widget content" on a measured `.unified-diff-
            // table-wrapper` width — the measurement lags the first paint, so
            // the widget row appears empty until the next resize event.
            diffViewWrap
            // The library's widget slot is opened *only* by clicking the "+"
            // icon — that's the path that calls its internal `setWidget(...)`.
            // Drag-selection captures a range, but the user still clicks the
            // "+" on the end line to open the composer; the library then
            // enriches `onAddWidgetClick` with `fromLineNumber` from the cached
            // selection. Disabling the "+" leaves no entry point at all, so we
            // keep it on (revising Q10-H — the library's contract requires it).
            diffViewAddWidget
            extendData={extendData}
            enableMultiSelect
            onAddWidgetClick={({ lineNumber, fromLineNumber, side }) => {
              const ourSide = sideToOurs(side);
              const start = Math.min(lineNumber, fromLineNumber ?? lineNumber);
              const end = Math.max(lineNumber, fromLineNumber ?? lineNumber);
              onStartLineComment({
                kind: 'line',
                filePath: file.path,
                side: ourSide,
                lineStart: start,
                lineEnd: end,
              });
            }}
            renderWidgetLine={({ lineNumber, fromLineNumber, side, onClose }) => {
              // The library is the source of truth for "is the widget slot open
              // at this line". We don't gate on React state here — the library
              // updates its widget store synchronously (reactivity-store) and
              // calls us *before* our setComposer flush lands, so any React
              // guard would return null on the first call and never re-render
              // (the library only re-renders this slot when widgetLineNumber
              // changes, not when our state catches up).
              const ourSide = sideToOurs(side);
              const start = Math.min(lineNumber, fromLineNumber ?? lineNumber);
              const end = Math.max(lineNumber, fromLineNumber ?? lineNumber);
              return (
                <div style={{ padding: '4px 12px' }}>
                  <Composer
                    placeholder={
                      start === end ? `Comment on L${start}` : `Comment on L${start}–${end}`
                    }
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
                      onClose();
                    }}
                    onCancel={() => {
                      onCancelComposer();
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
