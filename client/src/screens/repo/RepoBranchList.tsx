import { Icon } from '../../components/Icon';
import type { BranchInfo, WorktreeInfo } from '../../tauri';

/**
 * One row of the repo's branch list (ADR-0016, presentation "B2"). A branch is
 * the unit; a worktree is an annotation. Detached worktrees have no branch, so
 * they appear as worktree-only rows keyed by short SHA.
 */
export type RepoRow = {
  /** Stable key. */
  key: string;
  /** The branch, or null for a detached worktree. */
  branch: BranchInfo | null;
  /** The worktree this branch is checked out in, or null for a plain branch. */
  worktree: WorktreeInfo | null;
  /** This branch is the repo's default branch. */
  isDefault: boolean;
};

/**
 * Join `git_local_branches` × `repo_worktrees` into rows: every local branch
 * (worktree attached when git reports one), followed by any detached worktrees
 * (no branch). Pure — no I/O. Branches keep `gitLocalBranches` recency order;
 * detached worktrees append.
 */
export function buildRepoRows(
  branches: BranchInfo[],
  worktrees: WorktreeInfo[],
  defaultBranch: string | null,
): RepoRow[] {
  const byBranch = new Map<string, WorktreeInfo>();
  for (const w of worktrees) {
    if (w.branch) byBranch.set(w.branch, w);
  }
  const rows: RepoRow[] = branches.map((b) => ({
    key: `b:${b.name}`,
    branch: b,
    worktree: byBranch.get(b.name) ?? null,
    isDefault: b.name === defaultBranch,
  }));
  for (const w of worktrees) {
    if (w.branch === null) {
      rows.push({ key: `w:${w.path}`, branch: null, worktree: w, isDefault: false });
    }
  }
  return rows;
}

/** Short label for a detached worktree row's "branch" column. */
function detachedLabel(w: WorktreeInfo): string {
  return w.head ? `(${w.head.slice(0, 8)})` : '(detached)';
}

export function RepoBranchList({
  rows,
  showPaths,
  onSelfReview,
}: {
  rows: RepoRow[];
  showPaths: boolean;
  /** Enter Self-Review for the worktree at `path`. Only ever called for rows
   *  whose `worktree` is non-null. */
  onSelfReview: (worktreePath: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {rows.map((row) => (
        <RepoBranchRow key={row.key} row={row} showPaths={showPaths} onSelfReview={onSelfReview} />
      ))}
    </div>
  );
}

function RepoBranchRow({
  row,
  showPaths,
  onSelfReview,
}: {
  row: RepoRow;
  showPaths: boolean;
  onSelfReview: (worktreePath: string) => void;
}) {
  const { branch, worktree, isDefault } = row;
  const name = branch ? branch.name : worktree ? detachedLabel(worktree) : '(unknown)';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '7px 10px',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <Icon name="branch" size={12} color="var(--gray-500)" />

      {/* Branch column: name + default (intrinsic to the branch). */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 150, flex: '0 0 auto' }}
      >
        <span
          className="mono"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: branch ? 'var(--gray-900)' : 'var(--gray-500)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>
        {isDefault && <span className="badge badge-green">default</span>}
      </div>

      {/* Worktree column: badges + path (extrinsic), empty for a plain branch. */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontSize: 11,
          color: 'var(--gray-500)',
        }}
      >
        {worktree ? (
          <>
            {worktree.isRoot ? (
              <span className="badge">root</span>
            ) : (
              <span className="badge badge-purple">⌥ worktree</span>
            )}
            {worktree.detached && <span className="badge">detached</span>}
            {worktree.prunable !== null && (
              <span className="badge badge-orange" title={worktree.prunable || undefined}>
                prunable
              </span>
            )}
            {worktree.locked !== null && (
              <span className="badge" title={worktree.locked || undefined}>
                locked
              </span>
            )}
            {showPaths && (
              <span
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={worktree.path}
              >
                {worktree.path}
              </span>
            )}
          </>
        ) : (
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {branch?.lastCommit ?? ''}
          </span>
        )}
      </div>

      {/* Self-Review only on a worktree-backed row whose dir exists (not prunable). */}
      {worktree && worktree.prunable === null && (
        <button
          type="button"
          className="btn"
          onClick={() => onSelfReview(worktree.path)}
          style={{ flex: '0 0 auto' }}
        >
          <Icon name="play" size={10} color="var(--gray-700)" /> Self-Review
        </button>
      )}
    </div>
  );
}
