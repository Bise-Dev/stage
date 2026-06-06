import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useState } from 'react';

import { Icon } from '../../components/Icon';
import type { ChangedFile } from '../../tauri';
import type { Step } from './reconcile';

const POOL = 'pool';
const STORYLINE = 'storyline';
type ContainerId = typeof POOL | typeof STORYLINE;

/** A/M/D status chip matching the design's drag cards. Status is the single-char
 *  code from `git_diff_files` ("A"/"M"/"D"/"?"). */
function StatusChip({ status }: { status: string | null }) {
  const color =
    status === 'A'
      ? 'var(--green-d)'
      : status === 'D'
        ? 'var(--red-d)'
        : status === 'M'
          ? '#a08000'
          : 'var(--gray-500)';
  return (
    <span
      className="mono"
      style={{
        fontSize: 10,
        fontWeight: 700,
        color,
        width: 14,
        height: 14,
        borderRadius: 3,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: `1px solid ${color}55`,
        flex: '0 0 14px',
      }}
    >
      {status ?? '?'}
    </span>
  );
}

function Counts({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null || removed === null) return null;
  return (
    <span style={{ fontSize: 10.5, color: 'var(--gray-500)', flex: '0 0 auto' }}>
      <span style={{ color: 'var(--green-d)' }}>+{added}</span>{' '}
      <span style={{ color: 'var(--red-d)' }}>−{removed}</span>
    </span>
  );
}

function splitPath(path: string): { file: string; dir: string } {
  const parts = path.split('/');
  const file = parts.pop() ?? path;
  return { file, dir: parts.join('/') };
}

/** Reconstruct the ChangedFile shape from a non-stale step, so a step dragged
 *  into the pool can render as a pool card mid-drag. */
function stepToFile(s: Step): ChangedFile {
  return { path: s.path, status: s.status ?? '?', added: s.added ?? 0, removed: s.removed ?? 0 };
}

/** A draggable unordered-file card (left rail drag source). */
function PoolCard({ f, onAdd }: { f: ChangedFile; onAdd?: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: f.path,
  });
  const { file, dir } = splitPath(f.path);
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        background: '#fff',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r-md)',
        padding: '8px 10px',
        margin: '4px 0',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        boxShadow: 'var(--sh-1)',
      }}
    >
      <button
        type="button"
        aria-label={`Drag ${f.path}`}
        className="grip-handle"
        {...attributes}
        {...listeners}
      >
        <Icon name="grip" size={11} color="var(--gray-400)" />
      </button>
      <StatusChip status={f.status} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {file}
        </div>
        {dir && (
          <div
            style={{
              fontSize: 10,
              color: 'var(--gray-500)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {dir}
          </div>
        )}
      </div>
      <Counts added={f.added} removed={f.removed} />
      {onAdd && (
        <button
          type="button"
          className="btn"
          aria-label={`Add ${f.path} to storyline`}
          onClick={onAdd}
          style={{ flex: '0 0 auto', padding: '2px 6px' }}
        >
          <Icon name="plus" size={10} color="var(--gray-600)" />
        </button>
      )}
    </div>
  );
}

/** A sortable storyline row in the order canvas. */
function OrderRow({ s, index, onRemove }: { s: Step; index: number; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: s.path,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        // While dragging, the DragOverlay shows the lifted copy — leave a dim
        // dashed placeholder behind so the drop target reads clearly.
        background: isDragging ? 'rgba(0,122,255,0.04)' : 'transparent',
        border: `1px ${isDragging ? 'dashed rgba(0,122,255,0.4)' : 'solid transparent'}`,
        borderRadius: 'var(--r-md)',
        opacity: isDragging ? 0.6 : 1,
        marginBottom: 4,
      }}
    >
      <button
        type="button"
        aria-label={`Reorder ${s.path}`}
        className="grip-handle"
        {...attributes}
        {...listeners}
      >
        <Icon name="grip" size={12} color="var(--gray-400)" />
      </button>
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          flex: '0 0 24px',
          background: 'var(--blue)',
          color: '#fff',
          fontSize: 12,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {index + 1}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span
            className="mono"
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--gray-900)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {s.path}
          </span>
          {s.stale && (
            <span
              className="badge badge-orange"
              style={{ flex: '0 0 auto' }}
              title="File no longer changed"
            >
              stale
            </span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 2 }}>
          {s.introText.trim() ? (
            <span>
              <Icon name="check" size={10} color="var(--green-d)" /> intro written
            </span>
          ) : (
            <span style={{ fontStyle: 'italic' }}>no intro yet</span>
          )}
        </div>
      </div>
      <Counts added={s.added} removed={s.removed} />
      <button
        type="button"
        className="btn"
        aria-label={`Remove ${s.path} from storyline`}
        onClick={onRemove}
        style={{ flex: '0 0 auto', padding: '2px 6px' }}
      >
        <Icon name="plus" size={11} color="var(--gray-500)" className="rotate-45" />
      </button>
    </div>
  );
}

/** The live insertion marker: a pool file currently hovered into the storyline.
 *  It's a real sortable node, so neighbouring rows shift open exactly like an
 *  in-list reorder — that's the "gap" that marks where the drop will land. */
function IncomingRow({ f }: { f: ChangedFile }) {
  const { setNodeRef, transform, transition } = useSortable({ id: f.path });
  const { file } = splitPath(f.path);
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        background: 'var(--blue-tint)',
        border: '1.5px dashed var(--blue)',
        borderRadius: 'var(--r-md)',
        marginBottom: 4,
        color: 'var(--blue-press)',
      }}
    >
      <Icon name="plus" size={12} color="var(--blue-press)" />
      <StatusChip status={f.status} />
      <span
        className="mono"
        style={{
          flex: 1,
          fontSize: 12.5,
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {file}
      </span>
      <span style={{ fontSize: 11, fontWeight: 600 }}>drops here</span>
    </div>
  );
}

/**
 * Step 1 of storyline composition (design screen 3a): drag unordered files from
 * the left rail into the ordered "reviewer storyline" on the right, and drag
 * storyline rows to reorder. Dragging a storyline row back onto the pool removes
 * it.
 *
 * Uses the dnd-kit multi-container sortable pattern: an ephemeral `clones` of
 * both lists is mutated on `dragOver` so the dragged item lives in whichever
 * list it currently hovers — that makes cross-container drags open a live gap
 * (the {@link IncomingRow} marker) exactly like an in-list reorder. The real
 * `steps`/`pool` state is only touched once, on `dragEnd`, via `onSetStoryline`.
 */
export function OrderStep({
  pool,
  steps,
  onSetStoryline,
}: {
  pool: ChangedFile[];
  steps: Step[];
  /** The complete ordered list of storyline paths. The parent recomputes
   *  `steps` (preserving intros) and the leftover `pool` from it. */
  onSetStoryline: (paths: string[]) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Ephemeral list arrangement during a drag; null when not dragging.
  const [clones, setClones] = useState<{ pool: string[]; storyline: string[] } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const stepByPath = useMemo(() => new Map(steps.map((s) => [s.path, s])), [steps]);
  const fileByPath = useMemo(() => new Map(pool.map((f) => [f.path, f])), [pool]);

  const propLists = useMemo(
    () => ({ pool: pool.map((f) => f.path), storyline: steps.map((s) => s.path) }),
    [pool, steps],
  );
  const view = clones ?? propLists;

  const findContainer = (id: string): ContainerId | null => {
    if (id === POOL || id === STORYLINE) return id;
    if (view.storyline.includes(id)) return STORYLINE;
    if (view.pool.includes(id)) return POOL;
    return null;
  };

  // Resolve a path to its data regardless of which list currently shows it, so
  // a pool item hovered into the storyline (or vice-versa) still renders.
  const fileFor = (id: string): ChangedFile | null => {
    const f = fileByPath.get(id);
    if (f) return f;
    const s = stepByPath.get(id);
    return s ? stepToFile(s) : null;
  };

  const handleDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
    setClones({ pool: [...propLists.pool], storyline: [...propLists.storyline] });
  };

  const handleDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    const activeIdStr = String(active.id);
    const overId = String(over.id);
    const from = findContainer(activeIdStr);
    const to = findContainer(overId);
    if (!from || !to || from === to) return;
    setClones((prev) => {
      if (!prev) return prev;
      const fromItems = prev[from];
      const toItems = prev[to];
      const overIndex =
        overId === to
          ? toItems.length
          : toItems.indexOf(overId) === -1
            ? toItems.length
            : toItems.indexOf(overId);
      return {
        ...prev,
        [from]: fromItems.filter((i) => i !== activeIdStr),
        [to]: [...toItems.slice(0, overIndex), activeIdStr, ...toItems.slice(overIndex)],
      };
    });
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    const current = clones;
    setActiveId(null);
    setClones(null);
    if (!current) return;
    if (over) {
      const activeIdStr = String(active.id);
      const overId = String(over.id);
      const from = findContainer(activeIdStr);
      const to = findContainer(overId);
      // Same-container reorder is committed here (dragOver only handles moves
      // across containers); the within-list shift was shown live by sortable.
      if (from && from === to && overId !== activeIdStr && overId !== from) {
        const arr = current[from];
        const oldI = arr.indexOf(activeIdStr);
        const newI = arr.indexOf(overId);
        if (oldI !== -1 && newI !== -1) current[from] = arrayMove(arr, oldI, newI);
      }
    }
    onSetStoryline(current.storyline);
  };

  const orderedCount = view.storyline.length;
  const totalCount = view.storyline.length + view.pool.length;
  const activeFile = activeId ? fileFor(activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setClones(null);
      }}
    >
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <PoolColumn
          ids={view.pool}
          fileFor={fileFor}
          onAdd={(p) => onSetStoryline([...view.storyline, p])}
        />

        <div
          style={{
            flex: 1,
            minWidth: 0,
            padding: '16px 22px',
            background: 'var(--gray-50)',
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <Icon name="doc-stack" size={14} color="var(--gray-700)" />
            <span
              style={{
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: -0.01,
                color: 'var(--gray-900)',
              }}
            >
              Reviewer storyline
            </span>
            <span className="badge">
              {orderedCount} of {totalCount} ordered
            </span>
            <div style={{ flex: 1 }} />
            <div style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
              Drag rows to reorder. Drop unordered files from the left to add steps.
            </div>
          </div>

          <StorylineDropArea
            ids={view.storyline}
            stepByPath={stepByPath}
            fileFor={fileFor}
            onRemove={(p) => onSetStoryline(view.storyline.filter((x) => x !== p))}
          />
        </div>
      </div>

      <DragOverlay>
        {activeFile ? (
          <div
            style={{
              width: 260,
              background: '#fff',
              border: '1px solid rgba(0,122,255,0.5)',
              borderRadius: 'var(--r-md)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
              padding: '8px 10px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Icon name="grip" size={11} color="var(--gray-400)" />
            <StatusChip status={activeFile.status} />
            <span
              className="mono"
              style={{
                flex: 1,
                fontSize: 12,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {splitPath(activeFile.path).file}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function PoolColumn({
  ids,
  fileFor,
  onAdd,
}: {
  ids: string[];
  fileFor: (id: string) => ChangedFile | null;
  onAdd: (path: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: POOL });
  return (
    <div
      ref={setNodeRef}
      style={{
        width: 260,
        flex: '0 0 260px',
        borderRight: '1px solid var(--hairline)',
        background: isOver ? 'rgba(255,59,48,0.04)' : '#fbfaf8',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
        transition: 'background 0.12s',
      }}
    >
      <div style={{ padding: '12px 14px 8px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gray-800)' }}>
          Unordered files ({ids.length})
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 2, lineHeight: 1.4 }}>
          Drag into the storyline. Files left here are shown to reviewers in alphabetical order at
          the end.
        </div>
      </div>
      <div style={{ flex: 1, padding: '0 8px 8px' }}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {ids.length === 0 ? (
            <div style={{ fontSize: 11.5, color: 'var(--gray-500)', padding: '4px 6px' }}>
              All changed files are in the storyline.
            </div>
          ) : (
            ids.map((id) => {
              const f = fileFor(id);
              return f ? <PoolCard key={id} f={f} onAdd={() => onAdd(id)} /> : null;
            })
          )}
        </SortableContext>
      </div>
    </div>
  );
}

function StorylineDropArea({
  ids,
  stepByPath,
  fileFor,
  onRemove,
}: {
  ids: string[];
  stepByPath: Map<string, Step>;
  fileFor: (id: string) => ChangedFile | null;
  onRemove: (path: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: STORYLINE });
  return (
    <div ref={setNodeRef} style={{ flex: 1, minHeight: 0 }}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {ids.map((id, i) => {
          const step = stepByPath.get(id);
          if (step) return <OrderRow key={id} s={step} index={i} onRemove={() => onRemove(id)} />;
          // A pool item currently hovered into the storyline — the live marker.
          const f = fileFor(id);
          return f ? <IncomingRow key={id} f={f} /> : null;
        })}
      </SortableContext>
      <div
        style={{
          marginTop: 10,
          padding: '20px',
          border: `1.5px dashed ${isOver ? 'var(--blue)' : 'rgba(0,0,0,0.16)'}`,
          borderRadius: 'var(--r-lg)',
          background: isOver ? 'var(--blue-tint)' : 'rgba(0,0,0,0.02)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          color: isOver ? 'var(--blue-press)' : 'var(--gray-500)',
          fontSize: 12.5,
          transition: 'background 0.12s, border-color 0.12s',
        }}
      >
        <Icon name="plus" size={12} color={isOver ? 'var(--blue-press)' : 'var(--gray-500)'} />
        {ids.length === 0
          ? 'Drag files here to build the storyline'
          : 'Drop unordered files here to extend the storyline'}
      </div>
    </div>
  );
}
