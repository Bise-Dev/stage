import {
  type CSSProperties,
  type ComponentProps,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Icon } from '../../components/Icon';
import type { SelfReviewProgress } from '../../generated/SelfReviewProgress';

type IconName = ComponentProps<typeof Icon>['name'];
import type { OverviewRow, ReviewStatus } from '../../tauri';
import { relativeTimeFromEpoch } from '../../time';

/**
 * The dense branch table — the v6-light home (design `V6L_Branches`). One row
 * per local branch (every `OverviewRow` carrying `branchMeta`), columns for
 * the local-git facts L2 put on the snapshot (uncommitted count, debrief
 * freshness, self-review progress). A pure renderer: every cell shows a value
 * Rust already derived; absent data renders as absent ('—'), never faked.
 *
 * COMMENTED OUT here: the review surface. This version of Stage supports local
 * Self-Review + the agent's Debrief only, so the draft/published Review chip,
 * the GitHub PR column (it carries GitHub's *review decision*) and the
 * Storyline / Discard-review row actions are commented out rather than deleted.
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

/** Purple "debrief · new" pill / muted "debrief" / orange "debrief · outdated"
 *  — straight off L2's derived `DebriefFreshness`. */
function DebriefPill({ r }: { r: OverviewRow }) {
  const f = r.branchMeta?.debriefFreshness ?? null;
  if (f === null) return null;
  if (f === 'new') {
    return (
      <span
        className="badge badge-purple"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto' }}
      >
        <span style={{ width: 5, height: 5, borderRadius: 3, background: 'var(--purple)' }} />
        debrief · new
      </span>
    );
  }
  if (f === 'outdated') {
    return (
      <span className="badge badge-orange" style={{ flex: '0 0 auto' }}>
        debrief · outdated
      </span>
    );
  }
  return (
    <span style={{ fontSize: 10.5, color: 'var(--gray-500)', flex: '0 0 auto' }}>debrief</span>
  );
}

/** Blue progress pill while a self-review is underway (viewed/total from the
 *  content-anchored marks; the done state was removed in L7 — F3 rescinded). */
function SelfReviewPill({ sr }: { sr: SelfReviewProgress | null }) {
  if (!sr) return null;
  if (sr.viewed === 0) return null;
  const pct = sr.total > 0 ? Math.min(100, Math.round((sr.viewed / sr.total) * 100)) : 0;
  return (
    <span
      title={`Self-review in progress · ${sr.viewed}/${sr.total} files viewed`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 7px 2px 6px',
        borderRadius: 20,
        background: 'var(--blue-tint)',
        border: '1px solid rgba(0,122,255,0.28)',
        flex: '0 0 auto',
      }}
    >
      <span
        style={{
          position: 'relative',
          width: 22,
          height: 4,
          borderRadius: 2,
          background: 'rgba(0,122,255,0.2)',
          display: 'inline-block',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            height: '100%',
            width: `${pct}%`,
            borderRadius: 2,
            background: 'var(--blue)',
          }}
        />
      </span>
      <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--blue-press)' }}>
        {sr.viewed}/{sr.total}
      </span>
    </span>
  );
}

export type BranchTableActions = {
  /** Focus the row's worktree and enter Self-Review — the one local-review
   *  surface (L7 M1): the agent Debrief renders inside it as the chaptered
   *  file list + inline banners, so there is no separate debrief route.
   *  Caller guards on a materialized worktree; the table disables the
   *  affordance otherwise. */
  onSelfReview: (r: OverviewRow) => void;
  onSwitchTo: (branch: string) => void;
  // Commented out with the review surface (see the note at the top of the file):
  // onOpenStoryline: (r: OverviewRow) => void;
  // onOpenReview: (pr: PrRef) => void;
  // onDiscardDraft: (r: OverviewRow) => void;
};

/**
 * Which menu entries a row offers, and whether each can act right now.
 *
 * Self-Review and the agent Debrief are one entry (L7 M1 — one surface), so a
 * debrief is reason enough to offer it even on the default branch. `any` is
 * false when the row has nothing actionable at all (the default branch you are
 * already on): the caller then renders no chevron rather than a menu whose
 * every item is dead.
 */
function rowMenuActions(r: OverviewRow) {
  const meta = r.branchMeta;
  const wt = meta?.worktree ?? null;
  const materialized = wt !== null && !wt.prunable;
  // `storyline` and `discard` acted on the Review artifact — commented out with
  // the review surface, so the menu is Self-review + Switch only:
  //
  //   storyline: { shown: r.kind === 'draft' || r.kind === 'published', enabled: materialized },
  //   discard: { shown: r.kind === 'draft', enabled: true },
  const entries = {
    review: { shown: !!meta && (!meta.isDefault || meta.hasDebrief), enabled: materialized },
    switchTo: { shown: !!meta && !meta.isCurrent, enabled: true },
  };
  return { ...entries, any: Object.values(entries).some((e) => e.shown && e.enabled) };
}

const CELL: CSSProperties = {
  padding: '0 10px',
  fontSize: 12,
  color: 'var(--gray-700)',
  whiteSpace: 'nowrap',
  height: 40,
};

function Head({ label, right }: { label: string; right?: boolean }) {
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
      {label}
    </th>
  );
}

// Fed the commented-out PR cell; commented out with it:
//
// /** Parse `{owner}/{name}#{number}` out of a PR's github.com URL — same rule as
//  *  the board rows used; null on unknown shapes (the chip then stays inert). */
// function prRefFromUrl(url: string | null): PrRef | null {
//   if (!url) return null;
//   const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
//   if (!m) return null;
//   return { owner: m[1], name: m[2], number: Number(m[3]) };
// }

export function BranchTable({
  rows,
  defaultBase,
  actions,
}: {
  rows: OverviewRow[];
  defaultBase: string | null;
  actions: BranchTableActions;
}) {
  // One menu open at a time, keyed by branch. Escape / click-outside dismiss
  // per the RepoMenu popover pattern.
  const [menuBranch, setMenuBranch] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (menuBranch === null) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuBranch(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuBranch(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuBranch]);

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--sh-1)',
        // The open menu overhangs the table card; scrolling happens on the
        // page column, not inside the card, so visible overflow is safe.
        overflow: menuBranch !== null ? 'visible' : 'hidden',
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
            {/* <Head label="GitHub" /> — commented out with the PR column */}
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
              menuOpen={menuBranch === r.branch}
              menuRef={menuBranch === r.branch ? menuRef : undefined}
              onToggleMenu={() => setMenuBranch((cur) => (cur === r.branch ? null : r.branch))}
              closeMenu={() => setMenuBranch(null)}
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
  menuOpen,
  menuRef,
  onToggleMenu,
  closeMenu,
}: {
  r: OverviewRow;
  defaultBase: string | null;
  actions: BranchTableActions;
  menuOpen: boolean;
  menuRef?: React.RefObject<HTMLDivElement | null>;
  onToggleMenu: () => void;
  closeMenu: () => void;
}) {
  const meta = r.branchMeta;
  if (!meta) return null; // table rows are branch-backed by construction
  const wt = meta.worktree;
  const materialized = wt !== null && !wt.prunable;
  const sr = meta.selfReview;
  // Both only fed the commented-out Review chip + PR cell:
  // const st = statusBadge(r);
  // const pr = prRefFromUrl(r.url);
  // Base: a Review row carries its chosen base; a plain branch diffs against
  // the repo default (the DTO says so) — name it when we know it.
  const base = r.baseRef ?? (meta.isDefault ? null : defaultBase);
  const selfLabel = sr && sr.viewed > 0 ? 'Continue' : 'Self-review';
  const acts = rowMenuActions(r);
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
          <DebriefPill r={r} />
          <SelfReviewPill sr={sr} />
          {/* {localChip} — the Review chip, commented out above */}
          {!meta.debriefFreshness && (!sr || sr.viewed === 0) && (
            <span style={{ fontSize: 11, color: 'var(--gray-300)' }}>—</span>
          )}
        </div>
      </td>
      {/* The GitHub PR cell, commented out with the review surface — it renders
          GitHub's review decision (In review / Changes requested / Approved)
          and opens the PR in the reviewer:

      <td style={{ ...CELL }}>
        {r.prNumber !== null ? (
          <button
            type="button"
            className={`badge ${st.cls || 'badge-green'}`}
            onClick={() => pr && actions.onOpenReview(pr)}
            disabled={!pr}
            title={r.url ?? undefined}
            style={{
              border: 'none',
              cursor: 'default',
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
      */}
      <td style={{ ...CELL, textAlign: 'right', color: 'var(--gray-400)', fontSize: 11 }}>
        {relativeTimeFromEpoch(meta.updatedAt)}
      </td>
      <td style={{ ...CELL, width: 170, paddingRight: 14, position: 'relative' }}>
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
                // Only flatten the side the chevron butts against; a row with
                // no menu keeps a plain, fully-rounded button.
                ...(acts.any
                  ? { borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRight: 'none' }
                  : {}),
              }}
            >
              <Icon name="eye" size={10} color="var(--blue)" /> {selfLabel}
            </button>
          )}
          {acts.any && (
            <button
              type="button"
              className="btn"
              onClick={onToggleMenu}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`Actions on ${r.branch}`}
              style={{
                height: 24,
                padding: '0 6px',
                background: menuOpen ? 'var(--gray-100)' : '#fff',
                ...(showSelfButton ? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0 } : {}),
              }}
            >
              <Icon name="chevron-down" size={10} color="var(--gray-500)" />
            </button>
          )}
        </div>
        {menuOpen && (
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'absolute', top: 'calc(100% - 4px)', right: 12, zIndex: 30 }}
          >
            <BranchActionMenu r={r} actions={actions} closeMenu={closeMenu} />
          </div>
        )}
      </td>
    </tr>
  );
}

/** The per-branch action menu (design `V6L_ActionMenu` + F1; trimmed per L7
 *  M4 — the composer's single entry is the toolbar's "New review"): the one
 *  local-review entry (Self-Review, debrief included), the draft/published
 *  entries, and the explicit switch. No auto-switch notice — switching is its
 *  own confirmed action (ADR-0027). Only rendered when `rowMenuActions().any`,
 *  so every menu that opens has at least one live entry. */
function BranchActionMenu({
  r,
  actions,
  closeMenu,
}: {
  r: OverviewRow;
  actions: BranchTableActions;
  closeMenu: () => void;
}) {
  const meta = r.branchMeta;
  if (!meta) return null;
  const sr = meta.selfReview;
  const hasDebrief = meta.hasDebrief;
  const acts = rowMenuActions(r);
  const selfLabel =
    sr && sr.viewed > 0 ? `Continue self-review · ${sr.viewed}/${sr.total}` : 'Self-review';

  const run = (fn: () => void) => () => {
    closeMenu();
    fn();
  };

  return (
    <div
      style={{
        width: 300,
        background: '#fff',
        borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--sh-pop)',
        padding: 5,
        // The menu lives inside a table cell, and `CELL` is `nowrap` — without
        // this the item subtitles run straight out of the card's right edge.
        whiteSpace: 'normal',
      }}
    >
      <div
        className="section-label"
        style={{ padding: '6px 10px 4px', display: 'flex', alignItems: 'center', gap: 5 }}
      >
        <Icon name="branch" size={10} color="var(--gray-400)" />{' '}
        <span
          className="mono"
          style={{
            textTransform: 'none',
            letterSpacing: 0,
            // Long branch names truncate rather than widening/wrapping the card.
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={r.branch}
        >
          {r.branch}
        </span>
      </div>
      {/* One local-review entry: the agent Debrief is part of Self-Review, so
          it rides along as the freshness pill instead of a second item. */}
      {acts.review.shown && (
        <MenuItem
          icon="eye"
          color="var(--blue)"
          label={selfLabel}
          primary={acts.review.enabled}
          dim={!acts.review.enabled}
          onClick={acts.review.enabled ? run(() => actions.onSelfReview(r)) : undefined}
          sub={
            acts.review.enabled
              ? hasDebrief
                ? "Browse your changes by file, with your agent's debrief alongside them."
                : 'Browse your changes by file, entirely on this machine.'
              : hasDebrief
                ? 'Not checked out — switch to this branch (below) to read the debrief alongside its diff.'
                : 'Not checked out — switch to this branch (below) to self-review it here.'
          }
          right={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              {sr && sr.viewed > 0 && <span className="badge badge-blue">ongoing</span>}
              <DebriefPill r={r} />
            </span>
          }
        />
      )}
      {/* The Storyline and Discard-review entries, commented out with the
          review surface:

      {acts.storyline.shown && (
        <MenuItem
          icon="doc-stack"
          color="var(--gray-600)"
          label="Storyline"
          dim={!acts.storyline.enabled}
          onClick={acts.storyline.enabled ? run(() => actions.onOpenStoryline(r)) : undefined}
          sub={
            acts.storyline.enabled
              ? 'Open the storyline composer for this review.'
              : 'Check the branch out in a worktree to compose its storyline.'
          }
        />
      )}
      {acts.discard.shown && (
        <MenuItem
          icon="chevron-left"
          color="var(--gray-600)"
          label="Discard review…"
          onClick={run(() => actions.onDiscardDraft(r))}
          sub="Remove the draft; the branch returns to Self-Review."
        />
      )}
      */}
      {acts.switchTo.shown && (
        <>
          {/* Separator only when there is something above it to separate. */}
          {acts.review.shown && (
            <hr style={{ border: 0, borderTop: '1px solid var(--hairline)', margin: '5px 2px' }} />
          )}
          <MenuItem
            icon="branch"
            color="var(--gray-700)"
            label="Switch to branch…"
            onClick={run(() => actions.onSwitchTo(r.branch))}
            sub="Stage lists the exact git commands and runs them only after you confirm."
          />
        </>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  color,
  label,
  sub,
  dim,
  right,
  primary,
  onClick,
}: {
  icon: IconName;
  color: string;
  label: string;
  sub?: string;
  dim?: boolean;
  right?: ReactNode;
  primary?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={!onClick}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        width: '100%',
        textAlign: 'left',
        padding: '9px 10px',
        borderRadius: 7,
        opacity: dim ? 0.6 : 1,
        background: primary ? 'var(--blue-tint)' : 'transparent',
        border: `1px solid ${primary ? 'rgba(0,122,255,0.20)' : 'transparent'}`,
        cursor: 'default',
        fontFamily: 'inherit',
      }}
    >
      <span style={{ flex: '0 0 16px', marginTop: 1, display: 'flex' }}>
        <Icon name={icon} size={13} color={color} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--gray-900)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            // Badges drop to a second line rather than pushing past the card.
            flexWrap: 'wrap',
          }}
        >
          {label}
          {right}
        </span>
        {sub && (
          <span
            style={{
              display: 'block',
              fontSize: 11,
              color: 'var(--gray-500)',
              marginTop: 1,
              lineHeight: 1.4,
            }}
          >
            {sub}
          </span>
        )}
      </span>
    </button>
  );
}
