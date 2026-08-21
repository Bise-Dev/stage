import { Dropdown } from '../../components/Dropdown';
import { Icon } from '../../components/Icon';
import type { BaseOptions, BranchInfo } from '../../tauri';
import { relativeTimeFromEpoch } from '../../time';

/**
 * Top bar of the review shell's Self-Review mode.
 *
 * v6-light L5 (flags F3/F4): the old `workdir | base` scope seg is gone — the
 * committed-vs-base diff is always the reviewable unit, and "+ Uncommitted"
 * folds the working tree in as a separate section. "Mark reviewed" is the
 * mode's primary (explicit, SHA-bound; a later commit withdraws it
 * engine-side). "Ready to share" stays (flag F5 — no feature removal).
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
  doneAt,
  onToggleDone,
  onExit,
  onBaseChange,
  onRefreshBase,
  fetching,
  onCopyAsMarkdown,
  onReadyToShare,
  copyState,
}: {
  branch: string;
  /** Committed-section stats (the reviewable unit). */
  fileCount: number;
  added: number;
  removed: number;
  /** True once the committed diff has resolved (gates the action buttons). */
  ready: boolean;
  defaultBranch: string | null;
  /** The author-chosen base ref the committed diff compares against. */
  baseRef: string | null;
  /** Resolved base options (recommended ref, behind-count, last fetch). */
  baseOptions: BaseOptions | null;
  /** Local branches backing the base picker. */
  branches: BranchInfo[];
  viewedCount: number;
  /** Whether the working tree folds in as a separate section (flag F4). */
  includeUncommitted: boolean;
  /** Workdir-diff file count for the toggle badge; null until known. */
  uncommittedCount: number | null;
  onToggleUncommitted: (on: boolean) => void;
  /** "Mark reviewed" state (flag F3): epoch seconds while valid, else null. */
  doneAt: number | null;
  onToggleDone: () => void;
  onExit: () => void;
  onBaseChange: (base: string) => void;
  /** Fetch the remote and re-resolve the base options. */
  onRefreshBase: () => void;
  fetching: boolean;
  onCopyAsMarkdown: () => void;
  onReadyToShare: () => void;
  copyState: 'idle' | 'copied' | 'error';
}) {
  const base = baseRef ?? defaultBranch ?? 'main';

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
      <button
        type="button"
        className="btn btn-ghost"
        onClick={onExit}
        title="Back to Reviews — Esc"
        style={{ padding: '0 8px' }}
      >
        <Icon name="chevron-right" size={12} color="var(--gray-500)" />
        <span style={{ marginLeft: 4 }}>Reviews</span>
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

      {/* "+ Uncommitted" — fold the working tree in as a separate section. */}
      <button
        type="button"
        className="btn"
        onClick={() => onToggleUncommitted(!includeUncommitted)}
        title={
          includeUncommitted
            ? 'Hide the working-tree section'
            : 'Show uncommitted changes as a separate section'
        }
        style={
          includeUncommitted
            ? {
                background: 'rgba(255,149,0,0.10)',
                borderColor: 'rgba(255,149,0,0.28)',
                color: '#b56500',
              }
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
      <button
        type="button"
        className="btn"
        onClick={onReadyToShare}
        title="Mark ready to share and start composing the storyline"
      >
        <Icon name="gh" size={12} /> Ready to share
      </button>
      {/* "Mark reviewed" (flag F3): explicit, allowed anytime, SHA-bound —
          clicking again withdraws it. */}
      <button
        type="button"
        className={doneAt !== null ? 'btn' : 'btn btn-primary'}
        onClick={onToggleDone}
        disabled={!ready}
        title={
          doneAt !== null
            ? 'Reviewed at this commit — click to withdraw'
            : 'Mark this branch self-reviewed at its current head'
        }
        style={
          doneAt !== null
            ? { background: 'rgba(52,199,89,0.14)', color: 'var(--green-d)', opacity: 1 }
            : { opacity: ready ? 1 : 0.6 }
        }
      >
        <Icon name="check" size={12} color={doneAt !== null ? 'var(--green-d)' : '#fff'} />{' '}
        {doneAt !== null ? 'Reviewed' : 'Mark reviewed'}
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
        className="btn btn-ghost"
        onClick={onRefreshBase}
        disabled={fetching}
        style={{ padding: '0 6px', opacity: fetching ? 0.5 : 1 }}
        title="git fetch --prune"
      >
        {fetching ? 'Refreshing…' : 'Refresh'}
      </button>
    </span>
  );
}
