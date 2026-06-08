import { Icon } from '../../components/Icon';
import type { BranchInfo, WorktreeInfo } from '../../tauri';
import { relativeTimeFromEpoch } from '../../time';

/**
 * One row of the repo's branch list (ADR-0016). A branch is the unit; a worktree
 * is an annotation. Detached worktrees have no branch, so they appear as
 * worktree-only rows keyed by short SHA. Restyled to the Workspaces card/bucket
 * vocabulary (design v3): card rows grouped into Worktrees / Repository-root /
 * plain-branch buckets.
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
  /** An agent has authored a Debrief for this branch (keyed by branch, so
   *  always false for a detached worktree row). */
  hasDebrief: boolean;
  /** Which bucket the row belongs to: a linked worktree, the repo root, or a
   *  plain branch with no worktree. */
  category: 'worktree' | 'root' | 'plain';
};

/** Left-rail "Show" filter over the branch buckets. */
export type RepoFilter = 'all' | 'worktrees' | 'root';

function categoryOf(w: WorktreeInfo | null): RepoRow['category'] {
  if (!w) return 'plain';
  return w.isRoot ? 'root' : 'worktree';
}

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
  debriefBranches: Set<string>,
): RepoRow[] {
  const byBranch = new Map<string, WorktreeInfo>();
  for (const w of worktrees) {
    if (w.branch) byBranch.set(w.branch, w);
  }
  const rows: RepoRow[] = branches.map((b) => {
    const worktree = byBranch.get(b.name) ?? null;
    return {
      key: `b:${b.name}`,
      branch: b,
      worktree,
      isDefault: b.name === defaultBranch,
      hasDebrief: debriefBranches.has(b.name),
      category: categoryOf(worktree),
    };
  });
  for (const w of worktrees) {
    if (w.branch === null) {
      rows.push({
        key: `w:${w.path}`,
        branch: null,
        worktree: w,
        isDefault: false,
        hasDebrief: false,
        category: categoryOf(w),
      });
    }
  }
  return rows;
}

/** Branch-bucket counts for the left rail (derived from rows, search-agnostic). */
export function repoRowCounts(rows: RepoRow[]) {
  return {
    all: rows.length,
    worktrees: rows.filter((r) => r.category === 'worktree').length,
    root: rows.filter((r) => r.category === 'root').length,
  };
}

/** Short label for a detached worktree row's "branch" column. */
function detachedLabel(w: WorktreeInfo): string {
  return w.head ? `(${w.head.slice(0, 8)})` : '(detached)';
}

/** The ⎇ fork glyph from the design — marks a linked worktree (purple). */
function WorktreeGlyph({ size = 9, color = 'var(--purple)' }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      style={{
        stroke: color,
        strokeWidth: 1.5,
        fill: 'none',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }}
    >
      <path d="M4 2v6.5M4 11.5v0M10 5.5v0" />
      <circle cx="4" cy="11.5" r="1.3" />
      <circle cx="10" cy="4" r="1.3" />
      <path d="M4 8.5C4 6 6 5.5 8.8 4.6" />
    </svg>
  );
}

const ROW_SHELL: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  background: '#fff',
  border: '1px solid var(--hairline)',
  borderRadius: 'var(--r-md)',
  padding: '8px 10px',
  boxShadow: 'var(--sh-1)',
  minWidth: 0,
};

function Bucket({
  color,
  title,
  hint,
  count,
  children,
}: {
  color: string;
  title: string;
  hint: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, paddingLeft: 2 }}
      >
        <span
          style={{ width: 7, height: 7, borderRadius: 4, background: color, flex: '0 0 7px' }}
        />
        <span
          style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--gray-800)', letterSpacing: 0.02 }}
        >
          {title}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--gray-500)' }}>· {hint}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: 'var(--gray-500)', fontWeight: 600 }}>{count}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
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
  const { branch, worktree, isDefault, hasDebrief } = row;
  const name = branch ? branch.name : worktree ? detachedLabel(worktree) : '(unknown)';
  // Self-Review needs a working tree, so it's offered only on a worktree-backed
  // row whose directory still exists (not prunable).
  const canSelfReview = worktree !== null && worktree.prunable === null;
  const updated = branch ? relativeTimeFromEpoch(branch.updatedAt) : null;
  // Second line: the worktree path (toggleable) for worktree rows, else the last
  // commit subject so a plain branch row isn't empty.
  const subtitle = worktree && showPaths ? worktree.path : !worktree ? branch?.lastCommit : null;

  return (
    // `group` drives the hover-reveal of the Self-review button (below).
    <div className="group" style={ROW_SHELL}>
      <Icon name="branch" size={13} color="var(--gray-500)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: subtitle ? 2 : 0 }}
        >
          <span
            className="mono"
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: branch ? 'var(--gray-900)' : 'var(--gray-500)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: '0 1 auto',
            }}
          >
            {name}
          </span>
          {isDefault && (
            <span className="badge badge-green" style={{ flex: '0 0 auto' }}>
              default
            </span>
          )}
          {worktree &&
            (worktree.isRoot ? (
              <span
                className="badge"
                style={{
                  flex: '0 0 auto',
                  background: 'rgba(0,0,0,0.06)',
                  color: 'var(--gray-600)',
                }}
              >
                root
              </span>
            ) : (
              <span
                className="badge badge-purple"
                style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <WorktreeGlyph size={9} /> worktree
              </span>
            ))}
          {worktree?.detached && (
            <span className="badge" style={{ flex: '0 0 auto' }}>
              detached
            </span>
          )}
          {worktree && worktree.prunable !== null && (
            <span
              className="badge badge-orange"
              style={{ flex: '0 0 auto' }}
              title={worktree.prunable || undefined}
            >
              prunable
            </span>
          )}
          {worktree && worktree.locked !== null && (
            <span
              className="badge"
              style={{ flex: '0 0 auto' }}
              title={worktree.locked || undefined}
            >
              locked
            </span>
          )}
          {hasDebrief && (
            <span
              className="badge badge-blue"
              title="An agent has authored a Debrief for this branch"
              style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}
            >
              <Icon name="doc-stack" size={9} color="var(--blue)" /> debrief
            </span>
          )}
        </div>
        {subtitle && (
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: 'var(--gray-500)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={subtitle}
          >
            {subtitle}
          </div>
        )}
      </div>
      {updated && (
        <div
          style={{
            fontSize: 10.5,
            color: 'var(--gray-500)',
            flex: '0 0 auto',
            whiteSpace: 'nowrap',
          }}
        >
          {updated}
        </div>
      )}
      {/* Hover-reveal: the Self-review button appears only on the row the mouse is
          over (or when focused for keyboard users). opacity-0 keeps its space so
          the row doesn't reflow on hover. */}
      {canSelfReview && (
        <button
          type="button"
          className="btn opacity-0 group-hover:opacity-100 focus:opacity-100"
          onClick={() => onSelfReview(worktree.path)}
          style={{ flex: '0 0 auto', gap: 6, transition: 'opacity 80ms ease' }}
        >
          <Icon name="play" size={10} color="var(--gray-700)" /> Self-review
        </button>
      )}
    </div>
  );
}

export function RepoBranchList({
  rows,
  showPaths,
  filter,
  query,
  onSelfReview,
}: {
  rows: RepoRow[];
  showPaths: boolean;
  filter: RepoFilter;
  /** Free-text filter over branch name + worktree path. */
  query: string;
  /** Enter Self-Review for the worktree at `path`. Only ever called for rows
   *  whose `worktree` is non-null. */
  onSelfReview: (worktreePath: string) => void;
}) {
  const q = query.trim().toLowerCase();
  const matches = (r: RepoRow) => {
    if (!q) return true;
    const name = r.branch?.name ?? (r.worktree ? detachedLabel(r.worktree) : '');
    const path = r.worktree?.path ?? '';
    return name.toLowerCase().includes(q) || path.toLowerCase().includes(q);
  };
  const visible = rows.filter(matches);
  const worktreeRows = visible.filter((r) => r.category === 'worktree');
  const rootRows = visible.filter((r) => r.category === 'root');
  const plainRows = visible.filter((r) => r.category === 'plain');

  const showWorktrees = filter === 'all' || filter === 'worktrees';
  const showRoot = filter === 'all' || filter === 'root';
  const showPlain = filter === 'all';

  const empty =
    (!showWorktrees || worktreeRows.length === 0) &&
    (!showRoot || rootRows.length === 0) &&
    (!showPlain || plainRows.length === 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {showWorktrees && worktreeRows.length > 0 && (
        <Bucket
          color="var(--purple)"
          title="Worktrees"
          hint="isolated checkouts"
          count={worktreeRows.length}
        >
          {worktreeRows.map((r) => (
            <RepoBranchRow key={r.key} row={r} showPaths={showPaths} onSelfReview={onSelfReview} />
          ))}
        </Bucket>
      )}
      {showRoot && rootRows.length > 0 && (
        <Bucket
          color="var(--green-d)"
          title="Repository root"
          hint="root worktree"
          count={rootRows.length}
        >
          {rootRows.map((r) => (
            <RepoBranchRow key={r.key} row={r} showPaths={showPaths} onSelfReview={onSelfReview} />
          ))}
        </Bucket>
      )}
      {showPlain && plainRows.length > 0 && (
        <Bucket
          color="var(--gray-400)"
          title="Branches"
          hint="no worktree"
          count={plainRows.length}
        >
          {plainRows.map((r) => (
            <RepoBranchRow key={r.key} row={r} showPaths={showPaths} onSelfReview={onSelfReview} />
          ))}
        </Bucket>
      )}
      {empty && (
        <div style={{ fontSize: 12, color: 'var(--gray-500)', padding: '12px 4px' }}>
          {q ? 'No branches match your filter.' : 'No branches to show.'}
        </div>
      )}
    </div>
  );
}
