import { Dropdown } from '../../components/Dropdown';
import { Icon } from '../../components/Icon';
import type { BaseOptions, BranchInfo, SelfReviewDiff, SelfReviewScope } from '../../tauri';

/**
 * Top bar of the Self-Review screen. Adapts to the scope toggle:
 *  - workdir mode: single `[branch] uncommitted` badge
 *  - base mode:    `[base] → [branch]` two-badge layout
 *
 * Layout matches the Stage v2 "Local review" subheader, with the Summarize
 * button removed and "Open PR…" rewritten as the (stubbed) "Ready to share"
 * action — see the grill session for the full mapping.
 */
export function Subheader({
  diff,
  scope,
  defaultBranch,
  baseRef,
  baseOptions,
  branches,
  viewedCount,
  onExit,
  onScopeChange,
  onBaseChange,
  onRefreshBase,
  fetching,
  onCopyAsMarkdown,
  onReadyToShare,
  copyState,
}: {
  diff: SelfReviewDiff | null;
  scope: SelfReviewScope;
  defaultBranch: string | null;
  /** The author-chosen base ref the `base`-scope diff compares against. */
  baseRef: string | null;
  /** Resolved base options (recommended ref, behind-count, last fetch). */
  baseOptions: BaseOptions | null;
  /** Local branches backing the base picker. */
  branches: BranchInfo[];
  viewedCount: number;
  onExit: () => void;
  onScopeChange: (s: SelfReviewScope) => void;
  onBaseChange: (base: string) => void;
  /** Fetch the remote and re-resolve the base options. */
  onRefreshBase: () => void;
  fetching: boolean;
  onCopyAsMarkdown: () => void;
  onReadyToShare: () => void;
  copyState: 'idle' | 'copied' | 'error';
}) {
  const branch = diff?.currentBranch ?? '…';
  const base = baseRef ?? defaultBranch ?? 'main';
  const fileCount = diff?.stats.filesChanged ?? 0;
  const added = diff?.stats.added ?? 0;
  const removed = diff?.stats.removed ?? 0;

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
        title="Back to Workspaces — Esc"
        style={{ padding: '0 8px' }}
      >
        <Icon name="chevron-right" size={12} color="var(--gray-500)" />
        <span style={{ marginLeft: 4 }}>Workspaces</span>
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {scope === 'base' ? (
          <>
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
          </>
        ) : (
          <>
            <span
              className="badge mono"
              style={{ background: 'var(--blue-tint)', color: 'var(--blue-press)' }}
            >
              {branch}
            </span>
            <span style={{ fontSize: 11, color: 'var(--gray-500)' }}>uncommitted</span>
          </>
        )}
      </div>

      <div className="seg" aria-label="Diff scope">
        <button
          type="button"
          onClick={() => onScopeChange('workdir')}
          className={scope === 'workdir' ? 'active' : undefined}
        >
          Working tree
        </button>
        <button
          type="button"
          onClick={() => onScopeChange('base')}
          className={scope === 'base' ? 'active' : undefined}
          disabled={!defaultBranch}
          title={defaultBranch ? undefined : 'No default branch detected for this repo'}
          style={!defaultBranch ? { opacity: 0.5 } : undefined}
        >
          vs {base}
        </button>
      </div>

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
        disabled={!diff}
        style={{ opacity: diff ? 1 : 0.5 }}
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
        className="btn btn-primary"
        onClick={onReadyToShare}
        title="Create a Workspace and start composing the storyline (coming soon)"
      >
        <Icon name="gh" size={12} color="#fff" /> Ready to share
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
    ? `fetched ${relTime(baseOptions.lastFetchSecs)}`
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

/** Compact relative time from epoch seconds (e.g. "2h ago"). */
function relTime(epochSecs: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSecs);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
