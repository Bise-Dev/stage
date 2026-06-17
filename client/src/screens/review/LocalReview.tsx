import { DiffModeEnum, DiffView } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { TitleBar } from '../../components/TitleBar';
import {
  type PrRef,
  type ReviewerEntry,
  type SelfReviewFileChange,
  openUrl,
  reviewCheckoutBranch,
  reviewOpen,
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
 * One file's committed diff, rendered via `@git-diff-view`. Mirrors
 * `LocalStoryline`'s `FileDiff`: `file` is the matching {@link
 * SelfReviewFileChange} from the entry's full diff, or null when the step's
 * anchor is no longer in the diff (a stale step). We never fabricate a diff — a
 * missing/binary patch shows an explicit notice (fail-loud, CLAUDE.md).
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

/**
 * The local-first **reviewer entry** screen (ADR-0022 §6, milestone F: GAP-3 #93,
 * SL-4 reviewer side). Reached by `stage open <pr-url>`, which resolves the PR to
 * this clone by `origin` match. It opens the PR **read-only**: the PR head is
 * fetched, and the author's storyline + the tree-to-tree diff render with **no
 * working-tree mutation** — the reviewer walks the steps in the author's order.
 *
 * The lone exception is the user-confirmed "Check out this branch" action, which
 * checks the PR head out so the reviewer can build/run.
 *
 * Everything derived (the diff, the overlay, stale flags, Stage-vs-plain) is
 * computed in Rust ([`reviewOpen`]); this screen only renders the DTO.
 */
export function LocalReview({ pr, onBack }: { pr: PrRef; onBack: () => void }) {
  const [entry, setEntry] = useState<ReviewerEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The user-confirmed checkout (the lone working-tree mutation).
  const [confirming, setConfirming] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkedOut, setCheckedOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const e = await reviewOpen(pr);
        if (alive) setEntry(e);
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
  }, [pr]);

  const fileFor = useCallback(
    (path: string): SelfReviewFileChange | null =>
      entry?.diff.files.find((f) => f.path === path) ?? null,
    [entry],
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
                maxWidth: 360,
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

          {(loadError || checkoutError) && (
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
            </div>
          )}

          {loading ? (
            <div style={notice}>Resolving the PR and fetching its head…</div>
          ) : !entry ? (
            <div style={notice}>No PR loaded.</div>
          ) : (
            <ReviewWalk entry={entry} fileFor={fileFor} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Walk the storyline in the author's order (SL-4 reviewer side): each step shows
 * the author's intro + the anchored file's diff, then the overlay of changes
 * outside the storyline (GAP-4) so nothing is hidden. A plain PR (no storyline)
 * shows every changed file directly.
 */
function ReviewWalk({
  entry,
  fileFor,
}: {
  entry: ReviewerEntry;
  fileFor: (path: string) => SelfReviewFileChange | null;
}) {
  const { steps, unstoried } = entry;

  return (
    <div style={{ flex: 1, overflow: 'auto', background: '#fff' }}>
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
            </div>
          ))}
        </section>
      )}

      {steps.length === 0 && unstoried.length === 0 && (
        <div style={notice}>This PR's diff is empty.</div>
      )}
    </div>
  );
}
