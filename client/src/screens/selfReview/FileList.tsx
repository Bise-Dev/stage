import { Fragment } from 'react';
import { CollapsibleRail, RailStripStat } from '../../components/CollapsibleRail';
import { Icon } from '../../components/Icon';
import type { SelfReviewFileChange } from '../../tauri';

const STATUS_BADGE: Record<SelfReviewFileChange['status'], { ch: string; color: string }> = {
  added: { ch: 'A', color: 'var(--green-d)' },
  modified: { ch: 'M', color: '#a08000' },
  deleted: { ch: 'D', color: 'var(--red-d)' },
  renamed: { ch: 'R', color: 'var(--purple)' },
};

/** A Debrief chapter's presence in the file list: title + the paths it
 *  narrates, in chapter order (title only — the intro lives in the center
 *  `ChapterBanner`, v6-light L9 §3c N1). */
export type FileListChapter = { title: string; files: string[] };

/**
 * Left sidebar of the review shell's Self-Review mode. Flat list (no tree
 * toggle for v1, per Q13). Cmd-F binds to the filter input from the parent.
 * The filter matches on the file *path* only (v6-light L7, §3b M7) — patch
 * content deliberately doesn't match, a filename query must not surface
 * unrelated files whose diff happens to contain it.
 *
 * Rendered inside the shared `CollapsibleRail` (M2). When a Debrief exists,
 * files group under **chapter title headers** (L9 §3c N1) with a trailing
 * "Other files" group for unnarrated ones; no Debrief → one flat group.
 * Within each group, viewed files compact into dim struck-through rows at the
 * group's bottom (design `V6_FileList`, per-group since L9). While a filter
 * query is active, only groups containing matches render.
 *
 * There is exactly **one list**: folding the working tree in widens the diff
 * the parent hands down, it doesn't append a second section (ADR-0030), so a
 * file the author committed to and has since edited appears once.
 */
export function FileList({
  files,
  chapters,
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
  collapsed,
  onToggleCollapsed,
}: {
  /** Every file in the reviewable diff, in presentation order. */
  files: SelfReviewFileChange[];
  /** The Debrief's chapters (title + narrated paths); empty when no Debrief. */
  chapters: FileListChapter[];
  filter: string;
  setFilter: (s: string) => void;
  filterRef: React.RefObject<HTMLInputElement | null>;
  /** Path of the selected file. */
  selectedId: string | null;
  onSelect: (path: string) => void;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
  onClearViewed: () => void;
  /** Anchored-note count per file path. */
  noteCounts: Map<string, number>;
  /** Author-resizable column width (px); see `useColumnWidth`. */
  width: number;
  /** Rail collapse (M2) — owned by the parent so it can hide the resize handle. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const q = filter.trim().toLowerCase();
  const match = (f: SelfReviewFileChange) => !q || f.path.toLowerCase().includes(q);

  const filtered = files.filter(match);

  // Group the (already filtered) files under their chapter titles,
  // in chapter order; unnarrated files trail under "Other files". A file
  // claimed by an earlier chapter isn't repeated by a later one. Groups
  // emptied by the filter drop out entirely (header included).
  const groups: Array<{ title: string | null; files: SelfReviewFileChange[] }> = [];
  {
    const byPath = new Map(filtered.map((f) => [f.path, f]));
    const claimed = new Set<string>();
    for (const ch of chapters) {
      const chFiles: SelfReviewFileChange[] = [];
      for (const p of ch.files) {
        const f = byPath.get(p);
        if (f && !claimed.has(p)) {
          claimed.add(p);
          chFiles.push(f);
        }
      }
      if (chFiles.length > 0) groups.push({ title: ch.title, files: chFiles });
    }
    const rest = filtered.filter((f) => !claimed.has(f.path));
    if (rest.length > 0) {
      groups.push({ title: chapters.length > 0 ? 'Other files' : null, files: rest });
    }
  }

  const empty = filtered.length === 0;

  return (
    <CollapsibleRail
      side="left"
      label="Files"
      count={files.length}
      collapsed={collapsed}
      onToggle={onToggleCollapsed}
      width={width}
      headerExtra={
        <span style={{ fontSize: 10.5, color: 'var(--gray-500)', fontWeight: 600 }}>
          {viewed.size}/{files.length} viewed
        </span>
      }
      collapsedContent={
        <>
          <RailStripStat icon="doc-stack" n={files.length} title="Changed files" />
          <RailStripStat icon="check" n={viewed.size} title="Viewed" />
        </>
      }
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
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 6px 0' }}>
        {empty && (
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
        {groups.map((g, gi) => {
          const unseen = g.files.filter((f) => !viewed.has(f.path));
          const seen = g.files.filter((f) => viewed.has(f.path));
          return (
            <Fragment key={g.title ?? '·flat·'}>
              {g.title !== null && (
                <div
                  className="section-label"
                  title={g.title}
                  style={{
                    padding: gi === 0 ? '6px 8px 4px' : '12px 8px 4px',
                    color: g.title === 'Other files' ? 'var(--gray-500)' : 'var(--gray-600)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {g.title}
                </div>
              )}
              {unseen.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  active={f.path === selectedId}
                  isViewed={false}
                  noteCount={noteCounts.get(f.path) ?? 0}
                  onSelect={() => onSelect(f.path)}
                  onToggleViewed={() => onToggleViewed(f.path)}
                />
              ))}
              {/* Seen — viewed files compact into dim single-line rows at the
                  group's bottom (per-group since L9 §3c N1); the checkbox
                  still toggles them back to full rows. */}
              {seen.map((f) => (
                <SeenRow
                  key={f.path}
                  file={f}
                  active={f.path === selectedId}
                  noteCount={noteCounts.get(f.path) ?? 0}
                  onSelect={() => onSelect(f.path)}
                  onToggleViewed={() => onToggleViewed(f.path)}
                />
              ))}
            </Fragment>
          );
        })}
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
    </CollapsibleRail>
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
      <ViewedCheckbox isViewed={isViewed} onToggle={onToggleViewed} />
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
