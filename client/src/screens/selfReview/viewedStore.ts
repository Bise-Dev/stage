import { type Store, load as loadStore } from '@tauri-apps/plugin-store';

/**
 * Per-(repo, branch, file) "viewed" markers, persisted across app restarts.
 * Q11 settled on a single file (`selfReview.json`) holding the whole map; we
 * load it lazily on first use.
 *
 * Schema: { [repoPath]: { [branch]: { [filePath]: true } } }
 */

type ViewedMap = Record<string, Record<string, Record<string, boolean>>>;

const STORE_FILE = 'selfReview.json';
const STORE_KEY = 'viewed';

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) {
    // `defaults` is required by the plugin's typings; we drive everything off
    // a single key (`viewed`) whose default is an empty map.
    storePromise = loadStore(STORE_FILE, { defaults: { [STORE_KEY]: {} }, autoSave: true });
  }
  return storePromise;
}

export async function loadViewed(repoPath: string, branch: string): Promise<Set<string>> {
  const store = await getStore();
  const all = (await store.get<ViewedMap>(STORE_KEY)) ?? {};
  const paths = all[repoPath]?.[branch] ?? {};
  return new Set(Object.keys(paths).filter((p) => paths[p]));
}

export async function setViewed(
  repoPath: string,
  branch: string,
  filePath: string,
  viewed: boolean,
): Promise<void> {
  const store = await getStore();
  const all = (await store.get<ViewedMap>(STORE_KEY)) ?? {};
  const repoBucket = all[repoPath] ?? {};
  const branchBucket = repoBucket[branch] ?? {};
  if (viewed) {
    branchBucket[filePath] = true;
  } else {
    delete branchBucket[filePath];
  }
  repoBucket[branch] = branchBucket;
  all[repoPath] = repoBucket;
  await store.set(STORE_KEY, all);
}

export async function clearViewed(repoPath: string, branch: string): Promise<void> {
  const store = await getStore();
  const all = (await store.get<ViewedMap>(STORE_KEY)) ?? {};
  if (all[repoPath]?.[branch]) {
    delete all[repoPath][branch];
    await store.set(STORE_KEY, all);
  }
}
