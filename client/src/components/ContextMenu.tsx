import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Where a menu should open, in viewport coordinates. */
export type MenuPoint = { x: number; y: number };

/** Distance kept between the menu and the viewport edge when it flips/clamps. */
const MARGIN = 8;

/** The cursor position of a right-click — the anchor for a context gesture. */
export function pointFromEvent(e: { clientX: number; clientY: number }): MenuPoint {
  return { x: e.clientX, y: e.clientY };
}

/** The bottom-right corner of a trigger button, so a chevron drops its menu
 *  under itself the way an anchored popover would. */
export function pointFromTrigger(el: HTMLElement): MenuPoint {
  const r = el.getBoundingClientRect();
  return { x: r.right, y: r.bottom + 2 };
}

/**
 * A menu positioned in the viewport rather than inside its trigger's box.
 *
 * `position: fixed` at an arbitrary point is what lets one menu instance serve
 * both a right-click (cursor coordinates) and a chevron (the trigger's rect),
 * and it means no ancestor needs `overflow: visible` to let the menu overhang.
 * The flip side is that it does not track its anchor, so any scroll or resize
 * dismisses it.
 *
 * Owns the dismissal contract every popover in the app hand-rolls: outside
 * pointerdown, Escape, scroll, resize. Focus moves into the menu on open and
 * returns to the trigger on close, and Arrow keys walk the enabled items, so
 * the menu is reachable without a mouse.
 */
export function ContextMenu({
  at,
  onClose,
  ariaLabel,
  children,
}: {
  at: MenuPoint;
  onClose: () => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Null until measured: the first paint would otherwise flash the menu at an
  // unflipped position when it opens near the right or bottom edge.
  const [pos, setPos] = useState<MenuPoint | null>(null);
  const restoreFocusTo = useRef<Element | null>(null);

  // Flip toward whichever side has room, then clamp so a menu taller than the
  // viewport still starts on screen. Runs before paint.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = at.x + width > vw - MARGIN ? Math.max(MARGIN, at.x - width) : at.x;
    const y = at.y + height > vh - MARGIN ? Math.max(MARGIN, at.y - height) : at.y;
    setPos({ x, y });
  }, [at.x, at.y]);

  // Take focus so Escape and the Arrow keys work even when the gesture was a
  // right-click (which leaves focus wherever it was).
  useEffect(() => {
    restoreFocusTo.current = document.activeElement;
    ref.current?.focus({ preventScroll: true });
    return () => {
      const prev = restoreFocusTo.current;
      // `body` means nothing had focus (a right-click leaves it there) — focusing
      // it back would just blur whatever the closing action moved focus to.
      if (prev instanceof HTMLElement && prev !== document.body && prev.isConnected) {
        prev.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    // Capture: a scroll inside the table/rail never bubbles to window.
    const onScroll = () => onClose();
    window.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [onClose]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    const items = Array.from(el.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'ArrowDown'
        ? items[i < 0 || i === items.length - 1 ? 0 : i + 1]
        : items[i <= 0 ? items.length - 1 : i - 1];
    next?.focus();
  }, []);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        left: pos?.x ?? at.x,
        top: pos?.y ?? at.y,
        zIndex: 60,
        outline: 'none',
        // Hidden for the one pre-measure paint, so the flip is never visible.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>
  );
}
