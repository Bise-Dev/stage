import { DiffModeEnum, DiffView } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { TitleBar } from '../../components/TitleBar';
import {
  type BaseOptions,
  type Review,
  type SelfReviewFileChange,
  type StorylinePreview,
  type StorylineStepView,
  gitCurrentBranch,
  reviewDraftCreate,
  reviewDraftDiscard,
  reviewDraftGet,
  selfReviewBaseOptions,
  storylinePreview,
  storylineStepAdd,
  storylineStepEdit,
  storylineStepRemove,
  storylineStepsReorder,
} from '../../tauri';
import { inferDiffLanguage } from '../selfReview/markdown';

function msgOf(e: unknown): string {
  return typeof e === 'object' && e !== null && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);
}

const notice: React.CSSProperties = {
  padding: '18px 16px',
  fontSize: 12,
  color: 'var(--gray-500)',
};

/**
 * One file's committed diff, rendered via `@git-diff-view`. `file` is the
 * matching {@link SelfReviewFileChange} from the preview's full diff, or null
 * when the step's anchor is no longer in the diff. We never fabricate a diff: a
 * missing/binary patch shows an explicit notice (fail-loud, CLAUDE.md), never a
 * blank or stale render.
 */
function FileDiff({ file }: { file: SelfReviewFileChange | null }) {
  const data = useMemo(() => {
    if (!file || !file.patch) return null;
    const lang = inferDiffLanguage(file.path);
    return {
      oldFile: { fileName: file.oldPath ?? file.path, fileLang: lang },
      newFile: { fileName: file.path, fileLang: lang },
      hunks: [file.patch],
    };
  }, [file]);

  if (!file) {
    return (
      <div style={notice}>
        This step's file is no longer in the diff — it dropped out of the change.
      </div>
    );
  }
  if (file.isBinary) return <div style={notice}>Binary file — no textual diff to preview.</div>;
  if (!data) return <div style={notice}>No diff available for this file.</div>;
  return (
    <DiffView
      data={data}
      diffViewMode={DiffModeEnum.Unified}
      diffViewHighlight
      diffViewWrap
      diffViewFontSize={12}
      diffViewTheme="light"
    />
  );
}

/**
 * The author's **local** storyline screen (ADR-0022 §1/§3, milestone B): compose
 * an ordered, annotated walkthrough of the current branch's change, then preview
 * it step by step — all with no auth/sign-in (ID-3 #56). Everything derived (the
 * diff overlay, stale flags, which files are outside the storyline) is computed
 * in Rust; this screen only renders the DTOs (ADR-0022 §7).
 *
 * Reached from the local-only Repo-home; publishing to GitHub is milestone D.
 */
export function LocalStoryline({ onBack }: { onBack: () => void }) {
  const [branch, setBranch] = useState<string>('');
  const [draft, setDraft] = useState<Review | null>(null);
  const [preview, setPreview] = useState<StorylinePreview | null>(null);
  const [baseOpts, setBaseOpts] = useState<BaseOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Ready-to-share form state (shown until a draft exists).
  const [titleInput, setTitleInput] = useState('');
  const [baseInput, setBaseInput] = useState('');
  const [starting, setStarting] = useState(false);

  const [mode, setMode] = useState<'compose' | 'preview'>('compose');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Edit buffers for the selected step, seeded on selection.
  const [titleBuf, setTitleBuf] = useState('');
  const [introBuf, setIntroBuf] = useState('');

  // Load the full preview (diff + steps + overlay) for the active draft.
  const reloadPreview = useCallback(async (keepSelection: string | null) => {
    try {
      const pv = await storylinePreview();
      setPreview(pv);
      // Keep the current selection if it still exists, else focus the first step.
      setSelectedId((cur) => {
        const want = keepSelection ?? cur;
        if (want && pv.steps.some((s) => s.step.id === want)) return want;
        return pv.steps[0]?.step.id ?? null;
      });
    } catch (e) {
      console.warn('storyline_preview_failed', e);
      setLoadError(msgOf(e));
    }
  }, []);

  // Boot: current branch + base options + any existing draft (then its preview).
  useEffect(() => {
    (async () => {
      try {
        const [b, opts, d] = await Promise.all([
          gitCurrentBranch(),
          selfReviewBaseOptions(),
          reviewDraftGet(),
        ]);
        setBranch(b);
        setBaseOpts(opts);
        setTitleInput(b);
        setBaseInput(opts.recommended);
        setDraft(d);
        if (d) await reloadPreview(null);
      } catch (e) {
        console.warn('storyline_boot_failed', e);
        setLoadError(msgOf(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [reloadPreview]);

  // Seed the edit buffers whenever the selected step changes.
  useEffect(() => {
    const sel = preview?.steps.find((s) => s.step.id === selectedId) ?? null;
    setTitleBuf(sel?.step.title ?? '');
    setIntroBuf(sel?.step.intro ?? '');
  }, [selectedId, preview]);

  const startStoryline = async () => {
    setStarting(true);
    setActionError(null);
    try {
      const d = await reviewDraftCreate(titleInput.trim() || branch, baseInput.trim());
      setDraft(d);
      await reloadPreview(null);
    } catch (e) {
      console.warn('review_draft_create_failed', e);
      setActionError(msgOf(e));
    } finally {
      setStarting(false);
    }
  };

  const addStep = async (path: string) => {
    setActionError(null);
    try {
      const step = await storylineStepAdd(path, null, '');
      await reloadPreview(step.id);
      setMode('compose');
    } catch (e) {
      console.warn('storyline_step_add_failed', e);
      setActionError(msgOf(e));
    }
  };

  const removeStep = async (id: string) => {
    setActionError(null);
    try {
      await storylineStepRemove(id);
      await reloadPreview(null);
    } catch (e) {
      console.warn('storyline_step_remove_failed', e);
      setActionError(msgOf(e));
    }
  };

  const saveStep = async (id: string) => {
    setActionError(null);
    try {
      await storylineStepEdit(id, titleBuf.trim() || null, introBuf);
      await reloadPreview(id);
    } catch (e) {
      console.warn('storyline_step_edit_failed', e);
      setActionError(msgOf(e));
    }
  };

  // Move the step at `index` by `delta` (-1 up, +1 down) and persist the order.
  const moveStep = async (index: number, delta: number) => {
    if (!preview) return;
    const ids = preview.steps.map((s) => s.step.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setActionError(null);
    try {
      await storylineStepsReorder(ids);
      await reloadPreview(null);
    } catch (e) {
      console.warn('storyline_reorder_failed', e);
      setActionError(msgOf(e));
    }
  };

  const discard = async () => {
    setActionError(null);
    try {
      await reviewDraftDiscard();
      onBack();
    } catch (e) {
      console.warn('review_draft_discard_failed', e);
      setActionError(msgOf(e));
    }
  };

  const fileFor = useCallback(
    (path: string): SelfReviewFileChange | null =>
      preview?.diff.files.find((f) => f.path === path) ?? null,
    [preview],
  );

  const selectedStep: StorylineStepView | null = useMemo(
    () => preview?.steps.find((s) => s.step.id === selectedId) ?? null,
    [preview, selectedId],
  );

  // Base-branch options for the Ready-to-share picker (origin/* + local default).
  const baseChoices = useMemo(() => {
    const out: string[] = [];
    if (baseOpts) {
      out.push(baseOpts.recommended);
      if (baseOpts.remoteDefault) out.push(baseOpts.remoteDefault);
      if (baseOpts.localDefault) out.push(baseOpts.localDefault.name);
    }
    if (baseInput) out.push(baseInput);
    return [...new Set(out)];
  }, [baseOpts, baseInput]);

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title={`Stage — Storyline · ${branch}`} />
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {/* Toolbar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '0 16px',
              height: 48,
              flex: '0 0 48px',
              background: '#fff',
              borderBottom: '1px solid var(--hairline)',
            }}
          >
            <button type="button" className="btn" onClick={onBack}>
              <Icon name="chevron-left" size={10} color="var(--gray-700)" /> Back
            </button>
            {draft && (
              <>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gray-900)' }}>
                  {draft.title}
                </span>
                <span className="badge mono" style={{ background: 'rgba(0,0,0,0.06)' }}>
                  {draft.baseRef} → {branch}
                </span>
                <div style={{ flex: 1 }} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    className={mode === 'compose' ? 'btn btn-primary' : 'btn'}
                    onClick={() => setMode('compose')}
                  >
                    Compose
                  </button>
                  <button
                    type="button"
                    className={mode === 'preview' ? 'btn btn-primary' : 'btn'}
                    onClick={() => setMode('preview')}
                  >
                    <Icon
                      name="eye"
                      size={11}
                      color={mode === 'preview' ? '#fff' : 'var(--gray-700)'}
                    />{' '}
                    Preview
                  </button>
                </div>
                <button type="button" className="btn" onClick={discard}>
                  Discard
                </button>
              </>
            )}
          </div>

          {(loadError || actionError) && (
            <div style={{ padding: '10px 18px 0' }}>
              {loadError && (
                <ErrorBanner
                  title="Couldn't load the storyline"
                  detail={loadError}
                  onClose={() => setLoadError(null)}
                />
              )}
              {actionError && (
                <ErrorBanner
                  title="Couldn't update the storyline"
                  detail={actionError}
                  onClose={() => setActionError(null)}
                />
              )}
            </div>
          )}

          {loading ? (
            <div style={notice}>Loading…</div>
          ) : !draft ? (
            <ReadyToShare
              title={titleInput}
              base={baseInput}
              baseChoices={baseChoices}
              branch={branch}
              starting={starting}
              onTitle={setTitleInput}
              onBase={setBaseInput}
              onStart={startStoryline}
            />
          ) : mode === 'compose' ? (
            <Composer
              preview={preview}
              selectedStep={selectedStep}
              selectedId={selectedId}
              titleBuf={titleBuf}
              introBuf={introBuf}
              onSelect={setSelectedId}
              onTitleBuf={setTitleBuf}
              onIntroBuf={setIntroBuf}
              onAdd={addStep}
              onRemove={removeStep}
              onMove={moveStep}
              onSave={saveStep}
              fileFor={fileFor}
            />
          ) : (
            <PreviewWalk preview={preview} fileFor={fileFor} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The "Ready to share" gate: name the Review + pick a base, then start composing. */
function ReadyToShare({
  title,
  base,
  baseChoices,
  branch,
  starting,
  onTitle,
  onBase,
  onStart,
}: {
  title: string;
  base: string;
  baseChoices: string[];
  branch: string;
  starting: boolean;
  onTitle: (v: string) => void;
  onBase: (v: string) => void;
  onStart: () => void;
}) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      <div style={{ maxWidth: 480 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--gray-900)', marginBottom: 6 }}>
          Ready to share
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--gray-600)', marginBottom: 18 }}>
          Start a storyline for <span className="mono">{branch}</span>. This stays local — nothing
          is pushed to GitHub.
        </div>

        <label
          htmlFor="sl-title"
          style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-700)' }}
        >
          Title
        </label>
        <input
          id="sl-title"
          className="input"
          value={title}
          onChange={(e) => onTitle(e.target.value)}
          placeholder={branch}
          style={{ display: 'block', width: '100%', margin: '4px 0 14px' }}
        />

        <label
          htmlFor="sl-base"
          style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-700)' }}
        >
          Base branch
        </label>
        <input
          id="sl-base"
          list="sl-base-choices"
          className="input mono"
          value={base}
          onChange={(e) => onBase(e.target.value)}
          style={{ display: 'block', width: '100%', margin: '4px 0 18px' }}
        />
        <datalist id="sl-base-choices">
          {baseChoices.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>

        <button
          type="button"
          className="btn btn-primary"
          onClick={onStart}
          disabled={starting || base.trim().length === 0}
        >
          {starting ? 'Starting…' : 'Start storyline'}
        </button>
      </div>
    </div>
  );
}

/** Compose / curate: ordered steps + the overlay of files outside the storyline,
 *  with an editor for the selected step. */
function Composer({
  preview,
  selectedStep,
  selectedId,
  titleBuf,
  introBuf,
  onSelect,
  onTitleBuf,
  onIntroBuf,
  onAdd,
  onRemove,
  onMove,
  onSave,
  fileFor,
}: {
  preview: StorylinePreview | null;
  selectedStep: StorylineStepView | null;
  selectedId: string | null;
  titleBuf: string;
  introBuf: string;
  onSelect: (id: string) => void;
  onTitleBuf: (v: string) => void;
  onIntroBuf: (v: string) => void;
  onAdd: (path: string) => void;
  onRemove: (id: string) => void;
  onMove: (index: number, delta: number) => void;
  onSave: (id: string) => void;
  fileFor: (path: string) => SelfReviewFileChange | null;
}) {
  const steps = preview?.steps ?? [];
  const unstoried = preview?.unstoried ?? [];

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {/* Left rail: storyline steps + the un-storied overlay */}
      <div
        style={{
          width: 320,
          flex: '0 0 320px',
          borderRight: '1px solid var(--hairline)',
          overflow: 'auto',
          background: '#fff',
        }}
      >
        <RailHeader label={`Storyline · ${steps.length} step${steps.length === 1 ? '' : 's'}`} />
        {steps.length === 0 && (
          <div style={{ ...notice, padding: '10px 16px' }}>
            No steps yet — add a file from “Other changes” below.
          </div>
        )}
        {steps.map((s, i) => (
          <StepRow
            key={s.step.id}
            view={s}
            index={i}
            count={steps.length}
            selected={s.step.id === selectedId}
            onSelect={() => onSelect(s.step.id)}
            onUp={() => onMove(i, -1)}
            onDown={() => onMove(i, 1)}
            onRemove={() => onRemove(s.step.id)}
          />
        ))}

        <RailHeader
          label={`Other changes · ${unstoried.length}`}
          hint="Files in the diff but not in the storyline — still reviewable."
        />
        {unstoried.length === 0 && (
          <div style={{ ...notice, padding: '10px 16px' }}>
            Every changed file is in the storyline.
          </div>
        )}
        {unstoried.map((path) => (
          <div
            key={path}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              borderBottom: '1px solid var(--hairline)',
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 11.5,
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {path}
            </span>
            <button type="button" className="btn" onClick={() => onAdd(path)}>
              <Icon name="plus" size={10} color="var(--gray-700)" /> Add
            </button>
          </div>
        ))}
      </div>

      {/* Right pane: the selected step's editor + its diff */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
          background: '#fff',
        }}
      >
        {!selectedStep ? (
          <div style={notice}>Select or add a step to edit its intro and see its diff.</div>
        ) : (
          <>
            <div style={{ padding: 14, borderBottom: '1px solid var(--hairline)' }}>
              <div
                className="mono"
                style={{ fontSize: 11.5, color: 'var(--gray-500)', marginBottom: 8 }}
              >
                {selectedStep.step.anchor}
                {selectedStep.stale && (
                  <span
                    className="badge"
                    style={{
                      marginLeft: 8,
                      background: 'var(--blue-tint)',
                      color: 'var(--blue-press)',
                    }}
                  >
                    not in diff
                  </span>
                )}
              </div>
              <input
                aria-label="Step title"
                className="input"
                value={titleBuf}
                onChange={(e) => onTitleBuf(e.target.value)}
                placeholder="Optional title"
                style={{ display: 'block', width: '100%', marginBottom: 8 }}
              />
              <textarea
                aria-label="Step intro"
                className="input"
                value={introBuf}
                onChange={(e) => onIntroBuf(e.target.value)}
                placeholder="Intro (markdown) — what this part of the change does"
                rows={4}
                style={{
                  display: 'block',
                  width: '100%',
                  resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onSave(selectedStep.step.id)}
                >
                  Save step
                </button>
              </div>
            </div>
            <FileDiff file={fileFor(selectedStep.step.anchor)} />
          </>
        )}
      </div>
    </div>
  );
}

/** Walk the storyline in author order (SL-4 author side), then the overlay of
 *  changes outside it (GAP-4) so nothing is hidden. */
function PreviewWalk({
  preview,
  fileFor,
}: {
  preview: StorylinePreview | null;
  fileFor: (path: string) => SelfReviewFileChange | null;
}) {
  const steps = preview?.steps ?? [];
  const unstoried = preview?.unstoried ?? [];

  if (steps.length === 0) {
    return <div style={notice}>No steps yet — compose a storyline to preview it.</div>;
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', background: '#fff' }}>
      {steps.map((s, i) => (
        <section key={s.step.id} style={{ borderBottom: '6px solid var(--hairline)' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--hairline)' }}>
            <div style={{ fontSize: 12, color: 'var(--gray-500)', marginBottom: 2 }}>
              Step {i + 1} of {steps.length}
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gray-900)' }}>
              {s.step.title || s.step.anchor}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--gray-500)' }}>
              {s.step.anchor}
            </div>
          </div>
          {s.step.intro.trim() && (
            <div
              style={{
                padding: '12px 16px',
                fontSize: 12.5,
                color: 'var(--gray-800)',
                lineHeight: 1.5,
              }}
            >
              <Markdown>{s.step.intro}</Markdown>
            </div>
          )}
          <FileDiff file={s.stale ? null : fileFor(s.step.anchor)} />
        </section>
      ))}

      {unstoried.length > 0 && (
        <section>
          <div style={{ padding: '12px 16px', background: 'var(--blue-tint)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--blue-press)' }}>
              Other changes ({unstoried.length})
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--gray-600)' }}>
              Not part of the storyline, but still in the diff — reviewers can reach them.
            </div>
          </div>
          {unstoried.map((path) => (
            <div key={path} style={{ borderTop: '1px solid var(--hairline)' }}>
              <div
                className="mono"
                style={{ fontSize: 11, color: 'var(--gray-600)', padding: '8px 16px' }}
              >
                {path}
              </div>
              <FileDiff file={fileFor(path)} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function RailHeader({ label, hint }: { label: string; hint?: string }) {
  return (
    <div
      style={{
        padding: '8px 12px',
        background: 'var(--gray-50, #f7f7f8)',
        borderBottom: '1px solid var(--hairline)',
        position: 'sticky',
        top: 0,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--gray-700)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        {label}
      </div>
      {hint && <div style={{ fontSize: 10.5, color: 'var(--gray-500)' }}>{hint}</div>}
    </div>
  );
}

function StepRow({
  view,
  index,
  count,
  selected,
  onSelect,
  onUp,
  onDown,
  onRemove,
}: {
  view: StorylineStepView;
  index: number;
  count: number;
  selected: boolean;
  onSelect: () => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 12px',
        borderBottom: '1px solid var(--hairline)',
        background: selected ? 'var(--blue-tint)' : 'transparent',
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        className="cursor-default"
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: 'left',
          background: 'none',
          border: 'none',
          padding: 0,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--gray-900)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {index + 1}. {view.step.title || view.step.anchor}
          {view.stale && (
            <span className="badge" style={{ marginLeft: 6, background: 'rgba(0,0,0,0.06)' }}>
              stale
            </span>
          )}
        </div>
        {view.step.title && (
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              color: 'var(--gray-500)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {view.step.anchor}
          </div>
        )}
      </button>
      <button
        type="button"
        className="btn"
        onClick={onUp}
        disabled={index === 0}
        aria-label="Move step up"
      >
        ↑
      </button>
      <button
        type="button"
        className="btn"
        onClick={onDown}
        disabled={index === count - 1}
        aria-label="Move step down"
      >
        ↓
      </button>
      <button type="button" className="btn" onClick={onRemove} aria-label="Remove step">
        ✕
      </button>
    </div>
  );
}
