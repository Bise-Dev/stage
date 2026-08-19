import { type Store, load as loadStore } from '@tauri-apps/plugin-store';
import {
  selfReviewViewedClear,
  selfReviewViewedImportLegacy,
  selfReviewViewedList,
  selfReviewViewedSet,
} from '../../tauri';

/**
 * Per-(repo, branch, file) "viewed" markers — engine-backed (v6-light L2, F2).
 * Marks live in the shared SQLite store, content-anchored to the post-image
 * blob the author saw (F2b): a file edited since it was marked reads back as
 * unviewed. The Rust side owns anchoring and validity; this module is the thin
 * command surface plus the one-time import of the legacy plugin-store file.
 *
 * Legacy schema (`selfReview.json`, key `viewed`):
 * `{ [repoPath]: { [branch]: { [filePath]: true } } }`. On the first load for
 * a repo we push its marks to the engine (stamped "viewed as of now"), then
 * delete the repo's key so the import cannot rerun. Import failure is loud —
 * the legacy data stays put and the error reaches the caller's banner.
 */

type LegacyViewedMap = Record<string, Record<string, Record<string, boolean>>>;

const LEGACY_STORE_FILE = 'selfReview.json';
const LEGACY_STORE_KEY = 'viewed';

let legacyStorePromise: Promise<Store> | null = null;

function getLegacyStore(): Promise<Store> {
  if (!legacyStorePromise) {
    legacyStorePromise = loadStore(LEGACY_STORE_FILE, {
      defaults: { [LEGACY_STORE_KEY]: {} },
      autoSave: true,
    });
  }
  return legacyStorePromise;
}

/** Repo paths whose legacy import already ran (or was found empty) this
 *  session — the cheap re-entry guard in front of the on-disk one. */
const importedRepos = new Set<string>();

async function importLegacyOnce(repoPath: string): Promise<void> {
  if (importedRepos.has(repoPath)) return;
  const store = await getLegacyStore();
  const all = (await store.get<LegacyViewedMap>(LEGACY_STORE_KEY)) ?? {};
  const repoBucket = all[repoPath];
  if (repoBucket && Object.keys(repoBucket).length > 0) {
    const marksByBranch: Record<string, string[]> = {};
    for (const [branch, files] of Object.entries(repoBucket)) {
      const marked = Object.keys(files).filter((f) => files[f]);
      if (marked.length > 0) marksByBranch[branch] = marked;
    }
    await selfReviewViewedImportLegacy(marksByBranch);
    // Only after a successful import: clear this repo's legacy bucket so the
    // import can't rerun (other repos import when they are opened).
    delete all[repoPath];
    await store.set(LEGACY_STORE_KEY, all);
  }
  importedRepos.add(repoPath);
}

export async function loadViewed(repoPath: string, branch: string): Promise<Set<string>> {
  await importLegacyOnce(repoPath);
  return new Set(await selfReviewViewedList(branch));
}

export async function setViewed(
  _repoPath: string,
  branch: string,
  filePath: string,
  viewed: boolean,
): Promise<void> {
  await selfReviewViewedSet(branch, filePath, viewed);
}

export async function clearViewed(_repoPath: string, branch: string): Promise<void> {
  await selfReviewViewedClear(branch);
}
