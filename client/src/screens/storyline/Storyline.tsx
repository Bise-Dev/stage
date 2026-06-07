import { useCallback, useEffect, useMemo, useState } from 'react';

import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { TitleBar } from '../../components/TitleBar';
import {
  type ChangedFile,
  type SelfReviewFileChange,
  gitDiffFiles,
  selfReviewDiff,
  storylineGet,
  storylineUpdate,
  workspacePublish,
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
  /** PR number once published, else null. Drives the publish button: null →
   *  "Open PR" (push + open/adopt the PR), non-null → "Push update" (push only).
   *  Fixed for the screen's lifetime — Open PR navigates back, and re-entry from
   *  an in-review row carries the now-set number. */
  prNumber: number | null;
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

// Neutral, informational variant of `banner` — for guidance (e.g. the empty
// "nothing committed yet" state), not failures. Errors stay red.
const infoBanner: React.CSSProperties = {
  ...banner,
  color: 'var(--blue-press)',
  background: 'var(--blue-tint)',
  border: '1px solid rgba(0,122,255,0.20)',
};

function msgOf(e: unknown): string {
  return typeof e === 'object' && e !== null && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);
}

/** Wraps the publish button so a *disabled* (gated) button can still explain
 *  itself: hovering the wrapper shows `reason` as an overlay. A disabled button
 *  fires no mouse events of its own, so the hover lives on the span around it.
 *  When `reason` is null (button enabled / publishing) it's a plain pass-through. */
function PublishGate({ reason, children }: { reason: string | null; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
      {reason && hover && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 60,
            width: 230,
            padding: '8px 10px',
            background: 'var(--gray-900)',
            color: '#fff',
            fontSize: 11.5,
            lineHeight: 1.45,
            textAlign: 'left',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--sh-pop)',
            pointerEvents: 'none',
          }}
        >
          {reason}
        </span>
      )}
    </span>
  );
}

export function Storyline({
  ctx,
  onBack,
}: {
  ctx: StorylineCtx;
  onBack: () => void;
}) {
  // Fresh workspaces start on ordering; an already-published one opens straight
  // on the intro step, where the "Push update" button lives.
  const [step, setStep] = useState<WizardStep>(ctx.prNumber === null ? 'order' : 'intro');
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
  // True until the committed file list (`load`) has resolved at least once.
  // Gates the "nothing committed" banner so it can't flash while the empty
  // initial `steps`/`pool` merely reflect a load still in flight (the preview
  // diff can resolve first and would otherwise trip the banner prematurely).
  const [loading, setLoading] = useState(true);
  // Unsaved edits live only in component state — leaving without Save loses them.
  // `dirty` gates a confirm on Back so the author can't silently discard work
  // (the post-create flow drops straight into composition; the saved baseline of
  // a brand-new workspace is empty). Cleared on load and after a successful save.
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

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
    } finally {
      setLoading(false);
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

  // --- Ordering (Step 1) ---
  // OrderStep computes the complete ordered storyline as a path list (add,
  // reorder, and remove are all just a new ordering). We rebuild `steps` from
  // it — preserving each kept step's intro/stale flags — and recompute the
  // leftover `pool` from the union of changed files (pool + non-stale steps).
  const setStoryline = (paths: string[]) => {
    const stepByPath = new Map(steps.map((s) => [s.path, s]));
    const changedByPath = new Map<string, ChangedFile>();
    for (const f of pool) changedByPath.set(f.path, f);
    for (const s of steps) {
      // Stale steps have no current ChangedFile, so they can't land in the pool.
      if (!s.stale && s.status !== null) {
        changedByPath.set(s.path, {
          path: s.path,
          status: s.status,
          added: s.added ?? 0,
          removed: s.removed ?? 0,
        });
      }
    }

    const newSteps: Step[] = paths.map((p) => {
      const existing = stepByPath.get(p);
      if (existing) return existing;
      const c = changedByPath.get(p);
      return {
        path: p,
        introText: '',
        status: c?.status ?? '?',
        added: c?.added ?? 0,
        removed: c?.removed ?? 0,
        stale: false,
      };
    });
    const inStory = new Set(paths);
    const newPool = [...changedByPath.values()]
      .filter((f) => !inStory.has(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));

    setSteps(newSteps);
    setPool(newPool);
    // Keep the current selection if it's still a step; otherwise focus a newly
    // added file, else the first step.
    setSelected((cur) =>
      cur && inStory.has(cur)
        ? cur
        : (paths.find((p) => !stepByPath.has(p)) ?? newSteps[0]?.path ?? null),
    );
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
  // Ready to publish: at least one step, and at least one of them carries a
  // non-empty intro (steps without an intro still publish, just without
  // commentary). When not ready, `publishBlockedReason` is the human
  // explanation shown on hover over the disabled "Open PR" button — so a no-op
  // click is never silent.
  const publishBlockedReason =
    steps.length === 0
      ? 'Add at least one step to the storyline to open a PR.'
      : withIntro === 0
        ? 'Write an intro for at least one step to open a PR.'
        : null;
  const readyToPublish = publishBlockedReason === null;
  const published = ctx.prNumber !== null;

  // Publish to GitHub. First publish (prNumber null) pushes the branch with the
  // user's own git credentials (ADR-0016) and opens/adopts the PR; a published
  // workspace just re-pushes ("Push update"). On success we leave the composer —
  // Workspaces re-fetches the overview on mount, so the row reflects the new PR.
  const publish = async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      // Persist the storyline *before* opening the PR. The composer's steps live
      // only in component state until Save; without this, an author who builds a
      // storyline and clicks Open PR (without first clicking Save) publishes a
      // workspace whose storyline is empty on the backend — so a reviewer opens
      // it to a blank walkthrough. Save here makes Publish self-contained: the
      // published workspace always carries the steps the author just ordered.
      // (`etag === null` only before the first load, when there's nothing to
      // save; the gate already requires ≥1 step to reach this button.)
      if (etag !== null) {
        const saved = await storylineUpdate(
          ctx.workspaceId,
          etag,
          steps.map((s, i) => ({
            diffFilePath: s.path,
            orderIndex: i,
            introText: s.introText,
          })),
        );
        setEtag(saved.etag);
        setDirty(false);
      }
      await workspacePublish({
        workspaceId: ctx.workspaceId,
        headRef: ctx.headRef,
        // The PR title can't be blank (backend rejects it). Fall back to the
        // branch name when the workspace has no title — same convention as the
        // New Workspace modal, which uses the branch as the title placeholder.
        title: ctx.title.trim() || ctx.headRef,
        body: null,
        alreadyPublished: published,
      });
    } catch (e) {
      // Fail loud (CLAUDE.md): surface git's / the backend's message verbatim;
      // no PR was created/updated on failure, so nothing to roll back.
      console.warn('workspace_publish_failed', e);
      setPublishError(msgOf(e));
      setPublishing(false);
      return;
    }
    // Success: the screen is unmounting, so don't touch `publishing` again.
    onBack();
  };

  // Empty list because the branch has no *committed* changes against its base,
  // even though the working tree does. The file list comes from a commit-tree
  // diff (`gitDiffFiles`), which excludes the working tree; the preview diff
  // (`diffByPath`, via `selfReviewDiff`) includes it — so a non-empty
  // `diffByPath` with an empty order/pool means "uncommitted changes only".
  // A load failure or branch mismatch (`diffError`, which empties `diffByPath`)
  // takes precedence and is surfaced by its own banner.
  const noCommittedChanges =
    !loading &&
    !loadError &&
    !diffLoading &&
    !diffError &&
    steps.length === 0 &&
    pool.length === 0 &&
    diffByPath.size > 0;

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
              <>
                <button type="button" className="btn" onClick={() => goToStep('order')}>
                  <Icon name="chevron-left" size={11} /> Back to ordering
                </button>
                {published ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={publish}
                    disabled={publishing}
                    title="Push new commits to the PR branch on GitHub"
                    style={{ opacity: publishing ? 0.6 : 1 }}
                  >
                    {publishing ? 'Pushing…' : 'Push update'}
                  </button>
                ) : (
                  // Gate: at least one step with an intro. The button stays
                  // disabled until then, but the wrapper surfaces *why* on hover
                  // — a disabled button doesn't fire its own mouse events, so the
                  // hover lives on the span around it.
                  <PublishGate reason={publishing ? null : publishBlockedReason}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={publish}
                      disabled={publishing || !readyToPublish}
                      style={{
                        opacity: publishing || !readyToPublish ? 0.5 : 1,
                        cursor: !readyToPublish && !publishing ? 'not-allowed' : undefined,
                      }}
                    >
                      {publishing ? 'Opening PR…' : 'Open PR'}
                    </button>
                  </PublishGate>
                )}
              </>
            )}
          </div>

          {(loadError || saveError || publishError || noCommittedChanges) && (
            <div style={{ padding: '10px 18px 0' }}>
              {loadError && (
                <ErrorBanner
                  title="Couldn't load storyline"
                  detail={loadError}
                  onClose={() => setLoadError(null)}
                />
              )}
              {saveError && (
                <ErrorBanner
                  title="Couldn't save storyline"
                  detail={saveError}
                  onClose={() => setSaveError(null)}
                />
              )}
              {publishError && (
                <ErrorBanner
                  title="Couldn't publish"
                  detail={publishError}
                  onClose={() => setPublishError(null)}
                />
              )}
              {noCommittedChanges && (
                <div style={infoBanner}>
                  No committed changes against <span className="mono">{ctx.baseRef}</span> yet —
                  commit your work to build the storyline. ({diffByPath.size} uncommitted change
                  {diffByPath.size === 1 ? '' : 's'} detected.)
                </div>
              )}
            </div>
          )}

          {step === 'order' ? (
            <OrderStep pool={pool} steps={steps} onSetStoryline={setStoryline} />
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
