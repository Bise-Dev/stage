import { useEffect } from 'react';

/**
 * Suppress the webview's own right-click menu app-wide.
 *
 * Installed once at the app root rather than per component, for the reason
 * ADR-0015 gives for keyboard chords: a gesture the whole app shares should
 * have one owner, not a listener hand-rolled at every call site.
 *
 * WKWebView's native menu (Reload / Back / Inspect Element) reads as a webview
 * tell inside an app that otherwise feels native, so the default is to
 * suppress. Three exemptions keep the platform behaviour where it is the right
 * answer:
 *
 * - **Already handled.** A menu of ours called `preventDefault` on the way up,
 *   so there is nothing to suppress — and this check is what lets our menu win
 *   over the selection exemption below when the two overlap.
 * - **Text entry and selections.** Inside an input, or over a live selection,
 *   the native menu carries spell-check / copy / look-up, which we do not
 *   reimplement.
 * - **Alt.** `Alt`+right-click always lets the native menu through, so
 *   Inspect Element stays reachable. That keeps dev and release identical:
 *   nobody develops against a gesture that behaves differently once shipped.
 */
export function useSuppressNativeContextMenu() {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (e.altKey) return;
      const target = e.target as Element | null;
      if (target?.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]')) {
        return;
      }
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim() !== '') return;
      e.preventDefault();
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);
}
