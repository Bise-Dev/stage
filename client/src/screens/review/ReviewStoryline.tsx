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
  type GithubIssueComment,
  type GithubPrFile,
  type GithubReview,
  type PrComments,
  type ReviewCtx,
  type ReviewEvent,
  type SelfReviewFileChange,
  type Side,
  type Storyline,
  type StorylineFile,
  type User,
  type WorkspaceState,
  prCommentCreate,
  prComments,
  prFileDiff,
  prReviewCreate,
  prReviews,
  storylineGet,
} from '../../tauri';
import { IntroDiscussion } from '../discussion/IntroDiscussion';
import { type CommentRange, CommentableFileDiff } from '../selfReview/CommentableFileDiff';
import { GithubThread } from './GithubThread';
import {
  type GithubCommentThread,
  groupCommentThreads,
  isOnDiff,
  parseVisibleLines,
  reviewersByState,
  threadAnchor,
} from './githubReview';

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
  const raw = f.patch ?? '';
  // GitHub's PR-file `patch` is header-less — it starts at the first `@@` hunk.
  // The @git-diff-view parser, though, consumes lines looking for the `---`/`+++`
  // file-header pair *before* it will read any hunks, so a header-less patch
  // renders blank. Synthesize that header (the renderer takes the displayed file
  // names from `oldFile`/`newFile`, not from these lines, so the paths here only
  // need to satisfy the parser). This matches the headered patches the Rust
  // `self_review_diff` emits, which the same renderer already handles.
  const patch = raw
    ? `--- a/${f.previous_filename ?? f.filename}\n+++ b/${f.filename}\n${raw}`
    : '';
  return {
    path: f.filename,
    oldPath: f.previous_filename ?? null,
    status,
    additions: f.additions,
    deletions: f.deletions,
    patch,
    // No patch from GitHub = binary or too large to inline; there's no textual
    // diff to render either way.
    isBinary: raw.length === 0,
    isTruncated: false,
  };
}

/**
 * Reviewer storyline viewer (Steps 2–4). A reviewer opens a *published*
 * workspace authored by someone else and walks the author's ordered steps: each
 * step shows the author's intro (rendered Markdown) above that file's diff,
 * fetched from the PR on GitHub via the backend (ADR-0001 — the reviewer may
 * never have had the branch locally). Stale steps (the file is no longer in the
 * PR) are flagged instead of fetched. Refresh re-pulls the latest storyline +
 * diffs (MVP propagation; no webhooks).
 *
 * Write-through (Step 4, ADR-0003): the diff uses the **same** commenting
 * surface as self-review (`CommentableFileDiff`) — drag a line range to leave a
 * review comment, reply to a thread, or submit a verdict (Approve / Request
 * changes / Comment). All post to GitHub as the signed-in user, so non-Stage
 * participants on the PR see them. A **frozen** workspace (closed/merged PR)
 * disables every write affordance and shows why. The author's composer
 * (ordering, intro editing, Save, Publish) is never reachable here.
 */
export function ReviewStoryline({
  ctx,
  user,
  onBack,
}: {
  ctx: ReviewCtx;
  user: User;
  onBack: () => void;
}) {
  const [steps, setSteps] = useState<StorylineFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The PR head sha (storyline `head_sha`) — the `commit_id` a fresh GitHub line
  // comment must anchor to. Null (no published head) disables line commenting.
  const [headSha, setHeadSha] = useState<string | null>(null);
  // Per-path GitHub diff, resolved lazily as steps are visited. Cleared on
  // Refresh so the next visit re-pulls against the latest PR head.
  const [diffCache, setDiffCache] = useState<Map<string, SelfReviewFileChange>>(new Map());
  const [diffErrors, setDiffErrors] = useState<Map<string, string>>(new Map());
  const [diffLoading, setDiffLoading] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // PR-wide GitHub review activity (comments + reviews), fetched once per
  // open/Refresh and re-pulled after each write — including activity left by
  // non-Stage participants directly on github.com (ADR-0003). Auxiliary to the
  // storyline: a fetch failure here is surfaced in its own banner rather than
  // blanking the viewer.
  const [comments, setComments] = useState<PrComments | null>(null);
  const [reviews, setReviews] = useState<GithubReview[]>([]);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [showConversation, setShowConversation] = useState(false);
  // Last write (comment / reply / verdict) failure, surfaced verbatim in a red
  // banner (fail loud, CLAUDE.md). Cleared on the next successful write.
  const [writeError, setWriteError] = useState<string | null>(null);
  const [verdictOpen, setVerdictOpen] = useState(false);
  const [submittingVerdict, setSubmittingVerdict] = useState(false);

  // PR-wide review activity, fetched independently of the storyline (a
  // comments/reviews failure mustn't hide a loadable storyline, or vice versa)
  // and re-pulled after each write so a just-posted comment/verdict shows up.
  // Both halves are surfaced loud — never swallowed into an empty list.
  const loadActivity = useCallback(async () => {
    try {
      const [c, rv] = await Promise.all([
        prComments(ctx.owner, ctx.repo, ctx.prNumber),
        prReviews(ctx.owner, ctx.repo, ctx.prNumber),
      ]);
      setComments(c);
      setReviews(rv);
      setActivityError(null);
    } catch (e) {
      console.warn('review_activity_load_failed', e);
      setActivityError(msgOf(e));
    }
  }, [ctx.owner, ctx.repo, ctx.prNumber]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const storyline: Storyline = await storylineGet(ctx.workspaceId);
      setSteps(storyline.files);
      setHeadSha(storyline.head_sha);
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

    await loadActivity();
  }, [ctx.workspaceId, loadActivity]);

  useEffect(() => {
    load();
  }, [load]);

  const idx = steps.findIndex((s) => s.diff_file_path === selected);
  const step = idx === -1 ? null : steps[idx];

  // Group the PR's review (line) comments into threads once, then narrow to the
  // selected step's file. The diff pane partitions these into inline (anchored
  // to a visible line) vs off-diff (line gone) using the loaded patch.
  const allThreads = useMemo(() => groupCommentThreads(comments?.review ?? []), [comments]);
  const fileThreads = useMemo(
    () => (step ? allThreads.filter((t) => t.root.path === step.diff_file_path) : []),
    [allThreads, step],
  );
  // Per-reviewer verdict for the decision banner (non-Stage reviewers included).
  const decision = useMemo(() => reviewersByState(reviews), [reviews]);
  // PR-level conversation: issue comments + reviews that carry a summary body.
  const reviewNotes = useMemo(() => reviews.filter((r) => r.body.trim().length > 0), [reviews]);
  const issueComments = comments?.issue ?? [];
  const conversationCount = issueComments.length + reviewNotes.length;

  // Write affordances (ADR-0003). A frozen workspace = the PR is closed/merged;
  // the backend rejects writes 409, so we disable them up front and explain why.
  // Line comments additionally need the PR head sha as their `commit_id`.
  const frozen = ctx.state === 'frozen';
  const canComment = !frozen && headSha != null;

  // Post a fresh review (line) comment over the dragged range, write-through to
  // GitHub. GitHub anchors a single line + side; we use the range's end line
  // (the widget sits below the last selected line). On success re-pull activity
  // so the new thread renders inline; on failure surface it and rethrow so the
  // shared composer stays open with the text intact.
  const postLineComment = useCallback(
    async (range: CommentRange, body: string) => {
      if (!step || !headSha) throw new Error('Cannot comment: no PR head to anchor to.');
      try {
        await prCommentCreate(ctx.owner, ctx.repo, ctx.prNumber, {
          kind: 'review',
          body,
          path: step.diff_file_path,
          line: range.lineEnd,
          side: range.side === 'left' ? 'LEFT' : 'RIGHT',
          commit_id: headSha,
        });
        setWriteError(null);
        await loadActivity();
      } catch (e) {
        console.warn('review_comment_create_failed', e);
        setWriteError(msgOf(e));
        throw e;
      }
    },
    [step, headSha, ctx.owner, ctx.repo, ctx.prNumber, loadActivity],
  );

  // Reply to an existing review thread (`in_reply_to` its root comment id).
  const postReply = useCallback(
    async (rootId: number, body: string) => {
      try {
        await prCommentCreate(ctx.owner, ctx.repo, ctx.prNumber, {
          kind: 'review',
          body,
          in_reply_to: rootId,
        });
        setWriteError(null);
        await loadActivity();
      } catch (e) {
        console.warn('review_reply_create_failed', e);
        setWriteError(msgOf(e));
        throw e;
      }
    },
    [ctx.owner, ctx.repo, ctx.prNumber, loadActivity],
  );

  // Submit a review verdict (Approve / Request changes / Comment) with a
  // summary body. On success re-pull activity (the decision banner updates) and
  // close the panel.
  const submitVerdict = useCallback(
    async (event: ReviewEvent, body: string) => {
      setSubmittingVerdict(true);
      try {
        await prReviewCreate(ctx.owner, ctx.repo, ctx.prNumber, body, event);
        setWriteError(null);
        setVerdictOpen(false);
        await loadActivity();
      } catch (e) {
        console.warn('review_verdict_create_failed', e);
        setWriteError(msgOf(e));
      } finally {
        setSubmittingVerdict(false);
      }
    },
    [ctx.owner, ctx.repo, ctx.prNumber, loadActivity],
  );

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

        {activityError && (
          <div style={{ padding: '10px 16px 0' }}>
            <ErrorBanner
              title="Couldn't load review activity"
              detail={activityError}
              onClose={() => setActivityError(null)}
            />
          </div>
        )}

        {writeError && (
          <div style={{ padding: '10px 16px 0' }}>
            <ErrorBanner
              title="Couldn't post to GitHub"
              detail={writeError}
              onClose={() => setWriteError(null)}
            />
          </div>
        )}

        {(reviews.length > 0 || conversationCount > 0) && (
          <ReviewActivityBar
            decision={decision}
            conversationCount={conversationCount}
            expanded={showConversation}
            onToggle={() => setShowConversation((v) => !v)}
            issueComments={issueComments}
            reviewNotes={reviewNotes}
          />
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
                  {/* Stage-native discussion on this step's intro (ADR-0001) —
                      published workspaces let anyone comment, so writes are
                      gated only by the frozen guard. */}
                  <IntroDiscussion
                    key={step.id}
                    workspaceId={ctx.workspaceId}
                    fileId={step.id}
                    currentUserId={user.id}
                    isCreator={user.github_login === ctx.author}
                    canWrite={!frozen}
                  />
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
                      threads={fileThreads}
                      onCreate={canComment ? postLineComment : undefined}
                      onReply={frozen ? undefined : postReply}
                    />
                  )}
                </div>

                {/* Verdict composer (Approve / Request changes / Comment) —
                    write-through to GitHub. Hidden when frozen. */}
                {verdictOpen && !frozen && (
                  <VerdictPanel
                    submitting={submittingVerdict}
                    onSubmit={submitVerdict}
                    onCancel={() => setVerdictOpen(false)}
                  />
                )}

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
                  {frozen ? (
                    <span
                      style={{
                        fontSize: 11.5,
                        color: 'var(--gray-500)',
                        flex: '0 0 auto',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                      title="The workspace is frozen because its PR is closed or merged"
                    >
                      <Icon name="eye" size={11} color="var(--gray-500)" /> This PR is closed —
                      reopen on GitHub to review.
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setVerdictOpen((v) => !v)}
                      style={{ flex: '0 0 auto' }}
                    >
                      <Icon name="check" size={12} color="var(--gray-700)" />{' '}
                      {verdictOpen ? 'Close review' : 'Finish review…'}
                    </button>
                  )}
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

/** The focused step's file diff (from GitHub), in the design's bordered card,
 *  using the **same** commenting surface as self-review (`CommentableFileDiff`):
 *  GitHub review (line) comments render inline at their anchored line, dragging
 *  a range opens a composer that posts a comment write-through to GitHub, and a
 *  thread can be replied to. Comments whose line is no longer in the current
 *  diff are surfaced in an off-diff band rather than dropped (fail loud,
 *  CLAUDE.md). `onCreate`/`onReply` omitted ⇒ read-only (frozen / no head sha). */
function StepDiff({
  file,
  loading,
  error,
  threads,
  onCreate,
  onReply,
}: {
  file: SelfReviewFileChange | null;
  loading: boolean;
  error: string | null;
  threads: GithubCommentThread[];
  onCreate?: (range: CommentRange, body: string) => Promise<void>;
  onReply?: (rootId: number, body: string) => Promise<void>;
}) {
  // Partition threads into inline (anchored to a line present in the patch) vs
  // off-diff, in one pass. Inline ones become anchors for the shared diff
  // surface; off-diff ones render in a band above it (never dropped).
  const { inline, inlineAnchors, offDiff } = useMemo(() => {
    const visible = file?.patch
      ? parseVisibleLines(file.patch)
      : { left: new Set<number>(), right: new Set<number>() };
    const inline: { side: Side; line: number; thread: GithubCommentThread }[] = [];
    const off: GithubCommentThread[] = [];
    for (const t of threads) {
      const a = threadAnchor(t);
      if (!file?.patch || !a || !isOnDiff(t, visible)) {
        off.push(t);
        continue;
      }
      inline.push({ side: a.side === 'LEFT' ? 'left' : 'right', line: a.line, thread: t });
    }
    return {
      inline,
      inlineAnchors: inline.map(({ side, line }) => ({ side, line })),
      offDiff: off,
    };
  }, [file, threads]);

  const renderInline = useCallback(
    (side: Side, line: number) => {
      const here = inline.filter((it) => it.side === side && it.line === line);
      if (here.length === 0) return null;
      return here.map((it) => (
        <GithubThread key={it.thread.root.id} thread={it.thread} onReply={onReply} />
      ));
    },
    [inline, onReply],
  );

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
    <>
      {offDiff.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              ...banner,
              color: '#b56500',
              background: 'rgba(255,149,0,0.08)',
              border: '1px solid rgba(255,149,0,0.22)',
              marginBottom: 6,
            }}
          >
            {offDiff.length} comment{offDiff.length === 1 ? '' : 's'} on a line that's no longer in
            this diff — shown here so none of the review activity is lost.
          </div>
          {offDiff.map((t) => (
            <GithubThread key={t.root.id} thread={t} offDiff onReply={onReply} />
          ))}
        </div>
      )}

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
        {file ? (
          <CommentableFileDiff
            file={file}
            viewMode="unified"
            inlineAnchors={inlineAnchors}
            renderInline={renderInline}
            onCreate={onCreate}
            composerPlaceholder="Leave a review comment…"
          />
        ) : (
          <div style={{ padding: '20px 14px', fontSize: 12, color: 'var(--gray-500)' }}>
            No textual diff available for this file.
          </div>
        )}
      </div>
    </>
  );
}

/** The verdict composer — a summary body + Approve / Request changes / Comment,
 *  posted as a GitHub review (ADR-0003). The backend requires a non-empty body
 *  (even for Approve), so the buttons stay disabled until something is typed. */
function VerdictPanel({
  submitting,
  onSubmit,
  onCancel,
}: {
  submitting: boolean;
  onSubmit: (event: ReviewEvent, body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState('');
  const empty = body.trim().length === 0;
  const submit = (event: ReviewEvent) => {
    if (empty || submitting) return;
    onSubmit(event, body.trim());
  };
  return (
    <div
      style={{
        flex: '0 0 auto',
        padding: '12px 22px',
        background: '#fff',
        borderTop: '1px solid var(--hairline)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 6,
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--gray-800)',
        }}
      >
        <Icon name="check" size={12} color="var(--gray-700)" /> Finish your review
      </div>
      <textarea
        value={body}
        placeholder="Summarize your review… (required)"
        onChange={(e) => setBody(e.target.value)}
        style={{
          width: '100%',
          minHeight: 64,
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--r-md)',
          padding: 8,
          outline: 'none',
          resize: 'vertical',
          fontFamily: 'var(--font-ui)',
          fontSize: 12.5,
          color: 'var(--gray-800)',
          background: '#fff',
        }}
      />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" className="btn" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => submit('COMMENT')}
          disabled={empty || submitting}
          style={{ opacity: empty || submitting ? 0.5 : 1 }}
        >
          Comment
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => submit('REQUEST_CHANGES')}
          disabled={empty || submitting}
          style={{
            opacity: empty || submitting ? 0.5 : 1,
            color: 'var(--orange-d, #b56500)',
            borderColor: 'rgba(255,149,0,0.35)',
          }}
        >
          Request changes
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => submit('APPROVE')}
          disabled={empty || submitting}
          style={{ opacity: empty || submitting ? 0.5 : 1 }}
        >
          <Icon name="check" size={11} color="#fff" /> {submitting ? 'Submitting…' : 'Approve'}
        </button>
      </div>
    </div>
  );
}

const REVIEW_STATE_BADGE: Record<GithubReview['state'], { label: string; cls: string }> = {
  APPROVED: { label: 'approved', cls: 'badge-green' },
  CHANGES_REQUESTED: { label: 'changes requested', cls: 'badge-orange' },
  COMMENTED: { label: 'commented', cls: 'badge-blue' },
  DISMISSED: { label: 'dismissed', cls: '' },
  PENDING: { label: 'pending', cls: '' },
};

/** A list of reviewer logins as small avatar chips after a label. */
function ReviewerChips({ logins }: { logins: string[] }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {logins.map((l) => (
        <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <Avatar name={l} size="sm" />
          <span style={{ fontSize: 11.5, color: 'var(--gray-700)' }}>{l}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * Subheader strip showing the PR's review decision (latest verdict per
 * reviewer, **non-Stage reviewers included** — ADR-0003) and a toggle into the
 * PR-level conversation (issue comments + review summaries). Mirrors what the
 * workspaces overview computes server-side; here it's the detailed read.
 */
function ReviewActivityBar({
  decision,
  conversationCount,
  expanded,
  onToggle,
  issueComments,
  reviewNotes,
}: {
  decision: { approved: string[]; changesRequested: string[] };
  conversationCount: number;
  expanded: boolean;
  onToggle: () => void;
  issueComments: GithubIssueComment[];
  reviewNotes: GithubReview[];
}) {
  const hasVerdict = decision.approved.length > 0 || decision.changesRequested.length > 0;

  // Merge issue comments + review summaries into one chronologically-ordered
  // conversation. created_at / submitted_at are ISO-8601 (lexically sortable).
  const conversation = useMemo(() => {
    const items = [
      ...issueComments.map((c) => ({
        key: `i${c.id}`,
        at: c.created_at,
        login: c.user?.login ?? 'ghost',
        body: c.body,
        state: null as GithubReview['state'] | null,
      })),
      ...reviewNotes.map((r) => ({
        key: `r${r.id}`,
        at: r.submitted_at ?? '',
        login: r.user?.login ?? 'ghost',
        body: r.body,
        state: r.state,
      })),
    ];
    items.sort((a, b) => a.at.localeCompare(b.at));
    return items;
  }, [issueComments, reviewNotes]);

  return (
    <div style={{ borderBottom: '1px solid var(--hairline)', background: '#fff' }}>
      <div
        style={{
          padding: '8px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        {decision.changesRequested.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="badge badge-orange">Changes requested by</span>
            <ReviewerChips logins={decision.changesRequested} />
          </span>
        )}
        {decision.approved.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="badge badge-green">Approved by</span>
            <ReviewerChips logins={decision.approved} />
          </span>
        )}
        {!hasVerdict && (
          <span style={{ fontSize: 12, color: 'var(--gray-500)' }}>
            No approval or change request yet.
          </span>
        )}
        <div style={{ flex: 1 }} />
        {conversationCount > 0 && (
          <button type="button" className="btn" onClick={onToggle}>
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} /> Conversation ·{' '}
            {conversationCount}
          </button>
        )}
      </div>

      {expanded && conversation.length > 0 && (
        <div
          style={{
            padding: '4px 16px 12px',
            maxHeight: 240,
            overflow: 'auto',
            borderTop: '1px solid var(--hairline-2)',
          }}
        >
          {conversation.map((c) => {
            const badge = c.state ? REVIEW_STATE_BADGE[c.state] : null;
            return (
              <div
                key={c.key}
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: '8px 0',
                  borderBottom: '1px solid var(--hairline-2)',
                }}
              >
                <Avatar name={c.login} size="sm" />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: 'var(--gray-700)',
                      marginBottom: 1,
                    }}
                  >
                    {c.login}
                    {badge && <span className={`badge ${badge.cls}`}>{badge.label}</span>}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.45 }}>
                    <Markdown>{c.body}</Markdown>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
