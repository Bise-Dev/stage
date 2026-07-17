import type { SelfReviewFileChange, StorylinePreview } from '../../tauri';

/**
 * A storyline step as the composer renders it: the engine's persisted step
 * (id/anchor/title/stale) joined with its diff-file metadata, plus the locally
 * **buffered** intro text — unsaved edits live in the buffer until "Save
 * storyline" persists them via `storyline_step_edit`.
 */
export type Step = {
  /** Store-minted step id — the handle for edit/remove/reorder. */
  id: string;
  /** The step's anchor: the diff file it walks through. Unique per storyline. */
  path: string;
  title: string | null;
  /** The intro as edited (buffered) — falls back to the persisted intro. */
  introText: string;
  /** Anchor no longer in the committed diff (computed in Rust). */
  stale: boolean;
  /** Single-char status chip code ("A"/"M"/"D"/"R"), null for a stale step. */
  status: string | null;
  added: number | null;
  removed: number | null;
};

/** A changed file outside the storyline (the drag pool / "unordered" rail). */
export type FileMeta = {
  path: string;
  status: string;
  added: number;
  removed: number;
};

/** `FileStatus` → the single-char chip code the order cards show. */
export function chipStatus(s: SelfReviewFileChange['status']): string {
  switch (s) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'modified':
      return 'M';
    case 'renamed':
      return 'R';
    default:
      return '?';
  }
}

/** Join the engine preview's steps with their diff files and the local intro
 *  buffer. Pure — recomputed on every preview reload / buffer edit. */
export function buildSteps(preview: StorylinePreview, buffered: Map<string, string>): Step[] {
  const fileByPath = new Map(preview.diff.files.map((f) => [f.path, f]));
  return preview.steps.map((sv) => {
    const f = fileByPath.get(sv.step.anchor) ?? null;
    return {
      id: sv.step.id,
      path: sv.step.anchor,
      title: sv.step.title,
      introText: buffered.get(sv.step.anchor) ?? sv.step.intro,
      stale: sv.stale,
      status: f ? chipStatus(f.status) : null,
      added: f ? f.additions : null,
      removed: f ? f.deletions : null,
    };
  });
}

/** The un-storied diff files as pool cards, in the diff's order. */
export function buildPool(preview: StorylinePreview): FileMeta[] {
  const unstoried = new Set(preview.unstoried);
  return preview.diff.files
    .filter((f) => unstoried.has(f.path))
    .map((f) => ({
      path: f.path,
      status: chipStatus(f.status),
      added: f.additions,
      removed: f.deletions,
    }));
}
