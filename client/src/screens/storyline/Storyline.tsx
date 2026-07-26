import { useCallback, useEffect, useMemo, useState } from 'react';

import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { TitleBar } from '../../components/TitleBar';
import {
  type BaseOptions,
  type BranchInfo,
  type Review,
  type SelfReviewFileChange,
  type StorylinePreview,
  type UncommittedDisposition,
  type UncommittedFile,
  gitCurrentBranch,
  gitFetch,
  gitRemoteBranches,
  publishUncommitted,
  reviewDraftGet,
  reviewDraftSetBase,
  reviewPublish,
  selfReviewBaseOptions,
  storylinePreview,
  storylineStepAdd,
  storylineStepEdit,
  storylineStepRemove,
  storylineStepsReorder,
} from '../../tauri';
import { relativeTimeFromEpoch } from '../../time';
import { IntroStep } from './IntroStep';
import { OrderStep } from './OrderStep';
import { Stepper, type WizardStep } from './Stepper';
import { type Step, buildPool, buildSteps } from './steps';

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

/**
 * The storyline composer (design screens 4a/4b, SL-1..3, PUB-1..7): a two-step
 * wizard — **Order files** (drag-drop the changed files into a reviewer
 * storyline) then **Write intros** (per-step markdown intro with a live
 * reviewer preview) — ending in Publish (push + `gh pr create`).
 *
 * The engine owns the draft (keyed by the focused worktree's branch, ADR-0022
 * §3): steps persist per curation op (`storyline_step_*`); only **intro text**
 * is buffered locally until "Save storyline" (or Publish, which saves first).
 * The full committed diff + stale flags + un-storied overlay all come derived
 * from `storyline_preview` (ADR-0022 §7 — this screen renders, never derives).
 */
export function Storyline({ onBack }: { onBack: () => void }) {
  const [branch, setBranch] = useState('');
  const [draft, setDraft] = useState<Review | null>(null);
  const [preview, setPreview] = useState<StorylinePreview | null>(null);
  // Buffered intro edits by anchor path (unsaved until Save/Publish).
  const [buffered, setBuffered] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WizardStep>('order');
  const [remoteBranches, setRemoteBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [baseError, setBaseError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  // Base freshness + dirty-tree signals (the PR-124 guardrails): last-fetch age
  // for the toolbar widget, the background auto-fetch state, and the working
  // tree's uncommitted changes for the composer notice + publish modal.
  const [baseOptions, setBaseOptions] = useState<BaseOptions | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [uncommitted, setUncommitted] = useState<UncommittedFile[]>([]);

  const steps: Step[] = useMemo(
    () => (preview ? buildSteps(preview, buffered) : []),
    [preview, buffered],
  );
  const pool = useMemo(() => (preview ? buildPool(preview) : []), [preview]);

  const reloadPreview = useCallback(async () => {
    try {
      const pv = await storylinePreview();
      setPreview(pv);
      setSelected((cur) => {
        if (cur && pv.steps.some((s) => s.step.anchor === cur)) return cur;
        return pv.steps[0]?.step.anchor ?? null;
      });
      setLoadError(null);
    } catch (e) {
      console.warn('storyline_preview_failed', e);
      setLoadError(msgOf(e));
    }
  }, []);

  // Base freshness + working-tree signals. Non-fatal to composing, but a
  // failure still surfaces (fail loud) via the freshness banner.
  const reloadSignals = useCallback(async () => {
    const [opts, files] = await Promise.all([selfReviewBaseOptions(), publishUncommitted()]);
    setBaseOptions(opts);
    setUncommitted(files);
  }, []);

  // Refresh the remote-tracking base (`git fetch --prune` with the user's own
  // git), then re-derive everything that depends on it: the freshness widget,
  // the committed diff (and its stale flags), and the dirty-tree notice.
  // Runs automatically on entry — composing against a weeks-stale
  // `origin/<base>` is how PR #124 got 28 junk steps — and manually via the
  // toolbar Refresh. Composing is never blocked while it runs.
  const refreshBase = useCallback(async () => {
    setFetching(true);
    setFetchError(null);
    try {
      await gitFetch();
      await Promise.all([reloadSignals(), reloadPreview()]);
    } catch (e) {
      // Fail loud (CLAUDE.md): the author must know they may be composing
      // against a stale base — but they can keep composing.
      console.warn('storyline_refresh_base_failed', e);
      setFetchError(msgOf(e));
    } finally {
      setFetching(false);
    }
  }, [reloadSignals, reloadPreview]);

  // Boot: branch + draft (the composer requires one — "Ready to share" creates
  // it from the overview or Self-Review), then the preview. A published draft
  // opens straight on the intro step, where "Push update" lives. The base
  // auto-fetch kicks off in the background once the composer is usable.
  useEffect(() => {
    (async () => {
      try {
        const [b, d] = await Promise.all([gitCurrentBranch(), reviewDraftGet()]);
        setBranch(b);
        setDraft(d);
        if (d) {
          if (d.prNumber !== null) setWizard('intro');
          await Promise.all([reloadPreview(), reloadSignals()]);
          void refreshBase();
        }
      } catch (e) {
        console.warn('storyline_boot_failed', e);
        setLoadError(msgOf(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [reloadPreview, reloadSignals, refreshBase]);

  // Remote branches for the base picker (origin/*). Loaded once; a failure is
  // non-fatal — the picker still shows the current base.
  useEffect(() => {
    gitRemoteBranches()
      .then(setRemoteBranches)
      .catch((e) => console.warn('storyline_remote_branches_failed', e));
  }, []);

  // --- Ordering (Step 1) ---
  // OrderStep hands back the complete ordered path list; we turn the delta into
  // engine ops (remove / add / reorder) and reload the derived preview. Adds
  // carry any buffered intro for that path (a re-added step keeps its text).
  const setStoryline = async (paths: string[]) => {
    if (ordering) return; // engine ops are sequential; don't interleave drags
    setOrdering(true);
    setActionError(null);
    try {
      const byPath = new Map(steps.map((s) => [s.path, s]));
      const wanted = new Set(paths);
      for (const s of steps) {
        if (!wanted.has(s.path)) await storylineStepRemove(s.id);
      }
      const addedIds = new Map<string, string>();
      for (const p of paths) {
        if (!byPath.has(p)) {
          const st = await storylineStepAdd(p, null, buffered.get(p) ?? '');
          addedIds.set(p, st.id);
        }
      }
      const ids = paths
        .map((p) => byPath.get(p)?.id ?? addedIds.get(p))
        .filter((id): id is string => id !== undefined);
      await storylineStepsReorder(ids);
    } catch (e) {
      // Fail loud (CLAUDE.md): surface the engine's message; the reload below
      // re-syncs the board with whatever actually persisted.
      console.warn('storyline_order_failed', e);
      setActionError(msgOf(e));
    } finally {
      await reloadPreview();
      setOrdering(false);
    }
  };

  // --- Intro edits (Step 2) — buffered until Save/Publish ---
  const setIntro = (path: string, text: string) => {
    setBuffered((cur) => new Map(cur).set(path, text));
  };

  /** Paths whose buffered intro differs from the persisted step. */
  const dirtyPaths = useMemo(() => {
    if (!preview) return [] as string[];
    const persisted = new Map(preview.steps.map((s) => [s.step.anchor, s.step.intro]));
    return [...buffered.entries()]
      .filter(([p, text]) => persisted.has(p) && persisted.get(p) !== text)
      .map(([p]) => p);
  }, [preview, buffered]);
  const dirty = dirtyPaths.length > 0;

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    try {
      for (const p of dirtyPaths) {
        const s = steps.find((x) => x.path === p);
        if (s) await storylineStepEdit(s.id, s.title, buffered.get(p) ?? '');
      }
      setBuffered(new Map());
      await reloadPreview();
      return true;
    } catch (e) {
      // Fail loud: surface the engine message verbatim; keep the author's edits
      // (no auto-reload of the buffer — that would clobber unsaved text).
      console.warn('storyline_save_failed', e);
      setSaveError(msgOf(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Re-target the base branch (pre-publish only; GAP-2 #92). Persist, then
  // reload — the preview diff depends on the base. Once published the base is
  // the PR's merge target and the picker locks (badge).
  const changeBase = useCallback(
    async (next: string) => {
      if (!draft || next === draft.baseRef) return;
      setBaseError(null);
      try {
        const updated = await reviewDraftSetBase(next);
        setDraft(updated);
        await reloadPreview();
      } catch (e) {
        console.warn('storyline_base_change_failed', e);
        setBaseError(msgOf(e));
      }
    },
    [draft, reloadPreview],
  );

  const goToStep = (next: WizardStep) => {
    if (next === 'intro') {
      // Land on a concrete step so the editor isn't empty.
      setSelected((cur) =>
        cur && steps.some((s) => s.path === cur) ? cur : (steps[0]?.path ?? null),
      );
    }
    setWizard(next);
  };

  const back = () => (dirty ? setLeaving(true) : onBack());

  const withIntro = useMemo(
    () => steps.filter((s) => s.introText.trim().length > 0).length,
    [steps],
  );
  // The publish gate (PUB-2 #73 + the ST-1 stale rule, mirrored from the
  // engine — and re-enforced there at publish): ≥1 step, no stale step, every
  // step with an intro. A stale step narrates code the PR wouldn't contain, so
  // there is no override — the author removes or re-anchors it (CONTEXT.md
  // *Ready to publish*). Buffered (unsaved) intros count — Publish saves first.
  const staleCount = useMemo(() => steps.filter((s) => s.stale).length, [steps]);
  const publishBlockedReason =
    steps.length === 0
      ? 'Add at least one step to the storyline to open a PR.'
      : staleCount > 0
        ? `${staleCount} step${staleCount === 1 ? ' is' : 's are'} stale — the anchored file${staleCount === 1 ? ' is' : 's are'} no longer part of this change. Remove or re-anchor ${staleCount === 1 ? 'it' : 'them'} first.`
        : withIntro < steps.length
          ? `${steps.length - withIntro} step${steps.length - withIntro === 1 ? '' : 's'} still need an intro.`
          : null;
  const readyToPublish = publishBlockedReason === null;
  const published = draft !== null && draft.prNumber !== null;

  const fileFor = useCallback(
    (path: string): SelfReviewFileChange | null =>
      preview?.diff.files.find((f) => f.path === path) ?? null,
    [preview],
  );

  // The branch has no committed changes against its base — an empty order/pool
  // genuinely means there is nothing to compose over yet (a load failure takes
  // precedence via its own banner).
  const noCommittedChanges =
    !loading && !loadError && preview !== null && steps.length === 0 && pool.length === 0;

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title={`Stage — Open pull request · ${branch}`} />
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
              <Icon name="chevron-left" size={10} color="var(--gray-700)" /> Reviews
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              {published ? (
                // The base is the open PR's merge target — locked here.
                <span
                  className="badge mono"
                  style={{ background: 'rgba(0,0,0,0.06)' }}
                  title="Base is locked once the PR is open"
                >
                  {draft?.baseRef}
                </span>
              ) : (
                <select
                  className="input mono"
                  aria-label="Base branch"
                  title="Branch to compare against and open the PR into"
                  value={draft?.baseRef ?? ''}
                  onChange={(e) => changeBase(e.target.value)}
                  style={{ height: 24, padding: '0 4px', fontSize: 11.5, maxWidth: 220 }}
                >
                  {(() => {
                    // origin/* only — a base that isn't on the remote can't be
                    // a PR target. Stored remote-tracking (`origin/<name>`);
                    // Publish strips the prefix for gh.
                    const seen = new Set<string>();
                    const opts: string[] = [];
                    const push = (value: string) => {
                      if (!value || seen.has(value)) return;
                      seen.add(value);
                      opts.push(value);
                    };
                    for (const b of remoteBranches)
                      push(b.name.startsWith('origin/') ? b.name : `origin/${b.name}`);
                    if (draft) push(draft.baseRef);
                    return opts.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ));
                  })()}
                </select>
              )}
              <Icon name="arrow-right" size={11} color="var(--gray-400)" />
              <span
                className="badge mono"
                style={{ background: 'var(--blue-tint)', color: 'var(--blue-press)' }}
              >
                {branch}
              </span>
              <ComposerFreshness
                baseOptions={baseOptions}
                fetching={fetching}
                onRefresh={refreshBase}
              />
            </div>
            {draft?.title && (
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
                {draft.title}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <Stepper current={wizard} onJump={goToStep} />
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
              {wizard === 'order'
                ? `${steps.length} of ${steps.length + pool.length} ordered`
                : `${withIntro} of ${steps.length} with intros`}
            </span>
            <button
              type="button"
              className="btn"
              onClick={save}
              disabled={saving || !dirty}
              style={{ opacity: saving || !dirty ? 0.6 : 1 }}
            >
              {saving ? 'Saving…' : 'Save storyline'}
            </button>
            {wizard === 'order' ? (
              <button type="button" className="btn btn-primary" onClick={() => goToStep('intro')}>
                Next: Write intros <Icon name="chevron-right" size={11} color="#fff" />
              </button>
            ) : (
              <>
                <button type="button" className="btn" onClick={() => goToStep('order')}>
                  <Icon name="chevron-left" size={11} /> Back to ordering
                </button>
                {/* Gate: every step needs an intro (PUB-2). The button stays
                    disabled until then, but the wrapper surfaces *why* on hover
                    — a disabled button doesn't fire its own mouse events, so
                    the hover lives on the span around it. */}
                <PublishGate reason={publishBlockedReason}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setPublishOpen(true)}
                    disabled={!readyToPublish}
                    style={{
                      opacity: readyToPublish ? 1 : 0.5,
                      cursor: !readyToPublish ? 'not-allowed' : undefined,
                    }}
                  >
                    {published ? `Push update to #${draft?.prNumber}` : 'Open PR'}
                  </button>
                </PublishGate>
              </>
            )}
          </div>

          {(loadError ||
            actionError ||
            saveError ||
            baseError ||
            fetchError ||
            noCommittedChanges ||
            uncommitted.length > 0) && (
            <div style={{ padding: '10px 18px 0' }}>
              {loadError && (
                <ErrorBanner
                  title="Couldn't load storyline"
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
              {saveError && (
                <ErrorBanner
                  title="Couldn't save storyline"
                  detail={saveError}
                  onClose={() => setSaveError(null)}
                />
              )}
              {baseError && (
                <ErrorBanner
                  title="Couldn't change base branch"
                  detail={baseError}
                  onClose={() => setBaseError(null)}
                />
              )}
              {fetchError && (
                <ErrorBanner
                  title="Couldn't refresh origin — the base may be stale"
                  detail={fetchError}
                  onClose={() => setFetchError(null)}
                />
              )}
              {uncommitted.length > 0 && (
                // Softer, non-gating counterpart of the publish gate: composing
                // works against the committed diff, so uncommitted work simply
                // isn't in the storyline. Publish is where it hard-gates.
                <div style={infoBanner}>
                  {uncommitted.length} uncommitted change
                  {uncommitted.length === 1 ? ' isn’t' : 's aren’t'} part of this storyline — commit
                  first if {uncommitted.length === 1 ? 'it belongs' : 'they belong'} in this change.
                </div>
              )}
              {noCommittedChanges && (
                <div style={infoBanner}>
                  <span className="mono">{branch}</span> has no committed changes against{' '}
                  <span className="mono">{draft?.baseRef}</span> yet — commit your branch to build
                  the storyline.
                </div>
              )}
            </div>
          )}

          {loading ? (
            <div style={{ padding: '18px 16px', fontSize: 12, color: 'var(--gray-500)' }}>
              Loading…
            </div>
          ) : !draft ? (
            <div style={{ padding: '24px 18px', fontSize: 12.5, color: 'var(--gray-600)' }}>
              No review draft exists for <span className="mono">{branch}</span> — mark it{' '}
              <strong>Ready to share</strong> from the overview (or Self-Review) first.
            </div>
          ) : wizard === 'order' ? (
            <OrderStep pool={pool} steps={steps} onSetStoryline={setStoryline} />
          ) : (
            <IntroStep
              steps={steps}
              selectedPath={selected}
              onSelectPath={setSelected}
              onSetIntro={setIntro}
              getFile={fileFor}
              diffLoading={loading}
              diffError={loadError}
            />
          )}
        </div>
      </div>

      {publishOpen && draft && (
        <PublishModal
          draft={draft}
          branch={branch}
          published={published}
          initialUncommitted={uncommitted}
          saveDirty={save}
          onClose={() => setPublishOpen(false)}
          onPublished={onBack}
        />
      )}

      {leaving && (
        // Unsaved-intros guard: step curation persists immediately, but intro
        // text is buffered — leaving without Save would lose it.
        // biome-ignore lint/a11y/useSemanticElements: overlay modal, role="dialog" matches the existing modal pattern rather than a native <dialog>.
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
              Your unsaved intro edits will be lost.
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

/** Base freshness in the composer toolbar: the last `git fetch` age plus a
 *  manual Refresh. The composed diff is computed against `origin/<base>`, so a
 *  stale fetch means composing against code the PR won't contain (the PR-124
 *  junk-step failure). An auto-fetch runs on entry; this keeps long composing
 *  sessions honest. */
function ComposerFreshness({
  baseOptions,
  fetching,
  onRefresh,
}: {
  baseOptions: BaseOptions | null;
  fetching: boolean;
  onRefresh: () => void;
}) {
  if (!baseOptions) return null;
  const fetched = baseOptions.lastFetchSecs
    ? `fetched ${relativeTimeFromEpoch(baseOptions.lastFetchSecs)}`
    : 'never fetched';
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, flexShrink: 0 }}>
      <span style={{ color: 'var(--gray-500)' }}>{fetched}</span>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={onRefresh}
        disabled={fetching}
        style={{ padding: '0 6px', opacity: fetching ? 0.5 : 1 }}
        title="git fetch --prune"
      >
        {fetching ? 'Refreshing…' : 'Refresh'}
      </button>
    </span>
  );
}

// Strong amber warning block for the publish modal's uncommitted-work gate —
// interruptive by design, unlike `infoBanner` (the composer's soft notice).
const warnBox: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--gray-900)',
  background: 'rgba(255,149,0,0.08)',
  border: '1px solid rgba(255,149,0,0.35)',
  borderRadius: 'var(--r-sm)',
  padding: '10px 12px',
  marginBottom: 14,
};

/**
 * Publish confirmation (PUB-1..7 #72–78): PR title + markdown description
 * become the GitHub PR's title/body — distinct from the Review title, which
 * stays Stage's internal label. Publish saves any buffered intros first, then
 * serializes the draft into `.stage/<branch>/`, pushes with the user's own git
 * credentials, and opens/updates the PR via `gh` (ADR-0022 §3). On success the
 * composer closes back to the overview, which re-fetches and shows the PR row.
 *
 * **Uncommitted-work gate (ADR-0024):** when the working tree is dirty the
 * modal warns strongly, lists every affected path, and requires an explicit
 * per-publish disposition — commit everything (the primary fix; Stage's one
 * code commit, message pre-filled from the PR title) or publish without the
 * changes (de-emphasized). The engine enforces the same rule, so the modal is
 * only the renderer of the choice.
 */
function PublishModal({
  draft,
  branch,
  published,
  initialUncommitted,
  saveDirty,
  onClose,
  onPublished,
}: {
  draft: Review;
  branch: string;
  published: boolean;
  /** The composer's last-known uncommitted changes; re-checked on mount. */
  initialUncommitted: UncommittedFile[];
  /** Persist any buffered intro edits; resolves false on failure (abort). */
  saveDirty: () => Promise<boolean>;
  onClose: () => void;
  onPublished: () => void;
}) {
  const [prTitle, setPrTitle] = useState(draft.title.trim() || branch);
  const [prBody, setPrBody] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncommitted, setUncommitted] = useState<UncommittedFile[]>(initialUncommitted);
  const [choice, setChoice] = useState<'commitAll' | 'publishWithout'>('commitAll');
  // `null` = untouched → the commit message follows the PR title live.
  const [commitMessage, setCommitMessage] = useState<string | null>(null);

  // Re-check on open: the composer's snapshot may predate recent edits. A
  // failure surfaces in the modal's banner (the engine re-enforces the gate
  // regardless, so publishing stays safe either way).
  useEffect(() => {
    publishUncommitted()
      .then(setUncommitted)
      .catch((e) => {
        console.warn('publish_uncommitted_failed', e);
        setError(msgOf(e));
      });
  }, []);

  const dirty = uncommitted.length > 0;
  const effectiveMessage = (commitMessage ?? prTitle).trim();
  const commitAllChosen = dirty && choice === 'commitAll';

  const publish = async () => {
    setPublishing(true);
    setError(null);
    try {
      // Persist buffered intros *before* publishing, so the serialized
      // `.stage` always carries the text the author just wrote.
      if (!(await saveDirty())) {
        setError('Saving the storyline failed — fix that first, then publish.');
        return;
      }
      // The disposition is per-publish and explicit (ADR-0024): only sent when
      // the tree is dirty; a clean tree publishes with none.
      const disposition: UncommittedDisposition | null = !dirty
        ? null
        : choice === 'commitAll'
          ? { kind: 'commitAll', message: effectiveMessage }
          : { kind: 'publishWithout' };
      await reviewPublish({
        prTitle: prTitle.trim() || branch,
        prBody,
        baseRef: null,
        reviewers: [],
        labels: [],
        uncommitted: disposition,
      });
    } catch (e) {
      // Fail loud (CLAUDE.md): surface git's / gh's message verbatim; nothing
      // was rolled back — re-publishing after a fix is the normal path.
      console.warn('review_publish_failed', e);
      setError(msgOf(e));
      return;
    } finally {
      setPublishing(false);
    }
    onPublished();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: overlay modal, role="dialog" matches the existing modal pattern rather than a native <dialog>.
    <div
      role="dialog"
      aria-modal="true"
      aria-label={published ? 'Push update' : 'Open pull request'}
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
        if (e.target === e.currentTarget && !publishing) onClose();
      }}
    >
      <div
        style={{
          width: 460,
          background: '#fff',
          borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--sh-pop)',
          padding: 18,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--gray-900)', marginBottom: 6 }}>
          {published ? `Push update to #${draft.prNumber}` : 'Open pull request'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--gray-600)', marginBottom: 14, lineHeight: 1.5 }}>
          Stage writes the storyline into <span className="mono">.stage/{branch}/</span>, commits,
          pushes <span className="mono">{branch}</span> with your own git credentials, and{' '}
          {published ? 'updates the PR' : 'opens the PR'} via your local{' '}
          <span className="mono">gh</span>.
        </div>

        <label
          htmlFor="publish-title"
          style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gray-600)' }}
        >
          PR title
        </label>
        <input
          id="publish-title"
          className="input"
          value={prTitle}
          onChange={(e) => setPrTitle(e.target.value)}
          style={{ display: 'block', width: '100%', margin: '4px 0 12px' }}
        />

        <label
          htmlFor="publish-body"
          style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gray-600)' }}
        >
          PR description{' '}
          <span style={{ fontWeight: 400, color: 'var(--gray-500)' }}>(markdown)</span>
        </label>
        <textarea
          id="publish-body"
          className="input"
          value={prBody}
          onChange={(e) => setPrBody(e.target.value)}
          rows={5}
          placeholder="What this change does and why."
          style={{
            display: 'block',
            width: '100%',
            margin: '4px 0 14px',
            resize: 'vertical',
            fontFamily: 'inherit',
          }}
        />

        {dirty && (
          <div style={warnBox} role="alert">
            <div style={{ fontWeight: 700, color: 'var(--orange)', marginBottom: 6 }}>
              {uncommitted.length} uncommitted change{uncommitted.length === 1 ? '' : 's'}{' '}
              {uncommitted.length === 1 ? 'is' : 'are'} not part of this PR
            </div>
            <ul
              className="mono"
              style={{
                listStyle: 'none',
                margin: '0 0 10px',
                padding: '6px 8px',
                maxHeight: 110,
                overflowY: 'auto',
                background: 'rgba(255,255,255,0.6)',
                borderRadius: 'var(--r-sm)',
                fontSize: 11,
              }}
            >
              {uncommitted.map((f) => (
                <li key={f.path} style={{ display: 'flex', gap: 8, lineHeight: 1.7 }}>
                  <span style={{ color: 'var(--gray-500)', width: 58, flexShrink: 0 }}>
                    {f.state}
                  </span>
                  <span
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {f.path}
                  </span>
                </li>
              ))}
            </ul>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
              <input
                type="radio"
                name="uncommitted-choice"
                checked={choice === 'commitAll'}
                onChange={() => setChoice('commitAll')}
                style={{ marginTop: 2 }}
              />
              <span>
                <strong>Commit everything and publish</strong> — all listed changes join the PR in
                one commit.
              </span>
            </label>
            {choice === 'commitAll' && (
              <input
                className="input"
                aria-label="Commit message"
                value={commitMessage ?? prTitle}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Commit message"
                style={{ display: 'block', width: '100%', margin: '0 0 8px 22px', maxWidth: 380 }}
              />
            )}
            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                color: 'var(--gray-600)',
              }}
            >
              <input
                type="radio"
                name="uncommitted-choice"
                checked={choice === 'publishWithout'}
                onChange={() => setChoice('publishWithout')}
                style={{ marginTop: 2 }}
              />
              <span>
                Publish without these changes — the listed files stay local and out of the PR.
              </span>
            </label>
          </div>
        )}

        {error && (
          <div style={{ marginBottom: 12 }}>
            <ErrorBanner title="Couldn't publish" detail={error} onClose={() => setError(null)} />
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose} disabled={publishing}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={publish}
            disabled={
              publishing ||
              prTitle.trim().length === 0 ||
              (commitAllChosen && effectiveMessage.length === 0)
            }
            style={{ opacity: publishing ? 0.6 : 1 }}
            title={
              commitAllChosen && effectiveMessage.length === 0
                ? 'Write a commit message first'
                : undefined
            }
          >
            {publishing
              ? published
                ? 'Pushing…'
                : 'Opening PR…'
              : commitAllChosen
                ? published
                  ? 'Commit all & push update'
                  : 'Commit all & open PR'
                : published
                  ? 'Push update'
                  : 'Open PR'}
          </button>
        </div>
      </div>
    </div>
  );
}
