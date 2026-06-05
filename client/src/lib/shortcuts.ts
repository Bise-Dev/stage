/* Canonical keyboard chords for the app (see docs/adr/0015).
 *
 * One place to see every shortcut. Screens bind these via `useShortcut`
 * (./useShortcut.ts) — they never touch raw `keydown` themselves. Add a new
 * chord here, then `useShortcut(THE_CHORD, handler)` at the call site.
 */

export type Shortcut = {
  /** The non-modifier key, lowercase (compared against `KeyboardEvent.key`). */
  key: string;
  /**
   * Require the platform command modifier: ⌘ (metaKey) on macOS, Ctrl
   * (ctrlKey) on Windows/Linux. The hook requires exactly that modifier and
   * rejects the other one.
   */
  mod?: boolean;
  /** Require the Shift modifier. */
  shift?: boolean;
};

/**
 * Reload the current screen's data. On macOS ⌘R, elsewhere Ctrl+R — the native
 * reload convention. The hook `preventDefault`s it so the webview's own reload
 * (which would wipe app state) never fires.
 */
export const RELOAD: Shortcut = { key: 'r', mod: true };
