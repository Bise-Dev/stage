import type { CSSProperties, ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { isMaterialized } from '../../lib/worktree';
import { type AgentSession, type OverviewRow, type ReviewStatus, openUrl } from '../../tauri';
import { relativeTimeFromEpoch } from '../../time';
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
};

function Head({
  label,
  right,
  trailing,
}: {
  label: string;
  right?: boolean;
  /** Rendered just after the label — for a live indicator on the column whose
   *  data is still arriving. Inline-flex so it can't change the row height. */
  trailing?: ReactNode;
}) {
  return (
    <th
      style={{
        padding: '0 10px',
        textAlign: right ? 'right' : 'left',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        color: 'var(--gray-400)',
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
    </th>
  );
}

export function BranchTable({
  rows,
  defaultBase,
  actions,
  agentSessions,
  githubPolling,
}: {
  rows: OverviewRow[];
  defaultBase: string | null;
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
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr
            style={{
              height: 30,
              borderBottom: '1px solid var(--hairline)',
              background: 'var(--gray-50)',
            }}
          >
            <Head label="" />
            <Head label="Branch" />
            <Head label="Base" right />
            <Head label="Diff" right />
            <Head label="Self-review" />
            <Head
              label="GitHub"
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
            <Head label="Updated" right />
            <Head label="" right />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <BranchRow
              key={r.branch}
              r={r}
              defaultBase={defaultBase}
              actions={actions}
              agentSession={agentSessions?.get(r.branch) ?? null}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={8}
                style={{ ...CELL, textAlign: 'center', color: 'var(--gray-400)', height: 56 }}
              >
                No local branches match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function BranchRow({
  r,
  defaultBase,
  actions,
  agentSession,
}: {
  r: OverviewRow;
  defaultBase: string | null;
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
  // Base: a Review row carries its chosen base; a plain branch diffs against
  // the repo default (the DTO says so) — name it when we know it.
  const base = r.baseRef ?? (meta.isDefault ? null : defaultBase);
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
      <td style={{ ...CELL, width: 20, paddingLeft: 16 }}>
        <Icon name="branch" size={12} color={meta.isCurrent ? 'var(--blue)' : 'var(--gray-400)'} />
      </td>
      <td style={{ ...CELL, maxWidth: 0, minWidth: 180 }}>
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
      <td style={{ ...CELL, textAlign: 'right' }}>
        {base ? (
          <span className="mono" style={{ fontSize: 11, color: 'var(--gray-500)' }}>
            {base}
          </span>
        ) : (
          ''
        )}
      </td>
      <td
        style={{ ...CELL, textAlign: 'right', width: 110 }}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
      <td style={{ ...CELL, textAlign: 'right', color: 'var(--gray-400)', fontSize: 11 }}>
        {relativeTimeFromEpoch(meta.updatedAt)}
      </td>
      <td style={{ ...CELL, width: 170, paddingRight: 14 }}>
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
