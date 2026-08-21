import { type ReactNode, useCallback, useState } from 'react';
import { Icon } from './Icon';

/**
 * The one rail pattern (v6-light L7, §3b M2): every side rail — the shell's
 * file list, the graph's branch rail, the Debrief rail — is the same chrome:
 * a header row (collapse chevron at the outer edge, uppercase label, count
 * badge), the rail body when expanded, and a narrow icon+count strip when
 * collapsed. Collapse is persisted per rail under `storageKey`.
 *
 * Purely presentational: the body (filter inputs, groups, cards) belongs to
 * the caller. Width is the caller's too (rails stay individually resizable);
 * the collapsed strip is a fixed 44px.
 */

export const RAIL_COLLAPSED_WIDTH = 44;

export function useRailCollapsed(storageKey: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(storageKey) === 'true');
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      localStorage.setItem(storageKey, String(!c));
      return !c;
    });
  }, [storageKey]);
  return [collapsed, toggle];
}

export function CollapsibleRail({
  side,
  label,
  count,
  collapsed,
  onToggle,
  width,
  headerExtra,
  collapsedContent,
  children,
}: {
  /** Which edge the rail sits on; the border and chevrons mirror. */
  side: 'left' | 'right';
  /** Uppercase header label ("Files", "Local branches", "Agent Debrief"). */
  label: string;
  /** Count badge next to the label; omit with null. */
  count: number | null;
  collapsed: boolean;
  onToggle: () => void;
  /** Expanded width (px) — caller-owned so rails stay resizable. */
  width: number;
  /** Extra badges/controls after the label (expanded header only). */
  headerExtra?: ReactNode;
  /** The icon+count strip shown while collapsed. */
  collapsedContent: ReactNode;
  children: ReactNode;
}) {
  const w = collapsed ? RAIL_COLLAPSED_WIDTH : width;
  // The chevron points where clicking takes you: outward to collapse,
  // inward to expand — mirrored on a right-side rail.
  const chevron: 'chevron-left' | 'chevron-right' = collapsed
    ? side === 'left'
      ? 'chevron-right'
      : 'chevron-left'
    : side === 'left'
      ? 'chevron-left'
      : 'chevron-right';

  const toggleButton = (
    <button
      type="button"
      className="btn"
      onClick={onToggle}
      title={collapsed ? `Expand ${label.toLowerCase()}` : `Collapse ${label.toLowerCase()}`}
      style={{ height: 22, width: 22, padding: 0, justifyContent: 'center', flex: '0 0 22px' }}
    >
      <Icon name={chevron} size={11} color="var(--gray-600)" />
    </button>
  );

  return (
    <div
      style={{
        width: w,
        flex: `0 0 ${w}px`,
        [side === 'left' ? 'borderRight' : 'borderLeft']: '1px solid var(--hairline)',
        background: '#fbfaf8',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
        transition: 'flex-basis .2s',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 30,
          flex: '0 0 30px',
          padding: '0 10px',
          borderBottom: '1px solid var(--hairline)',
          flexDirection: side === 'left' ? 'row' : 'row-reverse',
        }}
      >
        {toggleButton}
        {!collapsed && (
          <>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: 'var(--gray-400)',
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </span>
            {headerExtra}
            <div style={{ flex: 1 }} />
            {count !== null && <span className="badge">{count}</span>}
          </>
        )}
      </div>
      {collapsed ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 14,
            padding: '14px 0',
          }}
        >
          {collapsedContent}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

/** One icon+count cell of the collapsed strip. */
export function RailStripStat({
  icon,
  n,
  title,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  n: number;
  title: string;
}) {
  return (
    <div
      title={title}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
    >
      <Icon name={icon} size={14} color="var(--gray-600)" />
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: n ? 'var(--gray-700)' : 'var(--gray-300)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {n}
      </span>
    </div>
  );
}
