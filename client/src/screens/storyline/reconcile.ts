import type { ChangedFile, StorylineFile } from '../../tauri';

/** One editable storyline step in the composition screen. */
export type Step = {
  path: string;
  introText: string;
  /** Current-diff metadata; null when the saved step's file is no longer in the diff. */
  status: string | null;
  added: number | null;
  removed: number | null;
  /** True when this saved step's file no longer appears in the branch diff. */
  stale: boolean;
};

export type Reconciled = {
  /** Included steps, in saved order. */
  steps: Step[];
  /** Changed files not yet promoted to a step. */
  pool: ChangedFile[];
};

/** Merge the saved storyline (paths + intros + order) with the files currently
 * changed on the branch. Saved steps keep their order and intro; ones whose file
 * vanished from the diff are surfaced as `stale` (never silently dropped — the
 * author removes them). Remaining changed files form the pool to add from. */
export function reconcile(changed: ChangedFile[], saved: StorylineFile[]): Reconciled {
  const byPath = new Map(changed.map((c) => [c.path, c]));
  const ordered = [...saved].sort((a, b) => a.order_index - b.order_index);
  const steps: Step[] = ordered.map((s) => {
    const c = byPath.get(s.diff_file_path);
    return {
      path: s.diff_file_path,
      introText: s.intro_text,
      status: c ? c.status : null,
      added: c ? c.added : null,
      removed: c ? c.removed : null,
      stale: !c,
    };
  });
  const taken = new Set(ordered.map((s) => s.diff_file_path));
  const pool = changed.filter((c) => !taken.has(c.path));
  return { steps, pool };
}
