import type { BranchMeta } from '../generated/BranchMeta';
import type { WorktreeMeta } from '../generated/WorktreeMeta';

/**
 * Whether the branch has a **usable** worktree — one git has attached to it
 * whose directory is still there.
 *
 * A worktree git reports `prunable` (its directory was deleted behind git's
 * back) is not a Worktree for Stage's purposes (CONTEXT.md, *Worktree*):
 * nothing there can be opened, reviewed, or switched to, so every gate that
 * asks "can I act on this branch's working tree?" asks this. The branch list
 * still renders the `prunable` badge, which is how the author learns why the
 * worktree went away.
 *
 * Note git keeps refusing a second checkout of that branch until the author
 * prunes it themselves (ADR-0016 — Stage never prunes), so "not materialized"
 * does not imply "switchable": see the `checkedOutElsewhere` switch outcome.
 */
export function isMaterialized(meta: BranchMeta | null | undefined): boolean {
  const wt = meta?.worktree ?? null;
  return wt !== null && !wt.prunable;
}

/** The branch's usable worktree, or null — `isMaterialized` with the path. */
export function materializedWorktree(meta: BranchMeta | null | undefined): WorktreeMeta | null {
  const wt = meta?.worktree ?? null;
  return wt !== null && !wt.prunable ? wt : null;
}
