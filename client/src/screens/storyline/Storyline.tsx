import { useCallback, useEffect, useMemo, useState } from 'react';

import { Icon } from '../../components/Icon';
import { TitleBar } from '../../components/TitleBar';
import {
  type ChangedFile,
  type SelfReviewFileChange,
  gitDiffFiles,
  selfReviewDiff,
  storylineGet,
  storylineUpdate,
} from '../../tauri';
import { IntroStep } from './IntroStep';
import { OrderStep } from './OrderStep';
import { Stepper, type WizardStep } from './Stepper';
import { type Step, reconcile } from './reconcile';

export type StorylineCtx = {
  workspaceId: string;
  owner: string;
  repo: string;
  headRef: string;
  baseRef: string;
  title: string;
};

const banner: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--red-d)',
  background: 'rgba(255,59,48,0.08)',
  border: '1px solid rgba(255,59,48,0.20)',
  borderRadius: 'var(--r-sm)',
  padding: '6px 10px',
  marginBottom: 10,
};

function msgOf(e: unknown): string {
  return typeof e === 'object' && e !== null && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);
}

export function Storyline({
  ctx,
  onBack,
}: {
  ctx: StorylineCtx;
  onBack: () => void;
}) {
  const [step, setStep] = useState<WizardStep>('order');
  const [steps, setSteps] = useState<Step[]>([]);
  const [pool, setPool] = useState<ChangedFile[]>([]);
  const [etag, setEtag] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Per-file patch text for the Step 2 diff preview, indexed by path. Fetched
  // independently of the file list so a preview failure never blocks ordering.
  const [diffByPath, setDiffByPath] = useState<Map<string, SelfReviewFileChange>>(new Map());
  const [diffLoading, setDiffLoading] = useState(true);
  const [diffError, setDiffError] = useState<string | null>(null);
  // Unsaved edits live only in component state — leaving without Save loses them.
  // `dirty` gates a confirm on Back so the author can't silently discard work
  // (the post-create flow drops straight into composition; the saved baseline of
  // a brand-new workspace is empty). Cleared on load and after a successful save.
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [changed, storyline] = await Promise.all([
        gitDiffFiles(ctx.baseRef, ctx.headRef),
        storylineGet(ctx.workspaceId),
      ]);
      const { steps: s, pool: p } = reconcile(changed, storyline.files);
      setSteps(s);
      setPool(p);
      setEtag(storyline.etag);
      setSelected((cur) => cur ?? s[0]?.path ?? null);
      setDirty(false);
    } catch (e) {
      // Fail loud (CLAUDE.md): surface the cause; no empty-state fallback.
      console.warn('storyline_load_failed', e);
      setLoadError(msgOf(e));
    }
  }, [ctx.baseRef, ctx.headRef, ctx.workspaceId]);

  // Diff for the preview pane. `self_review_diff` diffs the *checked-out* branch
  // against the base, so if the working tree isn't on this storyline's head ref
  // we'd be previewing the wrong branch — surface that as an explicit error
  // rather than showing a misleading diff (fail-loud, per CLAUDE.md).
  const loadDiff = useCallback(async () => {
    setDiffLoading(true);
    setDiffError(null);
    try {
      const diff = await selfReviewDiff('base', ctx.baseRef);
      if (diff.currentBranch !== ctx.headRef) {
        setDiffByPath(new Map());
        setDiffError(
          `The working tree is on "${diff.currentBranch}", but this storyline is for "${ctx.headRef}". Check out ${ctx.headRef} to preview its diffs.`,
        );
        return;
      }
      setDiffByPath(new Map(diff.files.map((f) => [f.path, f])));
    } catch (e) {
      console.warn('storyline_diff_load_failed', e);
      setDiffError(msgOf(e));
    } finally {
      setDiffLoading(false);
    }
  }, [ctx.baseRef, ctx.headRef]);

  useEffect(() => {
    load();
    loadDiff();
  }, [load, loadDiff]);

  // --- Ordering mutations (Step 1) ---
  const addFromPool = (path: string, index: number | null) => {
    const c = pool.find((f) => f.path === path);
    if (!c) return;
    setPool((p) => p.filter((f) => f.path !== path));
    const next: Step = {
      path: c.path,
      introText: '',
      status: c.status,
      added: c.added,
      removed: c.removed,
      stale: false,
    };
    setSteps((s) => {
      const out = [...s];
      out.splice(index === null ? out.length : index, 0, next);
      return out;
    });
    setSelected(path);
    setDirty(true);
  };

  const removeToPool = (path: string) => {
    const target = steps.find((s) => s.path === path);
    setSteps((s) => s.filter((x) => x.path !== path));
    // Non-stale steps return to the pool; stale ones have no ChangedFile to restore.
    if (target && !target.stale) {
      setPool((p) =>
        [
          ...p,
          {
            path: target.path,
            status: target.status ?? '?',
            added: target.added ?? 0,
            removed: target.removed ?? 0,
          },
        ].sort((a, b) => a.path.localeCompare(b.path)),
      );
    }
    setSelected((cur) => (cur === path ? null : cur));
    setDirty(true);
  };

  const reorder = (activePath: string, overPath: string) => {
    setSteps((s) => {
      const from = s.findIndex((x) => x.path === activePath);
      const to = s.findIndex((x) => x.path === overPath);
      if (from === -1 || to === -1 || from === to) return s;
      const out = [...s];
      const [moved] = out.splice(from, 1);
      out.splice(to, 0, moved);
      return out;
    });
    setDirty(true);
  };

  // --- Intro mutations (Step 2) ---
  const setIntro = (path: string, text: string) => {
    setSteps((s) => s.map((x) => (x.path === path ? { ...x, introText: text } : x)));
    setDirty(true);
  };

  const save = async () => {
    if (etag === null) {
      // Fail loud (CLAUDE.md): Save is reachable only after a successful load
      // (the button is disabled until `etag` is set). If a future trigger ever
      // bypasses that guard, surface it rather than silently no-op'ing.
      setSaveError("Can't save — the storyline hasn't loaded yet. Reload and try again.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await storylineUpdate(
        ctx.workspaceId,
        etag,
        steps.map((s, i) => ({
          diffFilePath: s.path,
          orderIndex: i,
          introText: s.introText,
        })),
      );
      setEtag(result.etag);
      setDirty(false);
    } catch (e) {
      // Fail loud: surface the backend message verbatim; keep the author's edits
      // (no auto-reload — that would clobber the edits that lost the race).
      console.warn('storyline_save_failed', e);
      setSaveError(msgOf(e));
    } finally {
      setSaving(false);
    }
  };

  const goToStep = (next: WizardStep) => {
    if (next === 'intro') {
      // Land on a concrete step so the editor isn't empty.
      setSelected((cur) =>
        cur && steps.some((s) => s.path === cur) ? cur : (steps[0]?.path ?? null),
      );
    }
    setStep(next);
  };

  const back = () => (dirty ? setLeaving(true) : onBack());

  const withIntro = useMemo(
    () => steps.filter((s) => s.introText.trim().length > 0).length,
    [steps],
  );

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title={`Stage — Open pull request · ${ctx.headRef}`} />
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
            <button type="button" className="btn" onClick={back}>
              <Icon name="chevron-left" size={10} color="var(--gray-700)" /> Workspaces
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span className="badge mono" style={{ background: 'rgba(0,0,0,0.06)' }}>
                {ctx.baseRef}
              </span>
              <Icon name="arrow-right" size={11} color="var(--gray-400)" />
              <span
                className="badge mono"
                style={{ background: 'var(--blue-tint)', color: 'var(--blue-press)' }}
              >
                {ctx.headRef}
              </span>
            </div>
            {ctx.title && (
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: 'var(--gray-900)',
                  marginLeft: 4,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                {ctx.title}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <Stepper current={step} onJump={goToStep} />
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
              {step === 'order'
                ? `${steps.length} of ${steps.length + pool.length} ordered`
                : `${withIntro} of ${steps.length} with intros`}
            </span>
            <button
              type="button"
              className="btn"
              onClick={save}
              disabled={saving || etag === null}
              style={{ opacity: saving ? 0.6 : 1 }}
            >
              {saving ? 'Saving…' : 'Save storyline'}
            </button>
            {step === 'order' ? (
              <button type="button" className="btn btn-primary" onClick={() => goToStep('intro')}>
                Next: Write intros <Icon name="chevron-right" size={11} color="#fff" />
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => goToStep('order')}>
                <Icon name="chevron-left" size={11} /> Back to ordering
              </button>
            )}
          </div>

          {(loadError || saveError) && (
            <div style={{ padding: '10px 18px 0' }}>
              {loadError && <div style={banner}>Couldn't load storyline: {loadError}</div>}
              {saveError && <div style={banner}>Couldn't save storyline: {saveError}</div>}
            </div>
          )}

          {step === 'order' ? (
            <OrderStep
              pool={pool}
              steps={steps}
              onReorder={reorder}
              onAddFromPool={addFromPool}
              onRemoveToPool={removeToPool}
            />
          ) : (
            <IntroStep
              steps={steps}
              selectedPath={selected}
              onSelectPath={setSelected}
              onSetIntro={setIntro}
              getFile={(path) => diffByPath.get(path) ?? null}
              diffLoading={diffLoading}
              diffError={diffError}
            />
          )}
        </div>
      </div>

      {leaving && (
        // Unsaved-changes guard. Inline (not the Workspaces ConfirmDialog, which is
        // unexported); extracting that to a shared component is a sensible follow-up.
        // biome-ignore lint/a11y/useSemanticElements: POC overlay modal, role="dialog" matches the existing NewWorkspaceModal/ConfirmDialog pattern rather than a native <dialog>.
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Leave without saving?"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.28)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setLeaving(false);
          }}
        >
          <div
            style={{
              width: 380,
              background: '#fff',
              borderRadius: 'var(--r-lg)',
              boxShadow: 'var(--sh-pop)',
              padding: 18,
            }}
          >
            <div
              style={{ fontSize: 15, fontWeight: 700, color: 'var(--gray-900)', marginBottom: 8 }}
            >
              Leave without saving?
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--gray-600)', marginBottom: 16 }}>
              Your unsaved storyline changes will be lost.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setLeaving(false)}>
                Keep editing
              </button>
              <button type="button" className="btn btn-primary" onClick={onBack}>
                Discard changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
