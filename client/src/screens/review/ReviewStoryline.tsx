import { DiffModeEnum, DiffView } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Avatar } from '../../components/Avatar';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { TitleBar } from '../../components/TitleBar';
import { RELOAD } from '../../lib/shortcuts';
import { useShortcut } from '../../lib/useShortcut';
import {
  type FileStatus,
  type GithubPrFile,
  type ReviewCtx,
  type SelfReviewFileChange,
  type Storyline,
  type StorylineFile,
  type WorkspaceState,
  prFileDiff,
  storylineGet,
} from '../../tauri';
import { inferDiffLanguage } from '../selfReview/markdown';

const STATES: Record<WorkspaceState, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: '' },
  ready_to_publish: { label: 'Ready to publish', cls: 'badge-blue' },
  in_review: { label: 'In review', cls: 'badge-blue' },
  changes_requested: { label: 'Changes requested', cls: 'badge-orange' },
  approved: { label: 'Approved', cls: 'badge-green' },
  frozen: { label: 'Frozen', cls: '' },
};

const STATUS_BADGE: Record<FileStatus, { label: string; cls: string }> = {
  added: { label: 'added', cls: 'badge-green' },
  modified: { label: 'modified', cls: 'badge-orange' },
  deleted: { label: 'deleted', cls: 'badge-red' },
  renamed: { label: 'renamed', cls: 'badge-purple' },
};

const banner: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--red-d)',
  background: 'rgba(255,59,48,0.08)',
  border: '1px solid rgba(255,59,48,0.20)',
  borderRadius: 'var(--r-sm)',
  padding: '6px 10px',
};

function msgOf(e: unknown): string {
  return typeof e === 'object' && e !== null && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Map the raw GitHub file object the backend proxies into the shape the diff
 *  renderer expects. GitHub's `status` vocabulary (`removed`) differs from the
 *  renderer's (`deleted`); `patch` is absent for binary/oversize files, which
 *  we surface as "no textual diff" rather than fabricating one (fail-loud). */
function toFileChange(f: GithubPrFile): SelfReviewFileChange {
  const status =
    f.status === 'added'
      ? 'added'
      : f.status === 'removed'
        ? 'deleted'
        : f.status === 'renamed'
          ? 'renamed'
          : 'modified';
  const patch = f.patch ?? '';
  return {
    path: f.filename,
    oldPath: f.previous_filename ?? null,
    status,
    additions: f.additions,
    deletions: f.deletions,
    patch,
    // No patch from GitHub = binary or too large to inline; there's no textual
    // diff to render either way.
    isBinary: patch.length === 0,
    isTruncated: false,
  };
}

/**
 * Step 2 — read-only reviewer storyline viewer. A reviewer opens a *published*
 * workspace authored by someone else and walks the author's ordered steps: each
 * step shows the author's intro (rendered Markdown) above that file's diff,
 * fetched from the PR on GitHub via the backend (ADR-0001 — the reviewer may
 * never have had the branch locally). Stale steps (the file is no longer in the
 * PR) are flagged instead of fetched. Refresh re-pulls the latest storyline +
 * diffs (MVP propagation; no webhooks).
 *
 * No write affordances: posting comments / reviews / intro replies are Steps
 * 3–5. The author's composer (ordering, intro editing, Save, Publish) is never
 * reachable here — that's why this is a dedicated screen rather than a mode flag
 * on the author's `Storyline.tsx`.
 */
export function ReviewStoryline({
  ctx,
  onBack,
}: {
  ctx: ReviewCtx;
  onBack: () => void;
}) {
  const [steps, setSteps] = useState<StorylineFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Per-path GitHub diff, resolved lazily as steps are visited. Cleared on
  // Refresh so the next visit re-pulls against the latest PR head.
  const [diffCache, setDiffCache] = useState<Map<string, SelfReviewFileChange>>(new Map());
  const [diffErrors, setDiffErrors] = useState<Map<string, string>>(new Map());
  const [diffLoading, setDiffLoading] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const storyline: Storyline = await storylineGet(ctx.workspaceId);
      setSteps(storyline.files);
      setSelected((cur) =>
        cur && storyline.files.some((s) => s.diff_file_path === cur)
          ? cur
          : (storyline.files[0]?.diff_file_path ?? null),
      );
    } catch (e) {
      // Fail loud (CLAUDE.md): surface the backend message; no empty-state
      // fallback that would read as "this workspace has no storyline".
      console.warn('review_storyline_load_failed', e);
      setLoadError(msgOf(e));
    } finally {
      setLoading(false);
    }
  }, [ctx.workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  const idx = steps.findIndex((s) => s.diff_file_path === selected);
  const step = idx === -1 ? null : steps[idx];

  // Fetch the selected step's diff from GitHub (once; cached). Stale steps point
  // at a file no longer in the PR, so skip the fetch — it would 404 — and let
  // the center pane render the stale flag instead.
  useEffect(() => {
    if (!step || step.stale) return;
    const path = step.diff_file_path;
    if (diffCache.has(path) || diffErrors.has(path)) return;
    let cancelled = false;
    setDiffLoading(path);
    (async () => {
      try {
        const file = await prFileDiff(ctx.owner, ctx.repo, ctx.prNumber, path);
        if (cancelled) return;
        setDiffCache((m) => new Map(m).set(path, toFileChange(file)));
      } catch (e) {
        if (cancelled) return;
        // Fail loud (CLAUDE.md): a diff fetch failure is surfaced in the diff
        // pane verbatim, never masked as an empty diff.
        console.warn('review_step_diff_failed', e);
        setDiffErrors((m) => new Map(m).set(path, msgOf(e)));
      } finally {
        if (!cancelled) setDiffLoading((cur) => (cur === path ? null : cur));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, diffCache, diffErrors, ctx.owner, ctx.repo, ctx.prNumber]);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    // Drop cached diffs so visited steps re-pull against the latest PR head.
    setDiffCache(new Map());
    setDiffErrors(new Map());
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, load]);

  // ⌘R / Ctrl+R re-pulls the storyline + diffs — same reload convention the
  // rest of the app uses (ADR-0015). The hook preventDefaults the webview's
  // native reload; refresh guards its own re-entry.
  useShortcut(RELOAD, refresh);

  const goto = (i: number) => {
    if (i >= 0 && i < steps.length) setSelected(steps[i].diff_file_path);
  };

  const st = STATES[ctx.state];
  const fileCount = steps.length;

  return (
    <div className="stage">
      <div className="win">
        <TitleBar
          title={`Stage — Reviewing ${ctx.headRef}${
            fileCount > 0 && idx !== -1 ? ` · ${idx + 1} / ${fileCount}` : ''
          }`}
        />

        {/* Subheader: PR context */}
        <div
          style={{
            flex: '0 0 56px',
            padding: '8px 16px',
            background: '#fff',
            borderBottom: '1px solid var(--hairline)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <button type="button" className="btn" onClick={onBack} style={{ flex: '0 0 auto' }}>
            <Icon name="chevron-left" size={11} color="var(--gray-700)" /> Workspaces
          </button>
          <Avatar name={ctx.author} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--gray-900)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: '0 1 auto',
                }}
              >
                {ctx.title || ctx.headRef}
              </span>
              <span className={`badge ${st.cls}`} style={{ flex: '0 0 auto' }}>
                {st.label}
              </span>
              <span
                className="badge"
                style={{
                  background: 'rgba(0,0,0,0.06)',
                  flex: '0 0 auto',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                }}
              >
                <Icon name="gh" size={9} color="var(--gray-700)" /> PR #{ctx.prNumber}
              </span>
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--gray-500)',
                marginTop: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}
            >
              {ctx.author} · <span className="mono">{ctx.headRef}</span>
              <Icon name="arrow-right" size={10} color="var(--gray-400)" />
              <span className="mono">{ctx.baseRef}</span>
              {fileCount > 0 && <span>· {fileCount} steps</span>}
              {ctx.added !== null && ctx.removed !== null && (
                <span>
                  · <span style={{ color: 'var(--green-d)' }}>+{ctx.added}</span>{' '}
                  <span style={{ color: 'var(--red-d)' }}>−{ctx.removed}</span>
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            className="btn"
            onClick={refresh}
            disabled={refreshing}
            title="Re-pull the storyline and diffs from GitHub"
            style={{ flex: '0 0 auto', opacity: refreshing ? 0.6 : 1 }}
          >
            <Icon name="branch" size={11} color="var(--gray-700)" />{' '}
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {loadError && (
          <div style={{ padding: '10px 16px 0' }}>
            <ErrorBanner
              title="Couldn't load storyline"
              detail={loadError}
              onClose={() => setLoadError(null)}
            />
          </div>
        )}

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Storyline outline with vertical timeline line */}
          <StorylineRail
            steps={steps}
            focusIdx={idx}
            loading={loading}
            onSelect={(p) => setSelected(p)}
          />

          {/* Center */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              background: 'var(--gray-50)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {!step ? (
              <div style={{ padding: 24, fontSize: 12.5, color: 'var(--gray-500)' }}>
                {loading
                  ? 'Loading storyline…'
                  : loadError
                    ? 'Couldn’t load this storyline.'
                    : 'This storyline has no steps yet.'}
              </div>
            ) : (
              <>
                <StepHeader
                  step={step}
                  n={idx + 1}
                  author={ctx.author}
                  file={diffCache.get(step.diff_file_path) ?? null}
                />

                <div style={{ flex: 1, overflow: 'auto', padding: '12px 22px' }}>
                  {step.stale ? (
                    <div
                      style={{
                        ...banner,
                        color: '#b56500',
                        background: 'rgba(255,149,0,0.08)',
                        border: '1px solid rgba(255,149,0,0.22)',
                      }}
                    >
                      This step is stale —{' '}
                      {step.stale_reason ?? 'the file is no longer part of this PR'}. There's no
                      current diff to show.
                    </div>
                  ) : (
                    <StepDiff
                      file={diffCache.get(step.diff_file_path) ?? null}
                      loading={diffLoading === step.diff_file_path}
                      error={diffErrors.get(step.diff_file_path) ?? null}
                    />
                  )}
                </div>

                {/* Footer: prev / progress / next */}
                <div
                  style={{
                    flex: '0 0 52px',
                    padding: '0 22px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    background: '#fff',
                    borderTop: '1px solid var(--hairline)',
                  }}
                >
                  <button
                    type="button"
                    className="btn"
                    onClick={() => goto(idx - 1)}
                    disabled={idx <= 0}
                    style={{ opacity: idx <= 0 ? 0.4 : 1 }}
                  >
                    <Icon name="chevron-left" size={12} /> Prev
                  </button>
                  <div
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '0 12px',
                    }}
                  >
                    {steps.map((s, i) => (
                      <div
                        key={s.id}
                        style={{
                          flex: 1,
                          height: 3,
                          borderRadius: 2,
                          background:
                            i < idx
                              ? 'var(--green-d)'
                              : i === idx
                                ? 'var(--blue)'
                                : 'rgba(0,0,0,0.10)',
                        }}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => goto(idx + 1)}
                    disabled={idx >= steps.length - 1}
                    style={{ opacity: idx >= steps.length - 1 ? 0.4 : 1 }}
                  >
                    Next <Icon name="chevron-right" size={12} color="#fff" />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Left rail: the author's ordered steps as a vertical timeline (design screen
 *  4). Steps before the focused one read as "done" (green ✓), the focused one
 *  is blue, the rest are upcoming. Stale steps carry an orange flag. */
function StorylineRail({
  steps,
  focusIdx,
  loading,
  onSelect,
}: {
  steps: StorylineFile[];
  focusIdx: number;
  loading: boolean;
  onSelect: (path: string) => void;
}) {
  const n = steps.length;
  const fillPct = n > 0 && focusIdx >= 0 ? focusIdx * (100 / n) + 4 : 0;
  return (
    <div
      style={{
        width: 240,
        flex: '0 0 240px',
        borderRight: '1px solid var(--hairline)',
        background: '#fbfaf8',
        padding: '14px 0',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div className="section-label" style={{ paddingLeft: 16, marginBottom: 8 }}>
        Storyline{n > 0 && focusIdx >= 0 ? ` · ${focusIdx + 1} / ${n}` : ''}
      </div>

      <div style={{ position: 'relative', flex: 1, padding: '4px 8px', overflow: 'auto' }}>
        {n === 0 ? (
          <div style={{ fontSize: 11.5, color: 'var(--gray-500)', padding: '4px 8px' }}>
            {loading ? 'Loading…' : 'No steps in this storyline.'}
          </div>
        ) : (
          <>
            {/* gray track */}
            <div
              style={{
                position: 'absolute',
                left: 24,
                top: 14,
                width: 2,
                height: 'calc(100% - 28px)',
                background: 'rgba(0,0,0,0.10)',
                borderRadius: 1,
              }}
            />
            {/* filled (steps walked) */}
            <div
              style={{
                position: 'absolute',
                left: 24,
                top: 14,
                width: 2,
                height: `${fillPct}%`,
                background: 'var(--green-d)',
                borderRadius: 1,
              }}
            />

            {steps.map((s, i) => {
              const done = i < focusIdx;
              const current = i === focusIdx;
              const hasIntro = s.intro_text.trim().length > 0;
              return (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => onSelect(s.diff_file_path)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '7px 10px',
                    borderRadius: 5,
                    margin: '1px 0',
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    cursor: 'default',
                    fontFamily: 'inherit',
                    background: current ? 'rgba(0,122,255,0.10)' : 'transparent',
                    color: current
                      ? 'var(--blue-press)'
                      : done
                        ? 'var(--gray-500)'
                        : 'var(--gray-800)',
                    position: 'relative',
                  }}
                >
                  <div
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      flex: '0 0 18px',
                      background: done ? 'var(--green-d)' : current ? 'var(--blue)' : '#fff',
                      border: `2px solid ${
                        done ? 'var(--green-d)' : current ? 'var(--blue)' : 'rgba(0,0,0,0.18)'
                      }`,
                      color: done || current ? '#fff' : 'var(--gray-600)',
                      fontSize: 10,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      boxShadow: current ? '0 0 0 3px var(--blue-tint-2)' : 'none',
                      zIndex: 1,
                    }}
                  >
                    {done ? '✓' : i + 1}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: current ? 600 : 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {basename(s.diff_file_path)}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10.5,
                        color: current ? 'rgba(0,98,204,0.7)' : 'var(--gray-500)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginTop: 1,
                      }}
                      title={s.diff_file_path}
                    >
                      {s.diff_file_path}
                    </div>
                  </div>
                  {s.stale ? (
                    <span className="badge badge-orange" style={{ flex: '0 0 auto' }}>
                      stale
                    </span>
                  ) : (
                    !hasIntro && (
                      <span
                        style={{ fontSize: 10, color: 'var(--gray-400)', flex: '0 0 auto' }}
                        title="No intro for this step"
                      >
                        —
                      </span>
                    )
                  )}
                </button>
              );
            })}
          </>
        )}
      </div>

      {/* Read-only footer */}
      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid var(--hairline-2)',
          fontSize: 11.5,
          color: 'var(--gray-600)',
          lineHeight: 1.5,
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            color: 'var(--gray-500)',
            fontWeight: 600,
          }}
        >
          <Icon name="eye" size={10} color="var(--gray-500)" /> Read-only
        </div>
        <div style={{ marginTop: 2 }}>following the author's storyline</div>
      </div>
    </div>
  );
}

/** Center header for the focused step: numbered circle + file + status badge,
 *  and the author's intro in a blue note card (rendered Markdown, read-only). */
function StepHeader({
  step,
  n,
  author,
  file,
}: {
  step: StorylineFile;
  n: number;
  author: string;
  file: SelfReviewFileChange | null;
}) {
  const badge = file ? STATUS_BADGE[file.status] : null;
  const hasIntro = step.intro_text.trim().length > 0;
  return (
    <div
      style={{
        padding: '14px 22px 12px',
        background: '#fff',
        borderBottom: '1px solid var(--hairline)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, minWidth: 0 }}>
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: 12,
            background: 'var(--blue)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 24px',
          }}
        >
          {n}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--gray-900)',
            letterSpacing: -0.01,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: '0 1 auto',
          }}
          title={step.diff_file_path}
        >
          {step.diff_file_path}
        </div>
        {step.stale ? (
          <span className="badge badge-orange" style={{ flex: '0 0 auto' }}>
            stale
          </span>
        ) : (
          badge && (
            <span className={`badge ${badge.cls}`} style={{ flex: '0 0 auto' }}>
              {badge.label}
            </span>
          )
        )}
        {file && !step.stale && (
          <span style={{ fontSize: 11.5, color: 'var(--gray-500)', flex: '0 0 auto' }}>
            <span style={{ color: 'var(--green-d)' }}>+{file.additions}</span>{' '}
            <span style={{ color: 'var(--red-d)' }}>−{file.deletions}</span>
          </span>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 10,
          padding: '8px 10px',
          background: 'rgba(0,122,255,0.07)',
          border: '1px solid rgba(0,122,255,0.18)',
          borderRadius: 'var(--r-md)',
        }}
      >
        <Avatar name={author} size="sm" />
        <div style={{ fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.45, minWidth: 0 }}>
          {hasIntro ? (
            <>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{author}'s note</div>
              <Markdown>{step.intro_text}</Markdown>
            </>
          ) : (
            <span>
              <span style={{ fontWeight: 600 }}>{author}'s note:</span>{' '}
              <span style={{ color: 'var(--gray-400)', fontStyle: 'italic' }}>
                No intro for this step.
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** The focused step's file diff (from GitHub), in the design's bordered card. */
function StepDiff({
  file,
  loading,
  error,
}: {
  file: SelfReviewFileChange | null;
  loading: boolean;
  error: string | null;
}) {
  const data = useMemo(() => {
    if (!file || !file.patch) return null;
    const lang = inferDiffLanguage(file.path);
    return {
      oldFile: { fileName: file.oldPath ?? file.path, fileLang: lang },
      newFile: { fileName: file.path, fileLang: lang },
      hunks: [file.patch],
    };
  }, [file]);

  if (loading) {
    return (
      <div style={{ padding: '24px 4px', fontSize: 12, color: 'var(--gray-500)' }}>
        Loading diff from GitHub…
      </div>
    );
  }
  if (error) {
    return <ErrorBanner title="Couldn't load this file's diff" detail={error} />;
  }

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r-md)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '6px 10px',
          borderBottom: '1px solid var(--hairline-2)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11.5,
        }}
      >
        <Icon name="doc-stack" size={12} color="var(--gray-500)" />
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--gray-700)' }}>
          {file?.path ?? ''}
        </span>
        <div style={{ flex: 1 }} />
        {file && (
          <span style={{ color: 'var(--gray-500)' }}>
            +{file.additions} −{file.deletions}
          </span>
        )}
      </div>
      {data ? (
        <DiffView
          data={data}
          diffViewMode={DiffModeEnum.Unified}
          diffViewHighlight
          diffViewWrap
          diffViewFontSize={12}
          diffViewTheme="light"
        />
      ) : (
        <div style={{ padding: '20px 14px', fontSize: 12, color: 'var(--gray-500)' }}>
          {file?.isBinary
            ? 'Binary file — no textual diff to show.'
            : 'No textual diff available for this file.'}
        </div>
      )}
    </div>
  );
}
