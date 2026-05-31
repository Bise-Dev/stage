import { useCallback, useEffect, useMemo, useState } from 'react';

import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { TitleBar } from '../../components/TitleBar';
import { type ChangedFile, gitDiffFiles, storylineGet, storylineUpdate } from '../../tauri';
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
  const [steps, setSteps] = useState<Step[]>([]);
  const [pool, setPool] = useState<ChangedFile[]>([]);
  const [etag, setEtag] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
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

  useEffect(() => {
    load();
  }, [load]);

  const addStep = (path: string) => {
    const c = pool.find((f) => f.path === path);
    if (!c) return;
    setPool((p) => p.filter((f) => f.path !== path));
    setSteps((s) => [
      ...s,
      {
        path: c.path,
        introText: '',
        status: c.status,
        added: c.added,
        removed: c.removed,
        stale: false,
      },
    ]);
    setSelected(path);
    setDirty(true);
  };

  const removeStep = (path: string) => {
    const step = steps.find((s) => s.path === path);
    setSteps((s) => s.filter((x) => x.path !== path));
    // Non-stale steps return to the pool; stale ones have no ChangedFile to restore.
    if (step && !step.stale) {
      setPool((p) =>
        [
          ...p,
          {
            path: step.path,
            status: step.status ?? '?',
            added: step.added ?? 0,
            removed: step.removed ?? 0,
          },
        ].sort((a, b) => a.path.localeCompare(b.path)),
      );
    }
    setSelected((cur) => (cur === path ? null : cur));
    setDirty(true);
  };

  const move = (idx: number, delta: number) => {
    const j = idx + delta;
    if (j < 0 || j >= steps.length) return;
    setSteps((s) => {
      const next = [...s];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
    setDirty(true);
  };

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
      // (no auto-reload — that would clobber the edits that lost the race). The
      // 409 conflict path is effectively unreachable in v1 (single author, single
      // client, pre-publish) — kept for the post-publish multi-writer future.
      // Known wart: on etag_mismatch the backend puts a bare code in `message`,
      // so that (dead-in-v1) path shows `etag_mismatch` in the banner until the
      // base-branch gap is fixed. workspace_frozen and other errors carry human text.
      console.warn('storyline_save_failed', e);
      setSaveError(msgOf(e));
    } finally {
      setSaving(false);
    }
  };

  const back = () => (dirty ? setLeaving(true) : onBack());

  const withIntro = useMemo(
    () => steps.filter((s) => s.introText.trim().length > 0).length,
    [steps],
  );
  const selectedStep = steps.find((s) => s.path === selected) ?? null;

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title={`Stage — Storyline · ${ctx.headRef}`} />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 18px',
              borderBottom: '1px solid var(--hairline)',
            }}
          >
            <button type="button" className="btn" onClick={back}>
              <Icon name="chevron-left" size={10} color="var(--gray-700)" /> Workspaces
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: 'var(--gray-900)',
                }}
              >
                {ctx.title || ctx.headRef}
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--gray-500)' }}>
                {ctx.baseRef} → {ctx.headRef}
              </div>
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
              {withIntro} of {steps.length} steps have intros
            </span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={save}
              disabled={saving || etag === null}
              style={{ opacity: saving ? 0.6 : 1 }}
            >
              {saving ? 'Saving…' : 'Save storyline'}
            </button>
          </div>

          <div style={{ padding: '10px 18px 0' }}>
            {loadError && <div style={banner}>Couldn't load storyline: {loadError}</div>}
            {saveError && <div style={banner}>Couldn't save storyline: {saveError}</div>}
          </div>

          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            {/* LEFT: pool + ordered steps */}
            <div
              style={{
                width: 320,
                flex: '0 0 320px',
                borderRight: '1px solid var(--hairline)',
                overflow: 'auto',
                padding: '12px 14px',
              }}
            >
              <div className="section-label">Changed files ({pool.length})</div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  marginBottom: 16,
                }}
              >
                {pool.length === 0 && (
                  <div style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
                    All changed files are in the storyline.
                  </div>
                )}
                {pool.map((f) => (
                  <div key={f.path} style={rowShell()}>
                    <span className="badge" style={{ flex: '0 0 auto' }}>
                      {f.status}
                    </span>
                    <span className="mono" style={ellipsis}>
                      {f.path}
                    </span>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => addStep(f.path)}
                    >
                      <Icon name="plus" size={10} color="#fff" /> Add
                    </button>
                  </div>
                ))}
              </div>

              <div className="section-label">Storyline ({steps.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {steps.length === 0 && (
                  <div style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
                    Add files above to build the storyline.
                  </div>
                )}
                {steps.map((s, i) => (
                  <div
                    key={s.path}
                    // biome-ignore lint/a11y/useSemanticElements: row contains its own ▲▼× action buttons, so it can't be a <button> (nested buttons are invalid); div+role=button with onKeyDown is the accessible alternative
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelected(s.path)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(s.path);
                      }
                    }}
                    style={{
                      ...rowShell(),
                      cursor: 'default',
                      textAlign: 'left',
                      outline: selected === s.path ? '2px solid var(--blue)' : 'none',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: 'var(--gray-500)',
                        flex: '0 0 auto',
                      }}
                    >
                      {i + 1}
                    </span>
                    <span
                      title={s.introText.trim() ? 'has intro' : 'no intro yet'}
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 4,
                        flex: '0 0 auto',
                        background: s.introText.trim() ? 'var(--green)' : 'var(--gray-300)',
                      }}
                    />
                    <span className="mono" style={ellipsis}>
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
                    <span style={{ display: 'flex', gap: 2, flex: '0 0 auto' }}>
                      <button
                        type="button"
                        aria-label="Move up"
                        className="btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          move(i, -1);
                        }}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        aria-label="Move down"
                        className="btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          move(i, 1);
                        }}
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        aria-label="Remove step"
                        className="btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeStep(s.path);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* MAIN: editor + preview */}
            <div
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'auto',
                padding: '14px 18px',
              }}
            >
              {!selectedStep && (
                <div style={{ fontSize: 12.5, color: 'var(--gray-500)' }}>
                  Select a step to write its intro.
                </div>
              )}
              {selectedStep && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="badge">{selectedStep.status ?? '—'}</span>
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
                      {selectedStep.path}
                    </span>
                    {selectedStep.added !== null && selectedStep.removed !== null && (
                      <span style={{ fontSize: 11 }}>
                        <span style={{ color: 'var(--green-d)' }}>+{selectedStep.added}</span>{' '}
                        <span style={{ color: 'var(--red-d)' }}>−{selectedStep.removed}</span>
                      </span>
                    )}
                  </div>
                  <div className="section-label">Intro for reviewers (markdown)</div>
                  <div
                    style={{
                      display: 'flex',
                      gap: 2,
                      borderBottom: '1px solid var(--hairline)',
                    }}
                  >
                    {(['write', 'preview'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setMode(m)}
                        style={{
                          background: 'none',
                          border: 'none',
                          borderBottom:
                            mode === m ? '2px solid var(--blue)' : '2px solid transparent',
                          padding: '4px 10px',
                          marginBottom: -1,
                          fontFamily: 'inherit',
                          fontSize: 12,
                          fontWeight: mode === m ? 600 : 500,
                          color: mode === m ? 'var(--gray-900)' : 'var(--gray-500)',
                          cursor: 'default',
                        }}
                      >
                        {m === 'write' ? 'Write' : 'Preview'}
                      </button>
                    ))}
                  </div>
                  {mode === 'write' ? (
                    <textarea
                      className="input"
                      value={selectedStep.introText}
                      onChange={(e) => setIntro(selectedStep.path, e.target.value)}
                      placeholder="Why this file matters, what to look at first…"
                      style={{
                        width: '100%',
                        minHeight: 160,
                        fontFamily: 'inherit',
                        resize: 'vertical',
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        border: '1px solid var(--hairline)',
                        borderRadius: 'var(--r-md)',
                        padding: '10px 12px',
                        minHeight: 160,
                        background: '#fff',
                      }}
                    >
                      {selectedStep.introText.trim() ? (
                        <Markdown>{selectedStep.introText}</Markdown>
                      ) : (
                        <span style={{ fontSize: 11.5, color: 'var(--gray-400)' }}>
                          Nothing to preview yet.
                        </span>
                      )}
                    </div>
                  )}
                  {/* Per-file diff renders here in a later slice. */}
                </div>
              )}
            </div>
          </div>
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
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--gray-900)',
                marginBottom: 8,
              }}
            >
              Leave without saving?
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: 'var(--gray-600)',
                marginBottom: 16,
              }}
            >
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

const ellipsis: React.CSSProperties = {
  flex: 1,
  fontSize: 12,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

function rowShell(): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: '#fff',
    border: '1px solid var(--hairline)',
    borderRadius: 'var(--r-md)',
    padding: '6px 8px',
    boxShadow: 'var(--sh-1)',
    minWidth: 0,
  };
}
