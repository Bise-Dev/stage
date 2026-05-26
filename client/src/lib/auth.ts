import { type User, authSignIn, authSignInCancel } from '../tauri';

export type AuthEvent =
  | { kind: 'started' }
  | { kind: 'authenticated'; user: User }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

export async function runWebFlow(
  onEvent: (event: AuthEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    onEvent({ kind: 'cancelled' });
    return;
  }

  const onAbort = () => {
    authSignInCancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort);

  onEvent({ kind: 'started' });
  try {
    const user = await authSignIn();
    onEvent({ kind: 'authenticated', user });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('cancelled')) {
      onEvent({ kind: 'cancelled' });
    } else {
      onEvent({ kind: 'error', message });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
