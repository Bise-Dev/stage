import { Dropdown } from '../../components/Dropdown';
import { Icon } from '../../components/Icon';
import type { BaseOptions, BranchInfo, SelfReviewDiff, SelfReviewScope } from '../../tauri';
import { relativeTimeFromEpoch } from '../../time';

/**
 * Top bar of the Self-Review screen. Adapts to the scope toggle:
 *  - workdir mode: single `[branch] uncommitted` badge
 *  - base mode:    `[base] → [branch]` two-badge layout
 *
 * Layout matches the Stage v2 "Local review" subheader, with the Summarize
 * button removed and "Open PR…" rewritten as the "Ready to share" action
 * (WS-2 #60) — it creates the draft Review and jumps into the composer.
 */
export function Subheader({
  diff,
  scope,
  uncommittedCount,
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
  /** Uncommitted (workdir-scope) file count for the toggle badge; null until known. */
  uncommittedCount: number | null;
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
        title="Back to Reviews — Esc"
        style={{ padding: '0 8px' }}
      >
        <Icon name="chevron-right" size={12} color="var(--gray-500)" />
        <span style={{ marginLeft: 4 }}>Reviews</span>
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
          {/* Green when the tree is clean, amber + a file count when there are
              uncommitted changes. `null` (not yet resolved) keeps the default. */}
          <span
            style={
              uncommittedCount === null
                ? undefined
                : { color: uncommittedCount > 0 ? 'var(--orange)' : 'var(--green-d)' }
            }
          >
            Uncommitted
          </span>
          {uncommittedCount !== null && uncommittedCount > 0 && (
            <span className="badge badge-orange" style={{ marginLeft: 6 }}>
              {uncommittedCount}
            </span>
          )}
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
        title="Mark ready to share and start composing the storyline"
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
