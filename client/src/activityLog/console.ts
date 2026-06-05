import { type ActivityLogLevel, activityLogPush } from '../tauri';

// Forward `window.console.*` into the Rust Activity-log ring as `webview` rows.
// Dev-only — callers gate on `import.meta.env.DEV`. See client/STACK.md.

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

const LEVEL: Record<ConsoleMethod, ActivityLogLevel> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
};

let installed = false;

/**
 * Override each `console.*` method to (1) call the original (so DevTools still
 * works) and (2) forward the call into the activity ring. Idempotent: safe under
 * React StrictMode's double-invoke. The forwarding is fire-and-forget; its
 * failure handler uses the *original* console method, never the overridden one,
 * so a push failure can't re-enter this forwarder.
 */
export function installConsoleForwarding(): void {
  if (installed) return;
  installed = true;

  for (const method of Object.keys(LEVEL) as ConsoleMethod[]) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      try {
        const { message, error } = formatArgs(args);
        void activityLogPush({ level: LEVEL[method], message, error }).catch((e) => {
          original('activity_log_push failed', e);
        });
      } catch (e) {
        original('activity_log forward failed', e);
      }
    };
  }
}

/** Flatten console args into a single message string, lifting any `Error`'s
 *  stack into the dedicated `error` slot. */
function formatArgs(args: unknown[]): { message: string; error: string | null } {
  let error: string | null = null;
  const parts = args.map((a) => {
    if (a instanceof Error) {
      error = a.stack ?? `${a.name}: ${a.message}`;
      return a.message;
    }
    if (typeof a === 'string') return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  });
  return { message: parts.join(' '), error };
}
