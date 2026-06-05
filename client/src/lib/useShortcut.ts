/* The one place app keyboard shortcuts are wired (see docs/adr/0015).
 *
 * `useShortcut(shortcut, handler, opts)` owns platform modifier normalization,
 * chord matching, `preventDefault`, the ignore-while-typing opt, and listener
 * cleanup — so screens declare intent (`useShortcut(RELOAD, runFetch)`) instead
 * of hand-rolling `window.addEventListener('keydown', …)` each time.
 */

import { useEffect, useRef } from 'react';
import type { Shortcut } from './shortcuts';

/** macOS uses ⌘ (metaKey) as the command modifier; everyone else uses Ctrl. */
const IS_MAC = /Mac/i.test(navigator.userAgent);

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export type ShortcutOptions = {
  /**
   * Don't fire while focus is in a text input / textarea / contenteditable.
   * Off by default: a modifier chord (e.g. ⌘R) can't be typed as text, so it's
   * safe everywhere. Turn on for future plain-key chords (`r`, `?`) that would
   * clash with typing.
   */
  ignoreWhileTyping?: boolean;
  /** Disable the binding without changing where it's called (hooks stay unconditional). */
  enabled?: boolean;
};

export function useShortcut(
  shortcut: Shortcut,
  handler: () => void,
  options: ShortcutOptions = {},
): void {
  const { ignoreWhileTyping = false, enabled = true } = options;

  // Keep the latest handler in a ref so the listener stays mounted across
  // renders (handlers are usually defined inline and change identity each
  // render) while always invoking the current closure — so a guard like
  // `if (fetching) return` inside the handler sees fresh state.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== shortcut.key) return;
      if (shortcut.mod) {
        // Require the platform command modifier and reject the other one, so a
        // ⌘R binding on macOS isn't also matched by Ctrl+R (and vice versa).
        const want = IS_MAC ? e.metaKey : e.ctrlKey;
        const reject = IS_MAC ? e.ctrlKey : e.metaKey;
        if (!want || reject) return;
      } else if (e.metaKey || e.ctrlKey) {
        return;
      }
      if (Boolean(shortcut.shift) !== e.shiftKey) return;
      if (ignoreWhileTyping && isTyping(e.target)) return;
      // Suppress the webview's native handling (⌘R would reload the whole
      // webview and wipe app state) before running ours.
      e.preventDefault();
      handlerRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut.key, shortcut.mod, shortcut.shift, ignoreWhileTyping, enabled]);
}
