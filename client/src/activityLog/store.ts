import { type Store, load as loadStore } from '@tauri-apps/plugin-store';

/**
 * Persist the Activity-log drawer's height across restarts via
 * `tauri-plugin-store` (decision: height persisted; see client/STACK.md).
 *
 * `react-resizable-panels` works in *percent of the panel group*, not pixels, so
 * we store the percent the drawer occupies (key `activity_log.drawer_size_pct`).
 * Same single-file, lazy-load, autoSave pattern as `selfReview/viewedStore.ts`.
 */

const STORE_FILE = 'activityLog.json';
const KEY = 'activity_log.drawer_size_pct';
const DEFAULT_SIZE_PCT = 30;

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) {
    // `autoSave` as a number debounces disk writes (ms) — resizing fires a
    // `set` per drag tick, so coalesce them rather than thrashing the file.
    storePromise = loadStore(STORE_FILE, { defaults: { [KEY]: DEFAULT_SIZE_PCT }, autoSave: 400 });
  }
  return storePromise;
}

export async function loadDrawerSizePct(): Promise<number> {
  const store = await getStore();
  return (await store.get<number>(KEY)) ?? DEFAULT_SIZE_PCT;
}

export async function saveDrawerSizePct(pct: number): Promise<void> {
  const store = await getStore();
  await store.set(KEY, pct);
}
