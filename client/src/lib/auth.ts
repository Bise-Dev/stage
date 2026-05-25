import { openUrl } from '@tauri-apps/plugin-opener';
import { authDevicePoll, authDeviceStart } from '../tauri';
import type { DeviceCode, User } from '../tauri';

export type DeviceFlowEvent =
  | { kind: 'code-issued'; device: DeviceCode }
  | { kind: 'polling' }
  | { kind: 'slow_down' };

export type DeviceFlowOutcome =
  | { ok: true; user: User }
  | { ok: false; reason: 'expired' | 'denied' | 'transport'; detail?: string };

/**
 * Run the github device flow end-to-end. JS owns the poll loop (sleep,
 * deadline, slow_down interval bump). Cancellation: pass an AbortSignal —
 * abort exits the loop on the next tick.
 *
 * The session token never crosses back into JS: the Rust side stashes it in
 * AppState during `auth_device_poll`. This function only returns the
 * resolved User (and the outcome) for UI routing.
 */
export async function runDeviceFlow(
  onEvent: (e: DeviceFlowEvent) => void,
  signal: AbortSignal,
): Promise<DeviceFlowOutcome> {
  let device: DeviceCode;
  try {
    device = await authDeviceStart();
  } catch (e) {
    return { ok: false, reason: 'transport', detail: String(e) };
  }

  onEvent({ kind: 'code-issued', device });
  // Best-effort browser auto-open; the UI still shows the URL as a fallback.
  openUrl(device.verification_uri).catch(() => {});

  const deadline = Date.now() + device.expires_in * 1000;
  let interval = device.interval * 1000;

  while (!signal.aborted) {
    if (Date.now() > deadline) return { ok: false, reason: 'expired' };

    let out: Awaited<ReturnType<typeof authDevicePoll>>;
    try {
      out = await authDevicePoll(device.device_code);
    } catch (e) {
      return { ok: false, reason: 'transport', detail: String(e) };
    }

    switch (out.kind) {
      case 'authorized':
        return { ok: true, user: out.user };
      case 'expired':
        return { ok: false, reason: 'expired' };
      case 'denied':
        return { ok: false, reason: 'denied' };
      case 'pending':
        onEvent({ kind: 'polling' });
        break;
      case 'slow_down':
        interval += 5000;
        onEvent({ kind: 'slow_down' });
        break;
    }

    await sleep(interval, signal);
  }

  return { ok: false, reason: 'transport', detail: 'cancelled' };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
