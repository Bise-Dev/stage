import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ContextMenu,
  type MenuPoint,
  pointFromEvent,
  pointFromTrigger,
} from '../../components/ContextMenu';
import { Icon, type IconName } from '../../components/Icon';
import { isMaterialized, materializedWorktree } from '../../lib/worktree';
import { type OverviewRow, openInFinder, openInVscode, openUrl } from '../../tauri';
import { DebriefPill } from './pills';

/**
 * The branch action menu and the provider that serves it (ADR-0028).
 *
 * One instance renders for the whole overview. Every place a branch name
 * appears — a table row, the graph rail, a graph branch-tip chip — calls
 * `openAt`/`openFromTrigger` with a branch **name**; the provider owns the one
 * name→row lookup and the one dismissal contract, so no two surfaces can drift
 * on what a branch offers or on how the menu closes.
 */

/** What the menu can do to a branch. Owned here rather than by the table,
 *  since the table is now one of three surfaces that raise it. */
export type BranchActions = {
  /** Focus the row's worktree and enter Self-Review — the one local-review
   *  surface (L7 M1): the agent Debrief renders inside it as the chaptered
   *  file list + inline banners, so there is no separate debrief route.
   *  Caller guards on a materialized worktree; the menu dims the entry
   *  otherwise. */
  onSelfReview: (r: OverviewRow) => void;
  onSwitchTo: (branch: string) => void;
  /** Surface a failure to the author (CLAUDE.md fail-loud): the overview
   *  renders it in the same dialog the git actions use. */
  onError: (title: string, message: string) => void;
  // Commented out with the review surface (see `BranchTable`'s file note):
  // onOpenStoryline: (r: OverviewRow) => void;
  // onOpenReview: (pr: PrRef) => void;
  // onDiscardDraft: (r: OverviewRow) => void;
};

/**
 * Which of the review entries a branch offers, and whether each can act now.
 *
 * Self-Review and the agent Debrief are one entry (L7 M1 — one surface), so a
 * debrief is reason enough to offer it even on the default branch. There is no
 * `any` flag any more: the universal group at the foot of the menu is always
 * live, so every branch has a menu worth opening (ADR-0028).
 */
function branchMenuEntries(r: OverviewRow) {
  const meta = r.branchMeta;
  const materialized = isMaterialized(meta);
  // `storyline` and `discard` acted on the Review artifact — commented out with
  // the review surface, so the menu is Self-review + Switch + the universal
  // group:
  //
  //   storyline: { shown: r.kind === 'draft' || r.kind === 'published', enabled: materialized },
  //   discard: { shown: r.kind === 'draft', enabled: true },
  return {
    review: { shown: !!meta && (!meta.isDefault || meta.hasDebrief), enabled: materialized },
    switchTo: { shown: !!meta && !meta.isCurrent, enabled: true },
  };
}

type OpenState = { branch: string; at: MenuPoint };

/** The props a chevron trigger needs. Handed out whole so the table's and the
 *  rail's cannot drift — including the pointerdown guard that makes the button a
 *  real toggle (the menu's outside-pointerdown would otherwise dismiss it before
 *  the click landed, and it would reopen instead of closing). */
type TriggerProps = {
  onClick: (e: React.MouseEvent<HTMLElement>) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-label': string;
};

type BranchMenuApi = {
  /** Open at the cursor — the right-click gesture. Calls `preventDefault` so
   *  the app-wide suppressor knows the event was handled. */
  openAt: (e: React.MouseEvent, branch: string) => void;
  /** Everything a chevron trigger needs, for the surfaces that show one. */
  triggerProps: (branch: string) => TriggerProps;
  /** The branch whose menu is open, for pressed styling. */
  openBranch: string | null;
};

const BranchMenuContext = createContext<BranchMenuApi | null>(null);

export function useBranchMenu(): BranchMenuApi {
  const api = useContext(BranchMenuContext);
  if (!api) throw new Error('useBranchMenu must be used inside a BranchMenuProvider');
  return api;
}

export function BranchMenuProvider({
  rows,
  actions,
  children,
}: {
  /** Every local-branch row, unfiltered by the archived view filter — the
   *  lookup has to cover every branch git can show (ADR-0028). */
  rows: OverviewRow[];
  actions: BranchActions;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<OpenState | null>(null);

  const rowByBranch = useMemo(() => {
    const m = new Map<string, OverviewRow>();
    for (const r of rows) m.set(r.branch, r);
    return m;
  }, [rows]);

  const close = useCallback(() => setOpen(null), []);

  const openFor = useCallback(
    (branch: string, at: MenuPoint) => {
      // Every local branch is assembled into a row (`overview.rs` sweeps the
      // remainder) and the archived view filter no longer runs before this, so
      // a miss is a broken invariant, not a state to render around.
      if (!rowByBranch.has(branch)) {
        console.error('branch_menu_row_missing', { branch, rows: rowByBranch.size });
        actions.onError(
          `Couldn't open the menu for ${branch}`,
          'That branch has no row in the overview snapshot, which should be impossible — every local branch is assembled into one. Fetch to reassemble it.',
        );
        return;
      }
      setOpen({ branch, at });
    },
    [rowByBranch, actions],
  );

  const openAt = useCallback(
    (e: React.MouseEvent, branch: string) => {
      e.preventDefault();
      e.stopPropagation();
      openFor(branch, pointFromEvent(e));
    },
    [openFor],
  );

  const triggerProps = useCallback(
    (branch: string): TriggerProps => ({
      onClick: (e) => {
        e.stopPropagation();
        if (open?.branch === branch) {
          close();
          return;
        }
        openFor(branch, pointFromTrigger(e.currentTarget));
      },
      // Keep the open menu's outside-pointerdown from firing on the trigger:
      // without this the menu closes on pointerdown and the click reopens it,
      // so the button never actually toggles.
      onPointerDown: (e) => e.stopPropagation(),
      'aria-haspopup': 'menu',
      'aria-expanded': open?.branch === branch,
      'aria-label': `Actions on ${branch}`,
    }),
    [open, close, openFor],
  );

  const row = open ? (rowByBranch.get(open.branch) ?? null) : null;

  // The branch can go away while its menu is open (a discard, or a sync that
  // drops it). That's a race, not a broken invariant — just close.
  useEffect(() => {
    if (open && !row) close();
  }, [open, row, close]);

  const api = useMemo<BranchMenuApi>(
    () => ({ openAt, triggerProps, openBranch: open?.branch ?? null }),
    [openAt, triggerProps, open],
  );

  return (
    <BranchMenuContext.Provider value={api}>
      {children}
      {open && row && (
        <ContextMenu at={open.at} onClose={close} ariaLabel={`Actions on ${row.branch}`}>
          <BranchMenuCard r={row} actions={actions} closeMenu={close} />
        </ContextMenu>
      )}
    </BranchMenuContext.Provider>
  );
}

/** The menu's card (design `V6L_ActionMenu` + F1; trimmed per L7 M4 — the
 *  composer's single entry is the toolbar's "New review"): the one local-review
 *  entry (Self-Review, debrief included), the draft/published entries, the
 *  explicit switch, and the universal group. No auto-switch notice — switching
 *  is its own confirmed action (ADR-0027). */
function BranchMenuCard({
  r,
  actions,
  closeMenu,
}: {
  r: OverviewRow;
  actions: BranchActions;
  closeMenu: () => void;
}) {
  const meta = r.branchMeta;
  const sr = meta?.selfReview ?? null;
  const hasDebrief = meta?.hasDebrief ?? false;
  const acts = branchMenuEntries(r);
  const worktree = materializedWorktree(meta);
  // Git's original checkout is a Worktree too (CONTEXT.md, *Root worktree*),
  // but "this branch's worktree" reads wrong for the directory the repo was
  // cloned into — most authors have no linked worktrees at all. Name it what
  // the branch list's badge calls it, so the two entries below stay true
  // whichever kind of working directory the branch sits on.
  const treeNoun = worktree?.isRoot ? 'root worktree' : 'worktree';
  const selfLabel =
    sr && sr.viewed > 0 ? `Continue self-review · ${sr.viewed}/${sr.total}` : 'Self-review';

  const run = (fn: () => void) => () => {
    closeMenu();
    fn();
  };

  /** Fire-and-forget actions still report: a clipboard write or an `open` that
   *  fails is surfaced, never swallowed (CLAUDE.md). */
  const runAsync = (title: string, fn: () => Promise<unknown>) => () => {
    closeMenu();
    fn().catch((e) => {
      console.error('branch_menu_action_failed', { title, branch: r.branch, err: String(e) });
      actions.onError(title, String(e));
    });
  };

  const hasReviewGroup = acts.review.shown;

  return (
    <div
      style={{
        width: 300,
        background: '#fff',
        borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--sh-pop)',
        padding: 5,
        // The table's cells are `nowrap`; without this the item subtitles run
        // straight out of the card's right edge.
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
          review surface — uncomment alongside `branchMenuEntries`' entries:

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
          {hasReviewGroup && <Separator />}
          <MenuItem
            icon="branch"
            color="var(--gray-700)"
            label="Switch to branch…"
            onClick={run(() => actions.onSwitchTo(r.branch))}
            sub="Stage lists the exact git commands and runs them only after you confirm."
          />
        </>
      )}
      {/* The universal group. Always live, so no branch ever raises an empty
          menu and no right-click is inert (ADR-0028). */}
      {(hasReviewGroup || acts.switchTo.shown) && <Separator />}
      <MenuItem
        icon="copy"
        color="var(--gray-600)"
        label="Copy branch name"
        onClick={runAsync("Couldn't copy the branch name", () =>
          navigator.clipboard.writeText(r.branch),
        )}
      />
      {worktree && (
        <MenuItem
          icon="folder"
          color="var(--gray-600)"
          label={`Reveal ${treeNoun} in Finder`}
          onClick={runAsync("Couldn't reveal the folder", () => openInFinder(worktree.path))}
          sub={worktree.path}
        />
      )}
      {worktree && (
        <MenuItem
          icon="code"
          color="var(--gray-600)"
          label="Open in VS Code"
          onClick={runAsync("Couldn't open VS Code", () => openInVscode(worktree.path))}
          sub={`Open the ${treeNoun} as a folder in Visual Studio Code.`}
        />
      )}
      {r.url && (
        <MenuItem
          icon="gh"
          color="var(--gray-700)"
          label={r.prNumber !== null ? `Open #${r.prNumber} on GitHub` : 'Open on GitHub'}
          onClick={runAsync("Couldn't open GitHub", () => openUrl(r.url as string))}
        />
      )}
    </div>
  );
}

function Separator() {
  return <hr style={{ border: 0, borderTop: '1px solid var(--hairline)', margin: '5px 2px' }} />;
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
              overflowWrap: 'anywhere',
            }}
          >
            {sub}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * A right-click target for a branch name. Wraps nothing and renders nothing —
 * spread it onto whatever element *is* the branch (a row, a chip).
 */
export function useBranchContextMenu(branch: string) {
  const { openAt } = useBranchMenu();
  return {
    onContextMenu: useCallback((e: React.MouseEvent) => openAt(e, branch), [openAt, branch]),
  };
}
