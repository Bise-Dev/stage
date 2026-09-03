import type { CSSProperties, ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { isMaterialized } from '../../lib/worktree';
import { type AgentSession, type OverviewRow, type ReviewStatus, openUrl } from '../../tauri';
import { ColumnResizeHandle, useColumnWidth } from '../selfReview/columnResize';
import { type BranchActions, useBranchMenu } from './BranchMenu';
import { AgentSessionPill, DebriefPill, SelfReviewPill, selfReviewStarted } from './pills';

/**
 * The dense branch table — the v6-light home (design `V6L_Branches`). One row
 * per local branch (every `OverviewRow` carrying `branchMeta`), columns for
 * the local-git facts L2 put on the snapshot (uncommitted count, debrief
 * freshness, self-review progress). A pure renderer: every cell shows a value
 * Rust already derived; absent data renders as absent ('—'), never faked.
 *
 * COMMENTED OUT here: the rest of the review surface. This version of Stage
 * supports local Self-Review + the agent's Debrief only, so the draft/published
 * Review chip and the Storyline / Discard-review row actions are commented out
 * rather than deleted. The GitHub PR column is *not* — it reads GitHub's own
 * review decision off the row and opens the PR in the browser, neither of which
 * needs the in-app reviewer.
 */

/** Status badge label + class per derived status (WS-5), shared by the GitHub
 *  chip and the local draft chip. Absent state renders as absent. */
export function statusBadge(r: OverviewRow): { label: string; cls: string } {
  if (r.archived) return { label: 'Archived', cls: '' };
  if (r.status === null) return { label: 'Published', cls: '' };
  const map: Record<ReviewStatus, { label: string; cls: string }> = {
    draft: { label: 'Draft', cls: '' },
    ready_to_publish: { label: 'Ready to publish', cls: 'badge-blue' },
    open: { label: 'In review', cls: 'badge-blue' },
    changes_requested: { label: 'Changes requested', cls: 'badge-orange' },
    approved: { label: 'Approved', cls: 'badge-green' },
    merged: { label: 'Archived', cls: '' },
    closed: { label: 'Archived', cls: '' },
  };
  return map[r.status];
}

function DiffStat({ signal }: { signal: OverviewRow['signal'] }) {
  if (!signal) return null;
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <span style={{ color: 'var(--green-d)' }}>+{signal.added}</span>{' '}
      <span style={{ color: 'var(--red-d)' }}>−{signal.removed}</span>
    </span>
  );
}

const CELL: CSSProperties = {
  padding: '0 10px',
  fontSize: 12,
  color: 'var(--gray-700)',
  whiteSpace: 'nowrap',
  height: 40,
  // `table-layout: fixed` sizes the column, but content wider than it would
  // still paint over the next cell (and past the card's right edge) — clip it.
  overflow: 'hidden',
};

function Head({
  label,
  right,
  trailing,
  resize,
}: {
  label: string;
  right?: boolean;
  /** Rendered just after the label — for a live indicator on the column whose
   *  data is still arriving. Inline-flex so it can't change the row height. */
  trailing?: ReactNode;
  /** The column's width handle (`useColumnWidth`), when the author can drag
   *  this column's right edge. */
  resize?: {
    onResizeStart: (e: React.PointerEvent) => void;
    onResizeKey: (e: React.KeyboardEvent) => void;
  };
}) {
  return (
    <th
      style={{
        position: 'relative',
        padding: '0 10px',
        textAlign: right ? 'right' : 'left',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        color: 'var(--gray-400)',
        overflow: 'hidden',
      }}
    >
      {trailing ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            justifyContent: right ? 'flex-end' : 'flex-start',
          }}
        >
          {label}
          {trailing}
        </span>
      ) : (
        label
      )}
      {resize && (
        <ColumnResizeHandle
          onResizeStart={resize.onResizeStart}
          onResizeKey={resize.onResizeKey}
          ariaLabel={`Resize the ${label} column`}
        />
      )}
    </th>
  );
}

/** Column widths the author can drag, persisted per column (`useColumnWidth`).
 *  The trailing actions column is the flexible one — it soaks up whatever is
 *  left — so the sum below is the table's minimum width and the card scrolls
 *  horizontally rather than clipping a row's buttons. */
const COLS = {
  branch: { key: 'overview:col:branch', def: 300, min: 160, max: 720 },
  diff: { key: 'overview:col:diff', def: 110, min: 70, max: 220 },
  selfReview: { key: 'overview:col:selfReview', def: 260, min: 120, max: 560 },
  github: { key: 'overview:col:github', def: 180, min: 100, max: 400 },
} as const;

/** The non-resizable columns: the branch-icon gutter and the actions column. */
const GUTTER_W = 34;
const ACTIONS_W = 176;

export function BranchTable({
  rows,
  actions,
  agentSessions,
  githubPolling,
}: {
  rows: OverviewRow[];
  actions: BranchActions;
  /** Live Claude Code sessions keyed by branch (opt-in; absent = feature off
   *  or nothing running). Probed by Rust — the table only looks its row up. */
  agentSessions?: ReadonlyMap<string, AgentSession>;
  /** A `gh` poll is in flight, so this column's cells are still the previous
   *  answer (or `—` on the first load). Spins a wheel beside the header. */
  githubPolling?: boolean;
}) {
  // The menu itself lives in the BranchMenuProvider (ADR-0028): one instance
  // for the whole overview, fixed-positioned, so the card no longer has to open
  // its overflow to let a menu overhang.
  const branchCol = useColumnWidth(
    COLS.branch.key,
    COLS.branch.def,
    COLS.branch.min,
    COLS.branch.max,
    'right',
  );
  const diffCol = useColumnWidth(
    COLS.diff.key,
    COLS.diff.def,
    COLS.diff.min,
    COLS.diff.max,
    'right',
  );
  const selfCol = useColumnWidth(
    COLS.selfReview.key,
    COLS.selfReview.def,
    COLS.selfReview.min,
    COLS.selfReview.max,
    'right',
  );
  const githubCol = useColumnWidth(
    COLS.github.key,
    COLS.github.def,
    COLS.github.min,
    COLS.github.max,
    'right',
  );
  const minWidth =
    GUTTER_W + branchCol.width + diffCol.width + selfCol.width + githubCol.width + ACTIONS_W;

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--sh-1)',
        overflow: 'hidden',
      }}
    >
      {/* The card clips (rounded corners); the scroller inside it is what
          absorbs a table wider than the window — dragging a column past the
          card's edge scrolls it rather than painting over the border. */}
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{ width: '100%', minWidth, tableLayout: 'fixed', borderCollapse: 'collapse' }}
        >
          <colgroup>
            <col style={{ width: GUTTER_W }} />
            <col style={{ width: branchCol.width }} />
            <col style={{ width: diffCol.width }} />
            <col style={{ width: selfCol.width }} />
            <col style={{ width: githubCol.width }} />
            <col />
          </colgroup>
          <thead>
            <tr
              style={{
                height: 30,
                borderBottom: '1px solid var(--hairline)',
                background: 'var(--gray-50)',
              }}
            >
              <Head label="" />
              <Head label="Branch" resize={branchCol} />
              <Head label="Diff" right resize={diffCol} />
              <Head label="Self-review" resize={selfCol} />
              <Head
                label="GitHub"
                resize={githubCol}
                trailing={
                  githubPolling ? (
                    <span
                      className="spinner"
                      role="status"
                      aria-label="Syncing pull requests from GitHub"
                      title="Syncing pull requests from GitHub"
                    />
                  ) : null
                }
              />
              <Head label="" right />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <BranchRow
                key={r.branch}
                r={r}
                actions={actions}
                agentSession={agentSessions?.get(r.branch) ?? null}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  style={{ ...CELL, textAlign: 'center', color: 'var(--gray-400)', height: 56 }}
                >
                  No local branches match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BranchRow({
  r,
  actions,
  agentSession,
}: {
  r: OverviewRow;
  actions: BranchActions;
  agentSession: AgentSession | null;
}) {
  const { openAt, triggerProps, openBranch } = useBranchMenu();
  const meta = r.branchMeta;
  if (!meta) return null; // table rows are branch-backed by construction
  const wt = meta.worktree;
  const materialized = isMaterialized(meta);
  const menuOpen = openBranch === r.branch;
  const sr = meta.selfReview;
  const st = statusBadge(r);
  const selfLabel = selfReviewStarted(sr) ? 'Continue' : 'Self-review';
  const showSelfButton = !meta.isDefault;
  // The draft/published Review chip, commented out with the review surface — the
  // Self-review column now shows only local state (debrief + viewed progress):
  //
  // const localChip =
  //   r.kind === 'draft' || (r.kind === 'published' && r.prNumber === null) ? (
  //     <button
  //       type="button"
  //       className={`badge ${st.cls}`}
  //       onClick={() => materialized && actions.onOpenStoryline(r)}
  //       disabled={!materialized}
  //       title={
  //         materialized
  //           ? 'Open the storyline for this review'
  //           : 'Check the branch out in a worktree to compose its storyline'
  //       }
  //       style={{
  //         border: 'none',
  //         cursor: 'default',
  //         fontFamily: 'inherit',
  //         flex: '0 0 auto',
  //         opacity: materialized ? 1 : 0.6,
  //       }}
  //     >
  //       {st.label}
  //     </button>
  //   ) : null;

  return (
    <tr
      // The row *is* the branch, so the whole row is the right-click target
      // (ADR-0028) — the same menu the chevron raises.
      onContextMenu={(e) => openAt(e, r.branch)}
      style={{
        borderBottom: '1px solid var(--hairline-2)',
        background: meta.isCurrent ? 'var(--blue-tint-2)' : '#fff',
      }}
    >
      <td style={{ ...CELL, paddingLeft: 16, paddingRight: 0 }}>
        <Icon name="branch" size={12} color={meta.isCurrent ? 'var(--blue)' : 'var(--gray-400)'} />
      </td>
      <td style={{ ...CELL }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span
            className="mono"
            title={meta.lastCommit ? `${r.branch} — ${meta.lastCommit}` : r.branch}
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--gray-900)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {r.branch}
          </span>
          {meta.isCurrent && (
            <span className="badge badge-blue" style={{ flex: '0 0 auto' }}>
              HEAD
            </span>
          )}
          {wt && !wt.isRoot && (
            <span
              style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center' }}
              title={`Worktree — ${wt.path}`}
            >
              <Icon name="worktree" size={12} color="var(--purple)" />
            </span>
          )}
          {wt?.prunable && (
            <span className="badge badge-orange" style={{ flex: '0 0 auto' }}>
              prunable
            </span>
          )}
          {meta.isDefault && (
            <span className="badge" style={{ flex: '0 0 auto' }}>
              default
            </span>
          )}
        </div>
      </td>
      <td
        style={{ ...CELL, textAlign: 'right' }}
        title={
          meta.changedFileCount !== null
            ? `${meta.changedFileCount} file${meta.changedFileCount === 1 ? '' : 's'} changed vs base`
            : undefined
        }
      >
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          <DiffStat signal={r.signal} />
          {meta.uncommittedCount !== null && meta.uncommittedCount > 0 && (
            <span
              style={{ color: 'var(--orange)', fontWeight: 600, marginLeft: 6 }}
              title={`${meta.uncommittedCount} uncommitted ${
                meta.uncommittedCount === 1 ? 'file' : 'files'
              } in the working tree`}
            >
              ●{meta.uncommittedCount}
            </span>
          )}
        </span>
      </td>
      <td style={{ ...CELL }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          <AgentSessionPill s={agentSession} />
          <DebriefPill r={r} />
          <SelfReviewPill sr={sr} />
          {/* {localChip} — the Review chip, commented out above */}
          {!agentSession && !meta.debriefFreshness && !selfReviewStarted(sr) && (
            <span style={{ fontSize: 11, color: 'var(--gray-300)' }}>—</span>
          )}
        </div>
      </td>
      {/* The GitHub PR cell: GitHub's own review decision (In review / Changes
          requested / Approved), opening the PR in the browser. The in-app
          reviewer it used to open is still commented out; the browser is the
          honest destination while it is. */}
      <td style={{ ...CELL }}>
        {r.prNumber !== null && r.url !== null ? (
          <button
            type="button"
            className={`badge ${st.cls || 'badge-green'}`}
            onClick={(e) => {
              // The row's own click is the menu trigger — keep the chip's to
              // itself. Fail loud on the open: log it and hand the verbatim
              // cause to the overview's banner, same contract as the menu's
              // `runAsync` (CLAUDE.md).
              e.stopPropagation();
              openUrl(r.url as string).catch((err) => {
                console.error('pr_pill_open_failed', { branch: r.branch, err: String(err) });
                actions.onError("Couldn't open the pull request", String(err));
              });
            }}
            title={`Open ${r.url} in your browser`}
            style={{
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
            }}
          >
            <Icon name="gh" size={9} color="currentColor" /> #{r.prNumber} · {st.label}
          </button>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--gray-300)' }}>—</span>
        )}
      </td>
      <td style={{ ...CELL, paddingRight: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {showSelfButton && (
            <button
              type="button"
              className="btn"
              onClick={() => actions.onSelfReview(r)}
              disabled={!materialized}
              title={
                materialized
                  ? 'Browse your changes by file, entirely on this machine'
                  : 'Not checked out in a worktree — open the menu to switch to it first'
              }
              style={{
                height: 24,
                gap: 4,
                color: 'var(--blue-press)',
                opacity: materialized ? 1 : 0.5,
                // Flatten the side the chevron butts against — every row has
                // one now (ADR-0028).
                borderTopRightRadius: 0,
                borderBottomRightRadius: 0,
                borderRight: 'none',
              }}
            >
              <Icon name="eye" size={10} color="var(--blue)" /> {selfLabel}
            </button>
          )}
          <button
            type="button"
            className="btn"
            {...triggerProps(r.branch)}
            style={{
              height: 24,
              padding: '0 6px',
              background: menuOpen ? 'var(--gray-100)' : '#fff',
              ...(showSelfButton ? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0 } : {}),
            }}
          >
            <Icon name="chevron-down" size={10} color="var(--gray-500)" />
          </button>
        </div>
      </td>
    </tr>
  );
}
