import { Icon } from '../../components/Icon';
import type { SelfReviewFileChange } from '../../tauri';

const STATUS_BADGE: Record<SelfReviewFileChange['status'], { ch: string; color: string }> = {
  added: { ch: 'A', color: 'var(--green-d)' },
  modified: { ch: 'M', color: '#a08000' },
  deleted: { ch: 'D', color: 'var(--red-d)' },
  renamed: { ch: 'R', color: 'var(--purple)' },
};

/**
 * Left sidebar of the Self-Review screen. Flat list (no tree toggle for v1,
 * per Q13). Cmd-F binds to the filter input from the parent. "Mark viewed"
 * lives in each row's right side; counts roll up to the subheader.
 */
export function FileList({
  files,
  filter,
  setFilter,
  filterRef,
  selectedPath,
  onSelect,
  viewed,
  onToggleViewed,
  onClearViewed,
  noteCounts,
}: {
  files: SelfReviewFileChange[];
  filter: string;
  setFilter: (s: string) => void;
  filterRef: React.RefObject<HTMLInputElement | null>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
  onClearViewed: () => void;
  noteCounts: Map<string, number>;
}) {
  const q = filter.trim().toLowerCase();
  const filtered = !q
    ? files
    : files.filter((f) => f.path.toLowerCase().includes(q) || f.patch?.toLowerCase().includes(q));

  return (
    <div
      style={{
        width: 260,
        flex: '0 0 260px',
        borderRight: '1px solid var(--hairline)',
        background: '#fbfaf8',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid var(--hairline-2)' }}>
        <input
          ref={filterRef}
          className="input"
          placeholder="Filter files…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setFilter('');
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px 4px',
        }}
      >
        <span className="section-label" style={{ padding: 0 }}>
          Files
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--gray-500)', fontWeight: 600 }}>
          {viewed.size}/{files.length} viewed
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 6px' }}>
        {filtered.length === 0 && (
          <div
            style={{
              padding: '10px 12px',
              fontSize: 11.5,
              color: 'var(--gray-500)',
            }}
          >
            {files.length === 0 ? 'No changes.' : 'No files match the filter.'}
          </div>
        )}
        {filtered.map((f) => (
          <FileRow
            key={f.path}
            file={f}
            active={f.path === selectedPath}
            isViewed={viewed.has(f.path)}
            noteCount={noteCounts.get(f.path) ?? 0}
            onSelect={() => onSelect(f.path)}
            onToggleViewed={() => onToggleViewed(f.path)}
          />
        ))}
      </div>
      {viewed.size > 0 && (
        <div
          style={{
            padding: '8px 12px',
            borderTop: '1px solid var(--hairline-2)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (window.confirm(`Clear ${viewed.size} viewed markers?`)) onClearViewed();
            }}
            style={{ color: 'var(--gray-600)', padding: 0, height: 18, fontSize: 11 }}
          >
            Clear viewed
          </button>
        </div>
      )}
    </div>
  );
}

function FileRow({
  file,
  active,
  isViewed,
  noteCount,
  onSelect,
  onToggleViewed,
}: {
  file: SelfReviewFileChange;
  active: boolean;
  isViewed: boolean;
  noteCount: number;
  onSelect: () => void;
  onToggleViewed: () => void;
}) {
  const badge = STATUS_BADGE[file.status];
  const parts = file.path.split('/');
  const name = parts.pop() ?? file.path;
  const dir = parts.join('/');

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        width: '100%',
        textAlign: 'left',
        border: 'none',
        cursor: 'default',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 8px',
        borderRadius: 5,
        margin: '1px 0',
        background: active ? 'rgba(0,122,255,0.10)' : 'transparent',
        color: active ? 'var(--blue-press)' : 'var(--gray-800)',
        fontFamily: 'inherit',
      }}
    >
      <span
        className="mono"
        style={{ fontSize: 10, fontWeight: 700, color: badge.color, width: 12, flex: '0 0 12px' }}
      >
        {badge.ch}
      </span>
      <div style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
        <div
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: active ? 600 : 500,
          }}
        >
          {name}
        </div>
        {dir && (
          <div
            style={{
              fontSize: 10.5,
              color: active ? 'rgba(0,98,204,0.6)' : 'var(--gray-500)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {dir}
          </div>
        )}
      </div>
      {noteCount > 0 && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            fontSize: 10.5,
            color: active ? 'var(--blue-press)' : 'var(--gray-500)',
          }}
          title={`${noteCount} Review note${noteCount === 1 ? '' : 's'}`}
        >
          <Icon
            name="comment-fill"
            size={10}
            color={active ? 'var(--blue-press)' : 'var(--gray-400)'}
          />
          {noteCount}
        </span>
      )}
      <span
        style={{
          fontSize: 10.5,
          color: active ? 'rgba(0,98,204,0.7)' : 'var(--gray-500)',
        }}
      >
        {file.additions > 0 && (
          <span style={{ color: active ? '#1f5fa8' : 'var(--green-d)' }}>+{file.additions}</span>
        )}
        {file.additions > 0 && file.deletions > 0 && ' '}
        {file.deletions > 0 && (
          <span style={{ color: active ? '#7a3530' : 'var(--red-d)' }}>−{file.deletions}</span>
        )}
      </span>
      <span
        // biome-ignore lint/a11y/useSemanticElements: nested inside the row <button>; an <input type=checkbox> would clash with the row click target and inherit default OS styling we don't want.
        role="checkbox"
        aria-checked={isViewed}
        aria-label="Mark viewed"
        onClick={(e) => {
          e.stopPropagation();
          onToggleViewed();
        }}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            onToggleViewed();
          }
        }}
        tabIndex={0}
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          border: '1px solid var(--gray-300)',
          background: isViewed ? 'var(--green-d)' : '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontSize: 10,
          flex: '0 0 14px',
          cursor: 'default',
        }}
      >
        {isViewed ? '✓' : ''}
      </span>
    </button>
  );
}
