import { Icon } from '../../components/Icon';
import type { SelfReviewDiff, SelfReviewScope } from '../../tauri';

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
  viewedCount,
  onExit,
  onScopeChange,
  onCopyAsMarkdown,
  onReadyToShare,
  copyState,
}: {
  diff: SelfReviewDiff | null;
  scope: SelfReviewScope;
  defaultBranch: string | null;
  viewedCount: number;
  onExit: () => void;
  onScopeChange: (s: SelfReviewScope) => void;
  onCopyAsMarkdown: () => void;
  onReadyToShare: () => void;
  copyState: 'idle' | 'copied' | 'error';
}) {
  const branch = diff?.currentBranch ?? '…';
  const base = defaultBranch ?? 'main';
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
            <span className="badge mono" style={{ background: 'rgba(0,0,0,0.06)' }}>
              {base}
            </span>
            <Icon name="arrow-right" size={11} color="var(--gray-400)" />
            <span
              className="badge mono"
              style={{ background: 'var(--blue-tint)', color: 'var(--blue-press)' }}
            >
              {branch}
            </span>
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
          style={segBtnStyle(scope === 'workdir')}
        >
          Working tree
        </button>
        <button
          type="button"
          onClick={() => onScopeChange('base')}
          className={scope === 'base' ? 'active' : undefined}
          style={segBtnStyle(scope === 'base')}
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

function segBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '0 10px',
    height: 20,
    borderRadius: 5,
    background: active ? '#fff' : 'transparent',
    color: active ? 'var(--gray-900)' : 'var(--gray-700)',
    border: 'none',
    fontFamily: 'inherit',
    fontSize: 12,
    fontWeight: 500,
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.04)' : 'none',
    cursor: 'default',
  };
}
