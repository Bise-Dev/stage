import {
  DndContext,
  type DragEndEvent,
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
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState } from 'react';

import { Icon } from '../../components/Icon';
import type { ChangedFile } from '../../tauri';
import type { Step } from './reconcile';

const POOL = 'pool';
const STORYLINE = 'storyline';

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

/** A draggable unordered-file card (left rail drag source). */
function PoolCard({ f, onAdd }: { f: ChangedFile; onAdd: () => void }) {
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
      <button
        type="button"
        className="btn"
        aria-label={`Add ${f.path} to storyline`}
        onClick={onAdd}
        style={{ flex: '0 0 auto', padding: '2px 6px' }}
      >
        <Icon name="plus" size={10} color="var(--gray-600)" />
      </button>
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

/**
 * Step 1 of storyline composition (design screen 3a): drag unordered files
 * from the left rail into the ordered "reviewer storyline" on the right, and
 * drag storyline rows to reorder. Dragging a storyline row back onto the pool
 * removes it. Mutations are applied via the parent's callbacks so all storyline
 * state stays in `Storyline.tsx`; this component owns only the live drag id.
 */
export function OrderStep({
  pool,
  steps,
  onReorder,
  onAddFromPool,
  onRemoveToPool,
}: {
  pool: ChangedFile[];
  steps: Step[];
  /** Move the storyline step `activePath` to sit where `overPath` is. */
  onReorder: (activePath: string, overPath: string) => void;
  /** Promote a pool file into the storyline at `index` (append when null). */
  onAddFromPool: (path: string, index: number | null) => void;
  /** Send a storyline step back to the unordered pool. */
  onRemoveToPool: (path: string) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const containerOf = (id: string): typeof POOL | typeof STORYLINE | null => {
    if (steps.some((s) => s.path === id)) return STORYLINE;
    if (pool.some((p) => p.path === id)) return POOL;
    if (id === STORYLINE) return STORYLINE;
    if (id === POOL) return POOL;
    return null;
  };

  const handleDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const activePath = String(active.id);
    const overId = String(over.id);
    const from = containerOf(activePath);
    const to = containerOf(overId);
    if (!from || !to) return;

    if (from === STORYLINE && to === STORYLINE) {
      // Reorder within the storyline. Dropping on the container/append zone
      // (not a row) means "send to the end".
      if (overId === STORYLINE || overId === activePath) return;
      onReorder(activePath, overId);
    } else if (from === POOL && to === STORYLINE) {
      // Add at the hovered row's index, or append when dropped on the zone.
      const index = steps.findIndex((s) => s.path === overId);
      onAddFromPool(activePath, index === -1 ? null : index);
    } else if (from === STORYLINE && to === POOL) {
      onRemoveToPool(activePath);
    }
    // POOL → POOL is a no-op (the pool is shown alphabetically).
  };

  const orderedCount = steps.length;
  const totalCount = steps.length + pool.length;
  const activePoolFile = activeId ? pool.find((p) => p.path === activeId) : null;
  const activeStep = activeId ? steps.find((s) => s.path === activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Unordered files (drag source) */}
        <PoolColumn pool={pool} onAdd={(p) => onAddFromPool(p, null)} />

        {/* Storyline canvas */}
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

          <StorylineDropArea steps={steps} onRemove={onRemoveToPool} />
        </div>
      </div>

      <DragOverlay>
        {activePoolFile ? (
          <div
            style={{
              width: 240,
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
            <StatusChip status={activePoolFile.status} />
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
              {splitPath(activePoolFile.path).file}
            </span>
          </div>
        ) : activeStep ? (
          <div
            style={{
              width: 420,
              background: '#fff',
              border: '1px solid rgba(0,122,255,0.5)',
              borderRadius: 'var(--r-md)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
              padding: '10px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Icon name="grip" size={12} color="var(--gray-400)" />
            <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
              {activeStep.path}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function PoolColumn({ pool, onAdd }: { pool: ChangedFile[]; onAdd: (path: string) => void }) {
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
          Unordered files ({pool.length})
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 2, lineHeight: 1.4 }}>
          Drag into the storyline. Files left here are shown to reviewers in alphabetical order at
          the end.
        </div>
      </div>
      <div style={{ flex: 1, padding: '0 8px 8px' }}>
        <SortableContext items={pool.map((p) => p.path)} strategy={verticalListSortingStrategy}>
          {pool.length === 0 ? (
            <div style={{ fontSize: 11.5, color: 'var(--gray-500)', padding: '4px 6px' }}>
              All changed files are in the storyline.
            </div>
          ) : (
            pool.map((f) => <PoolCard key={f.path} f={f} onAdd={() => onAdd(f.path)} />)
          )}
        </SortableContext>
      </div>
    </div>
  );
}

function StorylineDropArea({
  steps,
  onRemove,
}: {
  steps: Step[];
  onRemove: (path: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: STORYLINE });
  return (
    <div ref={setNodeRef} style={{ flex: 1, minHeight: 0 }}>
      <SortableContext items={steps.map((s) => s.path)} strategy={verticalListSortingStrategy}>
        {steps.map((s, i) => (
          <OrderRow key={s.path} s={s} index={i} onRemove={() => onRemove(s.path)} />
        ))}
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
        {steps.length === 0
          ? 'Drag files here to build the storyline'
          : 'Drop unordered files here to extend the storyline'}
      </div>
    </div>
  );
}
