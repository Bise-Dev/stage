import { DiffModeEnum, DiffView } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { TitleBar } from '../../components/TitleBar';
import {
  type PrActivity,
  type PrDiscussion,
  type PrRef,
  type ReviewThread,
  type ReviewerEntry,
  type SelfReviewFileChange,
  type Verdict,
  onSyncUpdated,
  openUrl,
  prActivity,
  prDiscussion,
  prReopenThread,
  prReplyThread,
  prResolveThread,
  prStartThread,
  prSubmitVerdict,
  reviewCheckoutBranch,
  reviewOpen,
  syncUnwatchPr,
  syncWatchPr,
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
 * matching {@link SelfReviewFileChange} from the entry's full diff, or null when
 * the step's anchor is no longer in the diff (a stale step). We never fabricate a
 * diff — a missing/binary patch shows an explicit notice (fail-loud, CLAUDE.md).
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
        This step's file is no longer in the PR diff — it dropped out of the change.
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

/** The write-through callbacks the discussion UI uses (all go to GitHub via `gh`). */
type DiscussionWrites = {
  /** Start a file-level thread on a step's anchor (IC-1). */
  onStart: (anchor: string, body: string) => Promise<void>;
  /** Reply to a thread by its root comment id (IC-1). */
  onReply: (rootId: number, body: string) => Promise<void>;
  /** Resolve / reopen a thread by its GraphQL node id (IC-2). */
  onResolve: (threadId: string) => Promise<void>;
  onReopen: (threadId: string) => Promise<void>;
};

/** A small markdown composer: a textarea + a submit button, clearing on success. */
function Composer({
  placeholder,
  submitLabel,
  onSubmit,
  rows = 3,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<void>;
  rows?: number;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await onSubmit(body.trim());
      setBody('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <textarea
        className="input"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          disabled={busy || !body.trim()}
        >
          {busy ? 'Posting…' : submitLabel}
        </button>
      </div>
    </div>
  );
}

/** One code-anchored review thread (IC-1): its comments oldest-first, a reply
 *  composer, and a resolve/reopen toggle (IC-2). */
function ThreadView({
  thread,
  writes,
}: {
  thread: ReviewThread;
  writes: DiscussionWrites;
}) {
  const rootId = thread.comments[0]?.id;
  // Resolve/reopen hits `gh` (network). Guard against a double-click firing two
  // mutations now that the command runs async and the UI no longer blocks
  // (ADR-0023) — same `busy` pattern as Composer/VerdictBar.
  const [toggling, setToggling] = useState(false);
  const toggleResolved = async () => {
    setToggling(true);
    try {
      await (thread.isResolved ? writes.onReopen(thread.id) : writes.onResolve(thread.id));
    } finally {
      setToggling(false);
    }
  };
  return (
    <div
      style={{
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r-sm)',
        background: thread.isResolved ? 'rgba(0,0,0,0.02)' : '#fff',
        marginBottom: 8,
        opacity: thread.isResolved ? 0.75 : 1,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: '1px solid var(--hairline)',
          fontSize: 11,
          color: 'var(--gray-500)',
        }}
      >
        {thread.line !== null && <span className="mono">line {thread.line}</span>}
        {thread.isOutdated && (
          <span className="badge" style={{ background: 'rgba(0,0,0,0.06)' }}>
            outdated
          </span>
        )}
        {thread.isResolved && (
          <span className="badge badge-green">
            <Icon name="check" size={9} color="var(--green-d)" /> resolved
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn"
          onClick={() => void toggleResolved()}
          disabled={toggling}
        >
          {toggling
            ? thread.isResolved
              ? 'Reopening…'
              : 'Resolving…'
            : thread.isResolved
              ? 'Reopen'
              : 'Resolve'}
        </button>
      </div>
      <div style={{ padding: '8px 10px' }}>
        {thread.comments.map((c) => (
          <div key={c.id} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11.5, color: 'var(--gray-600)', marginBottom: 2 }}>
              <span style={{ fontWeight: 600, color: 'var(--gray-800)' }}>@{c.author}</span>
              {c.viewerDidAuthor && <span style={{ color: 'var(--gray-400)' }}> · you</span>}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.5 }}>
              <Markdown>{c.body}</Markdown>
            </div>
          </div>
        ))}
        {rootId !== undefined && (
          <Composer
            placeholder="Reply…"
            submitLabel="Reply"
            rows={2}
            onSubmit={(body) => writes.onReply(rootId, body)}
          />
        )}
      </div>
    </div>
  );
}

/** The discussion for one step: existing threads at this anchor + a composer to
 *  start a new file-level thread on it (IC-1). */
function StepDiscussion({
  anchor,
  threads,
  writes,
}: {
  anchor: string;
  threads: ReviewThread[];
  writes: DiscussionWrites;
}) {
  return (
    <div style={{ padding: '10px 16px', background: 'var(--gray-50, #f7f7f8)' }}>
      <div className="section-label" style={{ marginBottom: 6 }}>
        Discussion{' '}
        {threads.length > 0 && <span style={{ color: 'var(--gray-400)' }}>{threads.length}</span>}
      </div>
      {threads.map((t) => (
        <ThreadView key={t.id} thread={t} writes={writes} />
      ))}
      <Composer
        placeholder="Start a discussion on this step…"
        submitLabel="Comment"
        rows={2}
        onSubmit={(body) => writes.onStart(anchor, body)}
      />
    </div>
  );
}

/** The PR's existing activity (RW-4): the verdict decision, reviews, conversation
 *  comments, and CI checks — read-only context above the walk. */
function ActivityHeader({ activity }: { activity: PrActivity }) {
  const checkSummary = useMemo(() => {
    const by: Record<string, number> = {};
    for (const c of activity.checks) by[c.status] = (by[c.status] ?? 0) + 1;
    return by;
  }, [activity.checks]);

  if (
    activity.reviews.length === 0 &&
    activity.issueComments.length === 0 &&
    activity.checks.length === 0
  ) {
    return null;
  }

  return (
    <section style={{ borderBottom: '6px solid var(--hairline)', background: '#fff' }}>
      <div style={{ padding: '12px 16px' }}>
        <div className="section-label" style={{ marginBottom: 8 }}>
          PR activity
        </div>

        {activity.checks.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {Object.entries(checkSummary).map(([status, n]) => (
              <span key={status} className="badge" style={{ background: 'rgba(0,0,0,0.06)' }}>
                {n} {status}
              </span>
            ))}
          </div>
        )}

        {activity.reviews.map((r, i) => (
          <div key={`${r.author}-${i}`} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11.5, color: 'var(--gray-600)' }}>
              <span style={{ fontWeight: 600, color: 'var(--gray-800)' }}>@{r.author}</span> ·{' '}
              {r.state}
            </div>
            {r.body.trim() && (
              <div style={{ fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.5 }}>
                <Markdown>{r.body}</Markdown>
              </div>
            )}
          </div>
        ))}

        {activity.issueComments.map((c, i) => (
          <div key={`${c.author}-${i}`} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11.5, color: 'var(--gray-600)' }}>
              <span style={{ fontWeight: 600, color: 'var(--gray-800)' }}>@{c.author}</span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.5 }}>
              <Markdown>{c.body}</Markdown>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The verdict bar (RW-3): a summary + Approve / Request changes / Comment, the
 *  whole point of the reviewer flow. Only shown on an OPEN PR. */
function VerdictBar({
  onSubmit,
}: {
  onSubmit: (verdict: Verdict, body: string) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (verdict: Verdict) => {
    // GitHub requires a body for REQUEST_CHANGES / COMMENT; approve may be empty.
    if (verdict !== 'approve' && !body.trim()) return;
    setBusy(true);
    try {
      await onSubmit(verdict, body.trim());
      setBody('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        flex: '0 0 auto',
        borderTop: '1px solid var(--hairline)',
        background: '#fff',
        padding: '10px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <textarea
        className="input"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Verdict summary (required for Request changes / Comment)…"
        rows={2}
        style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn"
          onClick={() => void submit('comment')}
          disabled={busy || !body.trim()}
        >
          Comment
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void submit('requestChanges')}
          disabled={busy || !body.trim()}
        >
          Request changes
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit('approve')}
          disabled={busy}
        >
          {busy ? 'Submitting…' : 'Approve'}
        </button>
      </div>
    </div>
  );
}

/**
 * The local-first **reviewer entry** screen (ADR-0022 §6, milestone F: GAP-3 #93,
 * SL-4 reviewer side; E: RW-1..5 verdict, IC-1..3 discussion). Reached by
 * `stage open <pr-url>` or a dashboard row. It opens the PR **read-only** — the
 * PR head is fetched, and the author's storyline + the tree-to-tree diff render
 * with **no working-tree mutation** — and adds the GitHub write-through the
 * reviewer needs: a verdict (RW-3) and code-anchored discussion threads (IC-1..2),
 * all via the user's own `gh`. The lone working-tree mutation is the
 * user-confirmed "Check out this branch".
 *
 * Everything derived (the diff, the overlay, stale flags) is computed in Rust;
 * this screen renders the DTOs and posts back through the new-engine commands.
 */
export function LocalReview({ pr, onBack }: { pr: PrRef; onBack: () => void }) {
  const [entry, setEntry] = useState<ReviewerEntry | null>(null);
  const [activity, setActivity] = useState<PrActivity | null>(null);
  const [discussion, setDiscussion] = useState<PrDiscussion | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  // The user-confirmed checkout (the lone working-tree mutation).
  const [confirming, setConfirming] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkedOut, setCheckedOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Refresh the GitHub-sourced activity + discussion after any write. `anchors`
  // groups threads onto the steps; computed from the entry's storyline.
  // `preferCached` is passed on the sync-event reload path only — the engine
  // just deep-polled the PR, so `pr_activity` can serve its cache; a reload
  // after the viewer's own write must re-fetch (a pre-write cache would hide
  // the action).
  const reloadActivity = useCallback(
    async (anchors: string[], preferCached = false) => {
      try {
        const [a, d] = await Promise.all([
          prActivity(pr.number, preferCached),
          prDiscussion(pr.number, anchors),
        ]);
        setActivity(a);
        setDiscussion(d);
      } catch (e) {
        console.warn('pr_activity_failed', e);
        setWriteError(msgOf(e));
      }
    },
    [pr.number],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const e = await reviewOpen(pr);
        if (!alive) return;
        setEntry(e);
        // Activity + discussion are best-effort context: a failure here surfaces
        // in the write-error banner but doesn't block reading the storyline.
        await reloadActivity(e.steps.map((s) => s.anchor));
        // Now that the first fetch seeded the engine's cache, have it deep-poll
        // this PR so new reviews/comments/checks land while the screen is open.
        syncWatchPr(pr.number).catch((err) => console.warn('sync_watch_pr_failed', err));
      } catch (e) {
        console.warn('review_open_failed', e);
        if (alive) setLoadError(msgOf(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [pr, reloadActivity]);

  // Stop the deep-poll when the screen closes.
  useEffect(
    () => () => {
      syncUnwatchPr().catch((e) => console.warn('sync_unwatch_pr_failed', e));
    },
    [],
  );

  const anchors = useMemo(() => entry?.steps.map((s) => s.anchor) ?? [], [entry]);

  // Live refresh: the engine pings when the watched PR's activity changed on
  // GitHub — reload from its fresh cache (no extra `gh pr view`).
  useEffect(() => {
    const off = onSyncUpdated((u) => {
      if (u.scope === 'pr' && u.prNumber === pr.number) void reloadActivity(anchors, true);
    });
    return () => {
      void off.then((f) => f());
    };
  }, [pr.number, anchors, reloadActivity]);

  const fileFor = useCallback(
    (path: string): SelfReviewFileChange | null =>
      entry?.diff.files.find((f) => f.path === path) ?? null,
    [entry],
  );

  // Discussion write-through (IC-1..2): each posts via `gh`, then refreshes.
  const writes: DiscussionWrites = useMemo(
    () => ({
      onStart: async (anchor, body) => {
        try {
          await prStartThread(pr.number, anchor, null, null, body);
          await reloadActivity(anchors);
        } catch (e) {
          setWriteError(msgOf(e));
        }
      },
      onReply: async (rootId, body) => {
        try {
          await prReplyThread(pr.number, rootId, body);
          await reloadActivity(anchors);
        } catch (e) {
          setWriteError(msgOf(e));
        }
      },
      onResolve: async (threadId) => {
        try {
          await prResolveThread(threadId);
          await reloadActivity(anchors);
        } catch (e) {
          setWriteError(msgOf(e));
        }
      },
      onReopen: async (threadId) => {
        try {
          await prReopenThread(threadId);
          await reloadActivity(anchors);
        } catch (e) {
          setWriteError(msgOf(e));
        }
      },
    }),
    [pr.number, anchors, reloadActivity],
  );

  const submitVerdict = useCallback(
    async (verdict: Verdict, body: string) => {
      try {
        await prSubmitVerdict(pr.number, verdict, body, []);
        await reloadActivity(anchors);
      } catch (e) {
        console.warn('pr_submit_verdict_failed', e);
        setWriteError(msgOf(e));
      }
    },
    [pr.number, anchors, reloadActivity],
  );

  const doCheckout = async () => {
    if (!entry) return;
    setCheckingOut(true);
    setCheckoutError(null);
    try {
      await reviewCheckoutBranch(pr, entry.pr.headRef);
      setCheckedOut(true);
      setConfirming(false);
    } catch (e) {
      console.warn('review_checkout_failed', e);
      setCheckoutError(msgOf(e));
    } finally {
      setCheckingOut(false);
    }
  };

  const title = entry ? entry.pr.title : `${pr.owner}/${pr.name} #${pr.number}`;
  const isOpen = entry?.pr.state === 'OPEN';

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title={`Stage — Review · ${pr.owner}/${pr.name} #${pr.number}`} />
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
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--gray-900)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 320,
              }}
            >
              #{pr.number} · {title}
            </span>
            {entry && (
              <>
                <span className="badge mono" style={{ background: 'rgba(0,0,0,0.06)' }}>
                  {entry.pr.baseRef} ← {entry.pr.headRef}
                </span>
                <span className="badge" style={{ background: 'rgba(0,0,0,0.06)' }}>
                  {entry.pr.isDraft ? 'DRAFT' : entry.pr.state}
                </span>
                {activity?.reviewDecision && (
                  <span className="badge" style={{ background: 'rgba(0,0,0,0.06)' }}>
                    {activity.reviewDecision}
                  </span>
                )}
                {!entry.stageGuided && (
                  <span className="badge" style={{ background: 'rgba(0,0,0,0.06)' }}>
                    plain PR
                  </span>
                )}
              </>
            )}
            <div style={{ flex: 1 }} />
            {entry && (
              <>
                <button type="button" className="btn" onClick={() => void openUrl(entry.pr.url)}>
                  Open on GitHub
                </button>
                {checkedOut ? (
                  <span className="badge badge-green">Checked out {entry.pr.headRef}</span>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setConfirming(true)}
                    disabled={checkingOut}
                  >
                    Check out this branch
                  </button>
                )}
              </>
            )}
          </div>

          {/* The user-confirmed checkout (the lone working-tree mutation). */}
          {confirming && entry && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 18px',
                background: 'var(--blue-tint)',
                borderBottom: '1px solid var(--hairline)',
                fontSize: 12.5,
                color: 'var(--gray-800)',
              }}
            >
              <span>
                Check out <span className="mono">{entry.pr.headRef}</span> into your working tree?
                This is the only change Stage makes to your files — everything else is read-only.
              </span>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                className="btn btn-primary"
                onClick={doCheckout}
                disabled={checkingOut}
              >
                {checkingOut ? 'Checking out…' : 'Check out'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setConfirming(false)}
                disabled={checkingOut}
              >
                Cancel
              </button>
            </div>
          )}

          {(loadError || checkoutError || writeError) && (
            <div style={{ padding: '10px 18px 0' }}>
              {loadError && (
                <ErrorBanner
                  title="Couldn't open this PR for review"
                  detail={loadError}
                  onClose={() => setLoadError(null)}
                />
              )}
              {checkoutError && (
                <ErrorBanner
                  title="Couldn't check out the branch"
                  detail={checkoutError}
                  onClose={() => setCheckoutError(null)}
                />
              )}
              {writeError && (
                <ErrorBanner
                  title="GitHub action failed"
                  detail={writeError}
                  onClose={() => setWriteError(null)}
                />
              )}
            </div>
          )}

          {loading ? (
            <div style={notice}>Resolving the PR and fetching its head…</div>
          ) : !entry ? (
            <div style={notice}>No PR loaded.</div>
          ) : (
            <>
              <div style={{ flex: 1, overflow: 'auto', background: '#fff' }}>
                {activity && <ActivityHeader activity={activity} />}
                <ReviewWalk
                  entry={entry}
                  fileFor={fileFor}
                  discussion={discussion}
                  writes={writes}
                />
              </div>
              {isOpen && <VerdictBar onSubmit={submitVerdict} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Walk the storyline in the author's order (SL-4 reviewer side): each step shows
 * the author's intro, the anchored file's diff, then the code-anchored discussion
 * for that step (IC-1). After the steps, the overlay of changes outside the
 * storyline (GAP-4), then any discussion threads anchored off-step.
 */
function ReviewWalk({
  entry,
  fileFor,
  discussion,
  writes,
}: {
  entry: ReviewerEntry;
  fileFor: (path: string) => SelfReviewFileChange | null;
  discussion: PrDiscussion | null;
  writes: DiscussionWrites;
}) {
  const { steps, unstoried } = entry;
  const threadsFor = (anchor: string): ReviewThread[] =>
    discussion?.steps.find((s) => s.anchor === anchor)?.threads ?? [];

  return (
    <>
      {steps.map((s, i) => (
        <section
          key={`${s.order}-${s.anchor}`}
          style={{ borderBottom: '6px solid var(--hairline)' }}
        >
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--hairline)' }}>
            <div style={{ fontSize: 12, color: 'var(--gray-500)', marginBottom: 2 }}>
              Step {i + 1} of {steps.length}
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gray-900)' }}>
              {s.title || s.anchor}
              {s.stale && (
                <span className="badge" style={{ marginLeft: 8, background: 'rgba(0,0,0,0.06)' }}>
                  not in diff
                </span>
              )}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--gray-500)' }}>
              {s.anchor}
            </div>
          </div>
          {s.intro.trim() && (
            <div
              style={{
                padding: '12px 16px',
                fontSize: 12.5,
                color: 'var(--gray-800)',
                lineHeight: 1.5,
              }}
            >
              <Markdown>{s.intro}</Markdown>
            </div>
          )}
          <FileDiff file={s.stale ? null : fileFor(s.anchor)} />
          <StepDiscussion anchor={s.anchor} threads={threadsFor(s.anchor)} writes={writes} />
        </section>
      ))}

      {unstoried.length > 0 && (
        <section>
          <div style={{ padding: '12px 16px', background: 'var(--blue-tint)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--blue-press)' }}>
              {steps.length === 0 ? 'Changed files' : 'Other changes'} ({unstoried.length})
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--gray-600)' }}>
              {steps.length === 0
                ? 'This PR has no Stage storyline — here is the full diff.'
                : 'Not part of the storyline, but still in the PR diff.'}
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
              <StepDiscussion anchor={path} threads={threadsFor(path)} writes={writes} />
            </div>
          ))}
        </section>
      )}

      {/* Threads GitHub reports off any storyline step — surfaced, never dropped. */}
      {discussion && discussion.unanchored.length > 0 && (
        <section style={{ borderTop: '6px solid var(--hairline)' }}>
          <div style={{ padding: '12px 16px', background: 'var(--gray-50, #f7f7f8)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--gray-800)' }}>
              Other discussion ({discussion.unanchored.length})
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--gray-600)' }}>
              Threads not anchored to a storyline step.
            </div>
          </div>
          <div style={{ padding: '10px 16px' }}>
            {discussion.unanchored.map((t) => (
              <ThreadView key={t.id} thread={t} writes={writes} />
            ))}
          </div>
        </section>
      )}

      {steps.length === 0 && unstoried.length === 0 && (
        <div style={notice}>This PR's diff is empty.</div>
      )}
    </>
  );
}
