import { Fragment } from 'react';
import { Icon } from '../../components/Icon';
import type { SelfReviewFileChange } from '../../tauri';

const STATUS_BADGE: Record<SelfReviewFileChange['status'], { ch: string; color: string }> = {
  added: { ch: 'A', color: 'var(--green-d)' },
  modified: { ch: 'M', color: '#a08000' },
  deleted: { ch: 'D', color: 'var(--red-d)' },
  renamed: { ch: 'R', color: 'var(--purple)' },
};

/** Section-qualified row id: the committed and uncommitted sections can hold
 *  the same path, so selection/scroll targets carry their section. */
export const committedId = (path: string) => `c:${path}`;
export const uncommittedId = (path: string) => `u:${path}`;

/**
 * Left sidebar of the review shell's Self-Review mode. Flat list (no tree
 * toggle for v1, per Q13). Cmd-F binds to the filter input from the parent.
 *
 * Three groups (v6-light L5):
 *  - unviewed committed files — full rows, "Other files" divider when a
 *    Debrief orders the top of the list;
 *  - viewed committed files — compacted into a dim "Seen" group at the bottom
 *    (design `V6_FileList`), each still toggleable back;
 *  - the uncommitted section (flag F4) — present only when the author folds
 *    the working tree in; separate label, no viewed checkboxes (working-tree
 *    edits are too volatile to meaningfully "mark seen").
 */
export function FileList({
  files,
  uncommittedFiles,
  debriefPaths,
  filter,
  setFilter,
  filterRef,
  selectedId,
  onSelect,
  viewed,
  onToggleViewed,
  onClearViewed,
  noteCounts,
  width,
}: {
  /** The committed section's files. */
  files: SelfReviewFileChange[];
  /** The uncommitted section's files; null/empty when the section is off. */
  uncommittedFiles: SelfReviewFileChange[] | null;
  /** Paths the Debrief narrates (empty when there's no Debrief). */
  debriefPaths: Set<string>;
  filter: string;
  setFilter: (s: string) => void;
  filterRef: React.RefObject<HTMLInputElement | null>;
  /** Section-qualified id (see `committedId`/`uncommittedId`). */
  selectedId: string | null;
  onSelect: (id: string) => void;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
  onClearViewed: () => void;
  noteCounts: Map<string, number>;
  /** Author-resizable column width (px); see `useColumnWidth`. */
  width: number;
}) {
  const q = filter.trim().toLowerCase();
  const match = (f: SelfReviewFileChange) =>
    !q || f.path.toLowerCase().includes(q) || f.patch?.toLowerCase().includes(q);

  const filtered = files.filter(match);
  const unseen = filtered.filter((f) => !viewed.has(f.path));
  const seen = filtered.filter((f) => viewed.has(f.path));
  const filteredUncommitted = (uncommittedFiles ?? []).filter(match);

  // Index of the first non-narrated file among the unseen rows. The divider
  // only shows when at least one narrated file sits above it.
  const otherStartIdx =
    debriefPaths.size === 0 ? -1 : unseen.findIndex((f) => !debriefPaths.has(f.path));
  const showOtherLabel = otherStartIdx > 0;

  const empty = filtered.length === 0 && filteredUncommitted.length === 0;

  return (
    <div
      style={{
        width,
        flex: `0 0 ${width}px`,
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
        {empty && (
          <div
            style={{
              padding: '10px 12px',
              fontSize: 11.5,
              color: 'var(--gray-500)',
            }}
          >
            {files.length === 0 && (uncommittedFiles?.length ?? 0) === 0
              ? 'No changes.'
              : 'No files match the filter.'}
          </div>
        )}
        {unseen.map((f, i) => (
          <Fragment key={f.path}>
            {showOtherLabel && i === otherStartIdx && (
              <div
                className="section-label"
                style={{ padding: '12px 8px 4px', color: 'var(--gray-500)' }}
              >
                Other files
              </div>
            )}
            <FileRow
              file={f}
              active={committedId(f.path) === selectedId}
              isViewed={false}
              noteCount={noteCounts.get(f.path) ?? 0}
              onSelect={() => onSelect(committedId(f.path))}
              onToggleViewed={() => onToggleViewed(f.path)}
            />
          </Fragment>
        ))}

        {/* Seen — viewed files compact into a dim single-line group (design
            `V6_FileList`); the checkbox still toggles them back to full rows. */}
        {seen.length > 0 && (
          <>
            <div
              className="section-label"
              style={{
                padding: '12px 8px 4px',
                color: 'var(--gray-400)',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Icon name="check" size={10} color="var(--gray-400)" /> Seen · {seen.length}
            </div>
            {seen.map((f) => (
              <SeenRow
                key={f.path}
                file={f}
                active={committedId(f.path) === selectedId}
                noteCount={noteCounts.get(f.path) ?? 0}
                onSelect={() => onSelect(committedId(f.path))}
                onToggleViewed={() => onToggleViewed(f.path)}
              />
            ))}
          </>
        )}

        {/* Uncommitted — the separate working-tree section (flag F4). */}
        {uncommittedFiles !== null && (
          <>
            <div
              className="section-label"
              style={{ padding: '12px 8px 4px', color: 'var(--orange)' }}
            >
              Uncommitted · {filteredUncommitted.length}
            </div>
            {filteredUncommitted.length === 0 && (
              <div style={{ padding: '2px 12px 8px', fontSize: 11, color: 'var(--gray-500)' }}>
                Working tree is clean.
              </div>
            )}
            {filteredUncommitted.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                active={uncommittedId(f.path) === selectedId}
                isViewed={false}
                hideViewed
                noteCount={0}
                onSelect={() => onSelect(uncommittedId(f.path))}
                onToggleViewed={() => {}}
              />
            ))}
          </>
        )}
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

/** Compact one-line row for a viewed file: dim, struck through, checkbox on
 *  the left to un-view (mirrors the design's seen group). */
function SeenRow({
  file,
  active,
  noteCount,
  onSelect,
  onToggleViewed,
}: {
  file: SelfReviewFileChange;
  active: boolean;
  noteCount: number;
  onSelect: () => void;
  onToggleViewed: () => void;
}) {
  const badge = STATUS_BADGE[file.status];
  const name = file.path.split('/').pop() ?? file.path;
  return (
    <button
      type="button"
      onClick={onSelect}
      title={file.path}
      style={{
        width: '100%',
        textAlign: 'left',
        border: 'none',
        cursor: 'default',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 8px',
        borderRadius: 5,
        margin: '1px 0',
        background: active ? 'rgba(0,122,255,0.10)' : 'transparent',
        opacity: 0.55,
        fontFamily: 'inherit',
      }}
    >
      <ViewedCheckbox isViewed onToggle={onToggleViewed} />
      <span
        style={{
          width: 5,
          height: 5,
          flex: '0 0 5px',
          borderRadius: 3,
          background: badge.color,
        }}
      />
      <span
        className="mono"
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11.5,
          color: 'var(--gray-500)',
          textDecoration: 'line-through',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
      {noteCount > 0 && <Icon name="comment-fill" size={9} color="var(--gray-400)" />}
    </button>
  );
}

function FileRow({
  file,
  active,
  isViewed,
  hideViewed,
  noteCount,
  onSelect,
  onToggleViewed,
}: {
  file: SelfReviewFileChange;
  active: boolean;
  isViewed: boolean;
  /** Uncommitted-section rows carry no viewed checkbox (flag F4). */
  hideViewed?: boolean;
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
      {!hideViewed && <ViewedCheckbox isViewed={isViewed} onToggle={onToggleViewed} />}
    </button>
  );
}

function ViewedCheckbox({ isViewed, onToggle }: { isViewed: boolean; onToggle: () => void }) {
  return (
    <span
      // biome-ignore lint/a11y/useSemanticElements: nested inside the row <button>; an <input type=checkbox> would clash with the row click target and inherit default OS styling we don't want.
      role="checkbox"
      aria-checked={isViewed}
      aria-label="Mark viewed"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
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
  );
}
