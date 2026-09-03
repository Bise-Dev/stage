import { Dropdown } from '../../components/Dropdown';
import { Icon } from '../../components/Icon';
import type { BaseOptions, BranchInfo } from '../../tauri';
import { relativeTimeFromEpoch } from '../../time';

/**
 * Top bar of the review shell's Self-Review mode.
 *
 * v6-light L7 (§3b M4–M6/M8): the committed-vs-base diff is the reviewable
 * unit, and "+ Uncommitted" widens it to include the working tree — one merged
 * diff, not a second section (ADR-0030) — greyed out when there is nothing to
 * fold in. The composer's single entry point is the Overview's "New review" button (M4),
 * and "Mark reviewed" is gone (M5, F3 rescinded). Since L9 (§3c N3) the
 * general-notes popover mounts here via `notesControl`.
 */
export function Subheader({
  branch,
  fileCount,
  added,
  removed,
  ready,
  defaultBranch,
  baseRef,
  baseOptions,
  branches,
  viewedCount,
  includeUncommitted,
  uncommittedCount,
  onToggleUncommitted,
  onExit,
  onBaseChange,
  onRefreshBase,
  fetching,
  onCopyAsMarkdown,
  copyState,
  notesControl,
}: {
  branch: string;
  /** Stats for the diff on screen, in the current scope. */
  fileCount: number;
  added: number;
  removed: number;
  /** True once the committed diff has resolved (gates the action buttons). */
  ready: boolean;
  defaultBranch: string | null;
  /** The author-chosen base ref the diff compares against. */
  baseRef: string | null;
  /** Resolved base options (recommended ref, behind-count, last fetch). */
  baseOptions: BaseOptions | null;
  /** Local branches backing the base picker. */
  branches: BranchInfo[];
  viewedCount: number;
  /** Whether the working tree is folded into the diff (ADR-0030). */
  includeUncommitted: boolean;
  /** Workdir-diff file count for the toggle badge; null until known. */
  uncommittedCount: number | null;
  onToggleUncommitted: (on: boolean) => void;
  onExit: () => void;
  onBaseChange: (base: string) => void;
  /** Fetch the remote and re-resolve the base options. */
  onRefreshBase: () => void;
  fetching: boolean;
  onCopyAsMarkdown: () => void;
  copyState: 'idle' | 'copied' | 'error';
  /** The general-notes popover (L9 §3c N3), composed by the mode body. */
  notesControl?: React.ReactNode;
}) {
  const base = baseRef ?? defaultBranch ?? 'main';
  // M6: nothing to fold in — the toggle is inert unless it's already on (then
  // the author can still turn the empty section off).
  const uncommittedInert = (uncommittedCount ?? 0) === 0 && !includeUncommitted;

  return (
    <div
      style={{
        height: 56,
        flex: '0 0 56px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 16px',
        background: '#fff',
        borderBottom: '1px solid var(--hairline)',
      }}
    >
      {/* M8: reads as back navigation — left-pointing chevron + destination. */}
      <button
        type="button"
        className="btn"
        onClick={onExit}
        title="Back to Reviews — Esc"
        style={{ padding: '0 10px 0 6px', gap: 3 }}
      >
        <Icon name="chevron-left" size={12} color="var(--gray-600)" />
        <span style={{ color: 'var(--gray-700)', fontWeight: 500 }}>Back</span>
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Dropdown
          mono
          ariaLabel="Comparison base branch"
          title="Branch to compare against"
          value={base}
          onChange={onBaseChange}
          style={{ maxWidth: 240 }}
          options={(() => {
            const opts: Array<{ value: string; label: string }> = [];
            const seen = new Set<string>();
            const push = (value: string, label: string) => {
              if (seen.has(value)) return;
              seen.add(value);
              opts.push({ value, label });
            };
            if (baseOptions?.remoteDefault) {
              push(baseOptions.remoteDefault, `${baseOptions.remoteDefault} (remote default)`);
            }
            push(base, base);
            for (const b of branches) push(b.name, b.name);
            return opts;
          })()}
        />
        <Icon name="arrow-right" size={11} color="var(--gray-400)" />
        <span
          className="badge mono"
          style={{ background: 'var(--blue-tint)', color: 'var(--blue-press)' }}
        >
          {branch}
        </span>
        <BaseFreshness
          baseOptions={baseOptions}
          base={base}
          fetching={fetching}
          onRefreshBase={onRefreshBase}
        />
      </div>

      {/* "+ Uncommitted" — widen the diff to the working tree (ADR-0030).
          Greyed out (M6) when there is no working tree / nothing uncommitted. */}
      <button
        type="button"
        className="btn"
        onClick={() => onToggleUncommitted(!includeUncommitted)}
        disabled={uncommittedInert}
        title={
          includeUncommitted
            ? 'Review the committed diff only'
            : uncommittedCount === null
              ? 'No working tree for this branch'
              : uncommittedCount === 0
                ? 'Nothing uncommitted in the working tree'
                : 'Fold uncommitted changes into the diff'
        }
        style={
          includeUncommitted
            ? {
                background: 'rgba(255,149,0,0.10)',
                borderColor: 'rgba(255,149,0,0.28)',
                color: '#b56500',
              }
            : uncommittedInert
              ? { opacity: 0.45 }
              : undefined
        }
      >
        {includeUncommitted ? '−' : '+'} Uncommitted
        {uncommittedCount !== null && uncommittedCount > 0 && (
          <span className="badge badge-orange" style={{ marginLeft: 6 }}>
            {uncommittedCount}
          </span>
        )}
      </button>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 1 }}>
          {fileCount} file{fileCount === 1 ? '' : 's'} ·{' '}
          <span style={{ color: 'var(--green-d)' }}>+{added}</span>{' '}
          <span style={{ color: 'var(--red-d)' }}>−{removed}</span>
          {fileCount > 0 && (
            <>
              {' '}
              · {viewedCount} of {fileCount} viewed
            </>
          )}
        </div>
      </div>

      {notesControl}

      <button
        type="button"
        className="btn"
        onClick={onCopyAsMarkdown}
        disabled={!ready}
        style={{ opacity: ready ? 1 : 0.5 }}
      >
        <Icon name="doc-stack" size={12} />{' '}
        {copyState === 'copied'
          ? 'Copied!'
          : copyState === 'error'
            ? 'Copy failed'
            : 'Copy as markdown'}
      </button>
    </div>
  );
}

/** Shows "N behind origin" when the selected base is a stale local default, plus
 *  the last-fetch time and a Refresh (fetch) button. */
function BaseFreshness({
  baseOptions,
  base,
  fetching,
  onRefreshBase,
}: {
  baseOptions: BaseOptions | null;
  base: string;
  fetching: boolean;
  onRefreshBase: () => void;
}) {
  if (!baseOptions) return null;
  const ld = baseOptions.localDefault;
  // Warn only when the author picked the LOCAL default and it trails the remote.
  const behindWarning =
    ld && base === ld.name && ld.behind > 0 ? `${ld.behind} behind origin` : null;
  const fetched = baseOptions.lastFetchSecs
    ? `fetched ${relativeTimeFromEpoch(baseOptions.lastFetchSecs)}`
    : 'never fetched';
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
      {behindWarning && <span style={{ color: 'var(--orange)' }}>{behindWarning}</span>}
      <span style={{ color: 'var(--gray-500)' }}>{fetched}</span>
      <button
        type="button"
        className="btn"
        onClick={onRefreshBase}
        disabled={fetching}
        style={{ opacity: fetching ? 0.5 : 1 }}
        title="git fetch --prune"
      >
        {fetching ? 'Refreshing…' : 'Refresh'}
      </button>
    </span>
  );
}
