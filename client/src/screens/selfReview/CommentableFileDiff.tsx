import { DiffModeEnum, DiffViewWithMultiSelect, SplitSide } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { type ReactNode, useCallback, useMemo, useRef } from 'react';
import type { SelfReviewFileChange, Side } from '../../tauri';
import { Composer } from './Composer';
import { inferDiffLanguage } from './markdown';

export type ViewMode = 'split' | 'unified';

/** A dragged (or single-line) comment target: a side + an inclusive line range
 *  on that side. `lineStart === lineEnd` for a single-line comment. */
export type CommentRange = { side: Side; lineStart: number; lineEnd: number };

/** Where an inline thread anchors: a side + a 1-based line on that side. The
 *  host lists these so the diff knows which line cells open an extend slot. */
export type InlineAnchor = { side: Side; line: number };

type CommentableFileDiffProps = {
  file: SelfReviewFileChange;
  viewMode: ViewMode;
  /** (side,line) cells that carry inline threads — where extend slots open. */
  inlineAnchors: InlineAnchor[];
  /** Render the thread(s) anchored at this side+line. The host owns the thread
   *  component (a local `Thread` for self-review, a `GithubThread` for the
   *  reviewer) — this component only places the slot. Return `null` for none. */
  renderInline: (side: Side, line: number) => ReactNode;
  /** Create a comment over the dragged/clicked range. Omit to make the diff
   *  **read-only**: no composer slot and no multi-select drag, but inline
   *  threads still render (used for an archived workspace / closed PR). */
  onCreate?: (range: CommentRange, body: string) => Promise<void>;
  composerPlaceholder?: string;
};

// The library passes us its SplitSide enum; map to our 'left'|'right'.
const sideToOurs = (s: SplitSide): Side => (s === SplitSide.old ? 'left' : 'right');

/**
 * The shared diff + inline-comment surface. Renders one file's patch with
 * GitHub-style inline commenting: drag a line range (or click a line) to open a
 * `Composer`, and any anchored thread renders inline below its line. This is the
 * machinery extracted from self-review's `FileBlock` so the reviewer storyline
 * (Step 4) can present the *same* commenting experience over GitHub PR comments
 * — only the data model and thread renderer differ, supplied by the host
 * through `inlineAnchors` / `renderInline` / `onCreate`.
 *
 * Read-only (`onCreate` omitted) drops the write affordances but keeps the
 * inline threads — used when a PR is archived (closed/merged).
 */
export function CommentableFileDiff({
  file,
  viewMode,
  inlineAnchors,
  renderInline,
  onCreate,
  composerPlaceholder = 'Leave a comment…',
}: CommentableFileDiffProps) {
  const canComment = onCreate != null;

  // Memoize the `data` prop. The library's internal useMemo deps on `data` by
  // reference; a fresh object literal every render makes it rebuild the DiffFile,
  // and a downstream useEffect then clears the widget store — so clicking "+"
  // never opens the slot. Only rebuild when the actual patch content changes.
  const diffData = useMemo(() => {
    // Only set `fileLang` when we know it's a lowlight-supported language;
    // unknown extensions trip a noisy "not support current lang" warning
    // otherwise. The library falls back to a plain render when fileLang is absent.
    const lang = inferDiffLanguage(file.path);
    return {
      oldFile: { fileName: file.oldPath ?? file.path, fileLang: lang },
      newFile: { fileName: file.path, fileLang: lang },
      hunks: [file.patch],
    };
  }, [file.path, file.oldPath, file.patch]);

  // Bucket inline anchors by side + line for the library's extendData API.
  const extendData = useMemo(() => {
    const oldFile: Record<string, { data: InlineAnchor }> = {};
    const newFile: Record<string, { data: InlineAnchor }> = {};
    for (const a of inlineAnchors) {
      const target = a.side === 'left' ? oldFile : newFile;
      target[String(a.line)] = { data: { side: a.side, line: a.line } };
    }
    return { oldFile, newFile };
  }, [inlineAnchors]);

  // The library's widget store, captured via `onCreateUseWidgetHook` so we can
  // programmatically open the widget slot from the mouseup handler below (the
  // user expects drag-release → composer; out of the box the library only opens
  // via clicking "+" after the drag, which costs a second click).
  type WidgetHook = {
    getReadonlyState: () => { setWidget: (arg: { side?: SplitSide; lineNumber?: number }) => void };
  };
  const widgetHookRef = useRef<WidgetHook | null>(null);

  /**
   * Bypass the library's `onMultiSelectComplete` path. The wrapper filters
   * results when `result.lines.length === 0`, and the manager produces empty
   * `lines` for our DiffFile because we don't pass `newFile.content` (the
   * line-number→line-data lookup needs it). Instead we listen for mouseup
   * ourselves, pull the *range* directly from the manager via the imperative ref
   * — which is populated correctly — and open the widget slot at the end line.
   *
   * `pendingRangeRef` carries the range hint into `renderWidgetLine` because the
   * library's `multiResultRef` also stays empty (same filter).
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

  // Scoped to this block's own diff container (a mouseup inside the diff bubbles
  // up to this wrapper), so the cost is O(1) per click rather than O(files).
  const handleMouseUp = useCallback(() => {
    const result = dvRef.current?.getSelectionResult?.();
    if (!result?.range) return;
    const { side: rawSide, startLineNumber, endLineNumber } = result.range;
    const side = rawSide === 'old' ? SplitSide.old : SplitSide.new;
    const start = Math.min(startLineNumber, endLineNumber);
    const end = Math.max(startLineNumber, endLineNumber);
    pendingRangeRef.current = { side, start, end, filePath: file.path };
    widgetHookRef.current?.getReadonlyState().setWidget({ side, lineNumber: end });
  }, [file.path]);

  const renderWidgetLine = useCallback(
    ({
      lineNumber,
      fromLineNumber,
      side,
      onClose,
    }: {
      lineNumber: number;
      fromLineNumber?: number;
      side: SplitSide;
      onClose: () => void;
    }) => {
      if (!onCreate) return null;
      // Prefer the range from our mouseup handler (`pendingRangeRef`) since the
      // library's internal range cache gets cleared by its empty-lines filter.
      // Fall back to the library's lineNumber/fromLineNumber for any other path.
      const ourSide = sideToOurs(side);
      const pending = pendingRangeRef.current;
      const useRange = pending && pending.side === side && pending.filePath === file.path;
      const start = useRange ? pending.start : Math.min(lineNumber, fromLineNumber ?? lineNumber);
      const end = useRange ? pending.end : Math.max(lineNumber, fromLineNumber ?? lineNumber);
      const rangeLabel = start === end ? `L${start}` : `L${start}–L${end}`;
      return (
        <div style={{ padding: '4px 12px' }}>
          <Composer
            label={rangeLabel}
            placeholder={composerPlaceholder}
            onSave={(b) => {
              const trimmed = b.trim();
              if (!trimmed) {
                pendingRangeRef.current = null;
                onClose();
                return;
              }
              // Return the promise so the composer locks Save until it settles
              // (a fast double-click would otherwise post the comment twice).
              return onCreate({ side: ourSide, lineStart: start, lineEnd: end }, trimmed)
                .then(() => {
                  pendingRangeRef.current = null;
                  onClose();
                })
                .catch(() => {
                  // Error surfaced via the host's banner; keep the composer open
                  // so the comment text isn't lost.
                });
            }}
            onCancel={() => {
              pendingRangeRef.current = null;
              onClose();
            }}
            autoFocus
          />
        </div>
      );
    },
    [file.path, onCreate, composerPlaceholder],
  );

  const renderExtendLine = useCallback(
    ({ data }: { data?: InlineAnchor }) => {
      if (!data) return null;
      const node = renderInline(data.side, data.line);
      if (!node) return null;
      return <div style={{ padding: '4px 12px' }}>{node}</div>;
    },
    [renderInline],
  );

  if (!file.patch || file.isBinary || file.isTruncated) {
    return (
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
    );
  }

  // The library renders its own `.diff-tailwindcss-wrapper` internally. The
  // `self-review-diff` wrapper class scopes the hover-"+" CSS overlay (styles.css)
  // — shared by both commenting surfaces. The mouseup listener is scoped here
  // (bubbles up from the diff) rather than on `document`.
  return (
    <div className="self-review-diff" onMouseUp={canComment ? handleMouseUp : undefined}>
      <DiffViewWithMultiSelect
        // biome-ignore lint/suspicious/noExplicitAny: ref shape isn't exported as a usable name
        ref={dvRef as unknown as React.Ref<any>}
        data={diffData}
        diffViewMode={viewMode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
        diffViewHighlight
        // Bypass the library's width-based widget gating (its measurement lags
        // first paint, leaving the widget row empty until the next resize).
        diffViewWrap
        // No "+" gutter icon: it straddles the line-number / code boundary —
        // exactly where the user starts a drag — and its onMouseDown calls
        // stopPropagation, so the multi-select manager never sees the pointerdown.
        // Every entry goes through the multi-select pipeline instead, uniform
        // with GitHub. Disabled entirely when read-only.
        diffViewAddWidget={false}
        extendData={extendData}
        enableMultiSelect={canComment}
        onCreateUseWidgetHook={(hook) => {
          widgetHookRef.current = hook as unknown as WidgetHook;
        }}
        renderWidgetLine={canComment ? renderWidgetLine : undefined}
        renderExtendLine={renderExtendLine}
      />
    </div>
  );
}
