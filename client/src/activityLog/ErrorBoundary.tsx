import { Component, type ErrorInfo, type ReactNode } from 'react';
import { activityLogPush } from '../tauri';

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Top-level error boundary. It forwards any render error into the Activity log
 * (pill `webview`) — in release builds too, where a render crash is exactly what
 * the drawer exists to explain — then shows a minimal fallback.
 * See client/STACK.md → "Activity log".
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Fire-and-forget by necessity: we are already rendering the fallback for a
    // crash, and the fallback is the user-facing half. The push failing would
    // only cost this row in the ring, so it is swallowed rather than re-thrown
    // into a boundary that has nowhere left to go (CLAUDE.md's documented
    // exception).
    void activityLogPush({
      level: 'error',
      message: `render error: ${error.message}`,
      fields: { componentStack: info.componentStack ?? '' },
      error: error.stack ?? null,
    }).catch(() => {});
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: 24,
            textAlign: 'center',
            color: 'var(--gray-700)',
            fontFamily: 'var(--font-ui)',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 14 }}>Something went wrong.</div>
          <div className="mono" style={{ fontSize: 12, color: 'var(--red-d)' }}>
            {this.state.error.message}
          </div>
          <div style={{ fontSize: 12, color: 'var(--gray-500)' }}>
            Open the Activity log (⌘`) for details, then reload.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
