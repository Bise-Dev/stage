import { useCallback, useRef, useState } from 'react';

/**
 * Draggable, persisted column widths for the Self-Review layout. The file list
 * and the Debrief rail are otherwise fixed-width columns; the author can drag
 * the divider between sensible min/max bounds and the choice survives reloads
 * (localStorage, same precedent as `LAYOUT_KEY` / `viewedStore`).
 */

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Owns one resizable column's width. `side` is the edge the handle sits on:
 *  - `'right'` for a left column (the file list) — dragging right widens it,
 *  - `'left'` for a right column (the rail) — dragging left widens it.
 */
export function useColumnWidth(
  key: string,
  defaultWidth: number,
  min: number,
  max: number,
  side: 'left' | 'right',
): {
  width: number;
  onResizeStart: (e: React.PointerEvent) => void;
  onResizeKey: (e: React.KeyboardEvent) => void;
} {
  const [width, setWidth] = useState<number>(() => {
    const raw = localStorage.getItem(key);
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(n) ? clamp(n, min, max) : defaultWidth;
  });
  // The width as of the in-flight drag, so the pointerup handler can persist
  // the final value without re-subscribing the move listener on every frame.
  const latest = useRef(width);

  // Keyboard resize: Arrow keys nudge the divider 16px at a time, matching the
  // drag direction (for a left column the right arrow widens it; for a right
  // column the left arrow does). Keeps the separator operable without a mouse.
  const onResizeKey = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 48 : 16;
      let delta = 0;
      if (e.key === 'ArrowRight') delta = side === 'right' ? step : -step;
      else if (e.key === 'ArrowLeft') delta = side === 'right' ? -step : step;
      else return;
      e.preventDefault();
      setWidth((w) => {
        const next = clamp(w + delta, min, max);
        latest.current = next;
        localStorage.setItem(key, String(next));
        return next;
      });
    },
    [key, min, max, side],
  );

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const onMove = (ev: PointerEvent) => {
        const delta = side === 'right' ? ev.clientX - startX : startX - ev.clientX;
        const next = clamp(startW + delta, min, max);
        latest.current = next;
        setWidth(next);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        localStorage.setItem(key, String(latest.current));
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [width, key, min, max, side],
  );

  return { width, onResizeStart, onResizeKey };
}

/** Thin draggable divider between two columns. */
export function ResizeHandle({
  onResizeStart,
  onResizeKey,
  ariaLabel,
}: {
  onResizeStart: (e: React.PointerEvent) => void;
  onResizeKey: (e: React.KeyboardEvent) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerDown={onResizeStart}
      onKeyDown={onResizeKey}
      style={{
        flex: '0 0 5px',
        marginLeft: -3,
        marginRight: -2,
        zIndex: 1,
        cursor: 'col-resize',
        background: 'transparent',
      }}
    />
  );
}
