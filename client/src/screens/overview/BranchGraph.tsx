import { useCallback, useEffect, useMemo, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { CollapsibleRail, RailStripStat, useRailCollapsed } from '../../components/CollapsibleRail';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import type { BranchMeta } from '../../generated/BranchMeta';
import type { GraphBranch } from '../../generated/GraphBranch';
import type { BranchGraphView, GraphRow, OverviewRow } from '../../tauri';
import { branchGraph } from '../../tauri';
import { relativeTimeFromEpoch } from '../../time';
import { useBranchMenu } from './BranchMenu';
import { selfReviewStarted } from './pills';

/**
 * The branch graph view — v6-light L6 (design `V6_BranchGraph`). A pure
 * renderer over the engine's precomputed lane geometry: straight vertical
 * lanes, orthogonal fork elbows, one fixed-height row per commit. Clicking a
 * commit row highlights it locally and drives nothing else.
 *
 * Branch *names* here are action surfaces, though (ADR-0028): a rail row and a
 * branch-tip chip raise the same menu the table's chevron does, since they name
 * the same branch. L6's read-only scope note is superseded — nothing
 * destructive rides on the gesture, as the switch keeps its command-listing
 * confirmation (ADR-0027).
 *
 * The left rail reuses the overview snapshot's `BranchMeta` pills (debrief
 * freshness, self-review progress) joined by branch name; lane colors come
 * from the engine's branch→lane mapping.
 */

const ROW_H = 34;
const LANE_W = 18;
const INSET = 16;
/** Per-lane palette (design `V6_LANES` hues, applied per lane, cycled). */
const LANE_COLORS = ['#2A6FDB', '#FF9500', '#34C759', '#AF52DE', '#5AC8FA', '#FF2D55'];

const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];
const laneX = (lane: number) => INSET + lane * LANE_W + LANE_W / 2;

const COLLAPSED_KEY = 'graph:railCollapsed';

function RowSvg({ row, width }: { row: GraphRow; width: number }) {
  const mid = ROW_H / 2;
  const dotX = laneX(row.lane);
  const isHead = row.labels.some((l) => l.isHead);
  return (
    <svg
      width={width}
      height={ROW_H}
      style={{ display: 'block', flex: `0 0 ${width}px` }}
      aria-hidden="true"
    >
      {row.through.map((l) => (
        <line
          key={`t${l}`}
          x1={laneX(l)}
          y1={0}
          x2={laneX(l)}
          y2={ROW_H}
          stroke={laneColor(l)}
          strokeWidth={2}
          opacity={0.9}
        />
      ))}
      {row.forks.map((l) => (
        <g key={`f${l}`}>
          <line x1={laneX(l)} y1={0} x2={laneX(l)} y2={mid} stroke={laneColor(l)} strokeWidth={2} />
          <line x1={laneX(l)} y1={mid} x2={dotX} y2={mid} stroke={laneColor(l)} strokeWidth={2} />
        </g>
      ))}
      <circle
        cx={dotX}
        cy={mid}
        r={row.isMerge ? 4 : 5}
        fill="#fff"
        stroke={laneColor(row.lane)}
        strokeWidth={row.isMerge ? 2.5 : 3}
      />
      {isHead && (
        <circle
          cx={dotX}
          cy={mid}
          r={9}
          fill="none"
          stroke={laneColor(row.lane)}
          strokeWidth={1.5}
          opacity={0.45}
        />
      )}
    </svg>
  );
}

/** Branch-tip chip inline with the commit subject. The chip *is* a branch name,
 *  so it right-clicks to the branch menu — the commit row around it does not,
 *  since a commit is not a branch (ADR-0028). */
function LabelChip({
  label,
  lane,
}: {
  label: GraphRow['labels'][number];
  lane: number;
}) {
  const color = laneColor(lane);
  const { openAt } = useBranchMenu();
  return (
    <span
      onContextMenu={(e) => openAt(e, label.branch)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 7px',
        borderRadius: 5,
        background: `${color}18`,
        border: `1px solid ${color}55`,
        flex: '0 0 auto',
      }}
    >
      {label.isHead && (
        <span
          style={{
            fontSize: 8.5,
            fontWeight: 800,
            color: '#fff',
            background: color,
            padding: '0 4px',
            borderRadius: 3,
          }}
        >
          HEAD
        </span>
      )}
      <span className="mono" style={{ fontSize: 10.5, fontWeight: 600, color }}>
        {label.branch}
      </span>
      {label.onWorktree && <Icon name="branch" size={9} color={color} />}
    </span>
  );
}

/**
 * One branch in the rail. The row *is* the branch, so the whole row right-clicks
 * to the branch menu, and a chevron appears on hover/focus so the affordance is
 * visible and keyboard-reachable — the same pair the table row offers
 * (ADR-0028). Left-click stays inert: the menu is what the two views share,
 * not navigation.
 */
function RailBranchRow({ b, meta }: { b: GraphBranch; meta: BranchMeta | null }) {
  const { openAt, triggerProps } = useBranchMenu();
  const sr = meta?.selfReview ?? null;
  return (
    <div
      className="rail-row"
      onContextMenu={(e) => openAt(e, b.name)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 9px',
        margin: '1px 2px',
        borderRadius: 6,
        background: b.isHead ? 'var(--blue-tint)' : 'transparent',
        border: `1px solid ${b.isHead ? 'rgba(0,122,255,0.28)' : 'transparent'}`,
      }}
    >
      {b.isHead ? (
        <Icon name="check" size={11} color="var(--blue-press)" />
      ) : (
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            background: b.lane !== null ? laneColor(b.lane) : 'var(--gray-300)',
            flex: '0 0 7px',
          }}
        />
      )}
      <span
        className="mono"
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11.5,
          fontWeight: b.isHead ? 700 : 500,
          color: b.isHead ? 'var(--blue-press)' : 'var(--gray-800)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={b.name}
      >
        {b.name}
      </span>
      {meta?.debriefFreshness === 'new' && (
        <span
          title="Debrief · new"
          style={{
            width: 5,
            height: 5,
            borderRadius: 3,
            background: 'var(--purple)',
            flex: '0 0 5px',
          }}
        />
      )}
      {selfReviewStarted(sr) && sr && (
        /* Notes with nothing viewed still count as started —
                           the rail shows a comment glyph rather than "0/N". */
        <span
          title={
            sr.viewed > 0
              ? `Self-review in progress · ${sr.viewed}/${sr.total}`
              : `Self-review started · ${sr.notes} note${sr.notes === 1 ? '' : 's'}`
          }
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            fontSize: 9.5,
            fontWeight: 700,
            color: 'var(--blue-press)',
          }}
        >
          {sr.viewed > 0 ? (
            `${sr.viewed}/${sr.total}`
          ) : (
            <Icon name="comment-fill" size={9} color="var(--blue)" />
          )}
        </span>
      )}
      {b.onWorktree && (
        <Icon name="folder" size={11} color={b.isHead ? 'var(--blue-press)' : 'var(--gray-500)'} />
      )}

      {/* Overlays the pills rather than reserving width — the rail is 248px
                          and the pills were there first. Opaque (`.btn`) so it masks them. */}
      <button
        type="button"
        className="btn rail-row-menu"
        {...triggerProps(b.name)}
        style={{
          position: 'absolute',
          right: 4,
          top: '50%',
          transform: 'translateY(-50%)',
          height: 20,
          padding: '0 5px',
        }}
      >
        <Icon name="chevron-down" size={10} color="var(--gray-500)" />
      </button>
    </div>
  );
}

type RailGroup = { label: string; onWorktree: boolean };
const RAIL_GROUPS: RailGroup[] = [
  { label: 'Worktrees', onWorktree: true },
  { label: 'Branches', onWorktree: false },
];

export function BranchGraph({
  rows,
  refreshKey,
}: {
  /** Overview rows with `branchMeta` — the rail's pill source. */
  rows: OverviewRow[];
  /** Bump to recompute (the overview bumps it on `sync-updated`). */
  refreshKey: string | number;
}) {
  const [graph, setGraph] = useState<BranchGraphView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, toggleCollapsed] = useRailCollapsed(COLLAPSED_KEY);
  const [filter, setFilter] = useState('');
  const [selectedSha, setSelectedSha] = useState<string | null>(null);

  const load = useCallback(() => {
    branchGraph()
      .then((g) => {
        setGraph(g);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);
  // Runs on mount and whenever refreshKey changes (sync-updated events).
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger, not an input.
  useEffect(() => {
    load();
  }, [refreshKey, load]);

  const metaByBranch = useMemo(() => {
    const m = new Map<string, OverviewRow>();
    for (const r of rows) if (r.branchMeta) m.set(r.branch, r);
    return m;
  }, [rows]);

  const maxLane = useMemo(
    () =>
      graph ? Math.max(0, ...graph.rows.flatMap((r) => [r.lane, ...r.through, ...r.forks])) : 0,
    [graph],
  );
  const graphW = INSET + (maxLane + 1) * LANE_W + 10;

  const q = filter.trim().toLowerCase();
  const railBranches = (graph?.branches ?? []).filter(
    (b) => !q || b.name.toLowerCase().includes(q),
  );

  const selected = graph?.rows.find((r) => r.sha === selectedSha) ?? null;
  const footerBranch =
    (selected?.labels.find((l) => l.branch)?.branch ?? null) || graph?.head.branch || null;
  const footerLane =
    graph?.branches.find((b) => b.name === footerBranch)?.lane ?? selected?.lane ?? 0;

  const worktreeCount = (graph?.branches ?? []).filter((b) => b.onWorktree).length;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        background: '#fff',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r-lg)',
        overflow: 'hidden',
        boxShadow: 'var(--sh-1)',
      }}
    >
      {/* ── Branch rail — the shared collapsible pattern (L7 M2) ── */}
      <CollapsibleRail
        side="left"
        label="Local branches"
        count={graph?.branches.length ?? 0}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        width={248}
        collapsedContent={
          <>
            <RailStripStat icon="branch" n={graph?.branches.length ?? 0} title="Local branches" />
            <RailStripStat icon="folder" n={worktreeCount} title="Worktrees" />
          </>
        }
      >
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>
          <div style={{ position: 'relative', padding: '0 4px 8px' }}>
            <div
              style={{
                position: 'absolute',
                left: 11,
                top: 7,
                color: 'var(--gray-400)',
                display: 'flex',
              }}
            >
              <Icon name="search" size={11} />
            </div>
            <input
              className="input"
              placeholder="Filter branches…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ paddingLeft: 27, height: 26, fontSize: 12 }}
            />
          </div>
          {RAIL_GROUPS.map((group) => {
            const branches = railBranches.filter((b) => b.onWorktree === group.onWorktree);
            if (branches.length === 0) return null;
            return (
              <div key={group.label} style={{ marginBottom: 10 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '4px 8px 3px',
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 0.6,
                      textTransform: 'uppercase',
                      color: 'var(--gray-500)',
                    }}
                  >
                    {group.label}
                  </span>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--gray-400)' }}>
                    {branches.length}
                  </span>
                </div>
                {branches.map((b) => (
                  <RailBranchRow
                    key={b.name}
                    b={b}
                    meta={metaByBranch.get(b.name)?.branchMeta ?? null}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </CollapsibleRail>

      {/* ── Graph + commit table ───────────────────────────────── */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {error && <ErrorBanner title="Couldn't build the branch graph" detail={error} />}
        <div
          style={{
            display: 'flex',
            height: 30,
            flex: '0 0 30px',
            alignItems: 'center',
            borderBottom: '1px solid var(--hairline)',
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--gray-400)',
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            background: 'var(--gray-50)',
          }}
        >
          <div style={{ width: graphW, flex: `0 0 ${graphW}px`, padding: `0 ${INSET}px` }}>
            Graph
          </div>
          <div style={{ flex: 1, padding: '0 8px' }}>Commit</div>
          <div style={{ width: 118, flex: '0 0 118px', padding: '0 8px' }}>Author</div>
          <div style={{ width: 72, flex: '0 0 72px', padding: '0 8px' }}>SHA</div>
          <div style={{ width: 82, flex: '0 0 82px', padding: '0 14px 0 8px', textAlign: 'right' }}>
            When
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {(graph?.rows ?? []).map((row) => (
            <button
              key={row.sha}
              type="button"
              onClick={() => setSelectedSha(row.sha)}
              style={{
                display: 'flex',
                alignItems: 'stretch',
                width: '100%',
                height: ROW_H,
                background: row.sha === selectedSha ? 'var(--blue-tint-2)' : 'transparent',
                border: 'none',
                borderBottom: '1px solid var(--hairline-2)',
                padding: 0,
                font: 'inherit',
                textAlign: 'left',
                cursor: 'default',
              }}
            >
              <RowSvg row={row} width={graphW} />
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '0 8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 12.5,
                  color: row.isMerge ? 'var(--gray-600)' : 'var(--gray-800)',
                  fontStyle: row.isMerge ? 'italic' : 'normal',
                }}
              >
                {row.labels.map((l) => (
                  <LabelChip key={l.branch} label={l} lane={row.lane} />
                ))}
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontWeight: row.labels.some((l) => l.isHead) ? 600 : 500,
                  }}
                  title={row.subject}
                >
                  {row.subject}
                </span>
              </div>
              <div
                style={{
                  width: 118,
                  flex: '0 0 118px',
                  padding: '0 8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Avatar name={row.author} size="sm" />
                <span
                  style={{
                    fontSize: 11.5,
                    color: 'var(--gray-700)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row.author}
                </span>
              </div>
              <div
                style={{
                  width: 72,
                  flex: '0 0 72px',
                  padding: '0 8px',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <span className="mono" style={{ fontSize: 11, color: 'var(--gray-500)' }}>
                  {row.shortSha}
                </span>
              </div>
              <div
                style={{
                  width: 82,
                  flex: '0 0 82px',
                  padding: '0 14px 0 8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                }}
              >
                <span style={{ fontSize: 11, color: 'var(--gray-500)' }}>
                  {relativeTimeFromEpoch(row.authoredAt)}
                </span>
              </div>
            </button>
          ))}
        </div>

        {/* Footer status line — derived or absent, never faked. */}
        <div
          style={{
            flex: '0 0 30px',
            padding: '0 16px',
            background: 'var(--gray-50)',
            borderTop: '1px solid var(--hairline)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 11,
            color: 'var(--gray-600)',
          }}
        >
          {footerBranch && (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Icon name="branch" size={10} color={laneColor(footerLane)} />
                <span className="mono">{footerBranch}</span>
              </span>
              {graph?.head.branch === footerBranch &&
                graph.head.ahead !== null &&
                graph.head.behind !== null && (
                  <>
                    <span style={{ color: 'var(--gray-300)' }}>·</span>
                    <span>
                      {graph.head.ahead} ahead, {graph.head.behind} behind upstream
                    </span>
                  </>
                )}
              {graph?.head.branch === footerBranch &&
                graph.head.uncommittedCount !== null &&
                graph.head.uncommittedCount > 0 && (
                  <>
                    <span style={{ color: 'var(--gray-300)' }}>·</span>
                    <span style={{ color: 'var(--orange)', fontWeight: 500 }}>
                      {graph.head.uncommittedCount} uncommitted
                    </span>
                  </>
                )}
            </>
          )}
          <div style={{ flex: 1 }} />
          {graph && (
            <span>
              {graph.truncated
                ? `latest ${graph.rows.length} commits — older history not shown`
                : `${graph.rows.length} commits`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
