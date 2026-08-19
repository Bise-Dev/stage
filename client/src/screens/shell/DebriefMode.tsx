import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from '../../components/Icon';
import {
  type DebriefFreshness,
  type SelfReviewFileChange,
  selfReviewDebriefMarkSeen,
} from '../../tauri';
import { relativeTimeFromEpoch } from '../../time';
import { CommentableFileDiff, type ViewMode } from '../selfReview/CommentableFileDiff';
import { SHELL_MODES, type ShellModeBodyProps } from './modes';
import { useSectionedDiff } from './useSectionedDiff';

const STATUS_BADGE = {
  added: { label: 'added', cls: 'badge-green' },
  modified: { label: 'modified', cls: 'badge-orange' },
  deleted: { label: 'deleted', cls: 'badge-red' },
  renamed: { label: 'renamed', cls: 'badge-purple' },
} as const;

const FRESHNESS_BADGE: Record<DebriefFreshness, { label: string; cls: string }> = {
  new: { label: 'new', cls: 'badge-purple' },
  seen: { label: 'seen', cls: '' },
  outdated: { label: 'outdated', cls: 'badge-orange' },
};

/**
 * Debrief mode of the review shell (v6-light L5) — the full-screen viewer for
 * the agent's account of the branch: the left rail is the chaptered timeline,
 * the center walks chapter by chapter (title, the agent's one intro, then the
 * chapter's file diffs), and unnarrated files trail as "Everything else"
 * (ADR-0025's appendix rule, applied to the same shape).
 *
 * Per flag F7 there is deliberately no inline agent thread and no "ask the
 * agent" composer — the chapter intros carry the narrative, and author↔agent
 * Q&A lives in Self-Review notes. Diffs render read-only here.
 *
 * The Debrief describes the branch as the agent left it (committed +
 * uncommitted, decision record), so the working-tree section defaults ON when
 * the branch is checked out; a non-checked-out branch renders committed
 * tree-to-tree (ADR-0027: reading never mutates).
 */
export function DebriefMode({
  shell,
  debriefState,
  onExit,
  onStartSelfReview,
}: ShellModeBodyProps) {
  const cfg = SHELL_MODES.debrief;
  const { debrief, error: debriefError } = debriefState;
  const [viewMode, setViewMode] = useState<ViewMode>('unified');

  // The Debrief renders against ITS recorded base, not the author's picker.
  const {
    committed,
    workdir,
    includeUncommitted,
    setIncludeUncommitted,
    uncommittedCount,
    loading,
    error,
  } = useSectionedDiff(shell.repoPath, debrief?.base ?? null, { ephemeralDefaultOn: true });

  // Opening the viewer is what "seen" means (flag F3's debrief sibling):
  // mark once per head SHA — a fresh agent pass re-runs this.
  const markedRef = useRef<string | null>(null);
  const [markSeenError, setMarkSeenError] = useState<string | null>(null);
  useEffect(() => {
    if (!debrief || markedRef.current === debrief.headSha) return;
    markedRef.current = debrief.headSha;
    selfReviewDebriefMarkSeen().catch((e) => {
      markedRef.current = null; // retry on next open
      setMarkSeenError(`Couldn't mark this debrief as seen — ${String(e)}`);
    });
  }, [debrief]);

  // Escape exits (matches Self-Review mode).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') onExit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  const chapters = debrief?.chapters ?? [];
  const fileMeta = useMemo(() => {
    const m = new Map<string, SelfReviewFileChange>();
    for (const f of committed?.files ?? []) m.set(f.path, f);
    return m;
  }, [committed]);
  const narrated = useMemo(() => new Set(chapters.flatMap((c) => c.files)), [chapters]);
  // ADR-0025's appendix rule: files no chapter narrates still render, in
  // alphabetical (path) order, after the chapters.
  const everythingElse = useMemo(
    () =>
      (committed?.files ?? [])
        .filter((f) => !narrated.has(f.path))
        .sort((a, b) => a.path.localeCompare(b.path)),
    [committed, narrated],
  );

  // Timeline click → scroll the chapter (or appendix/uncommitted section)
  // into view.
  const sectionRefs = useRef(new Map<string, HTMLDivElement>());
  const registerSection = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) sectionRefs.current.set(id, el);
    else sectionRefs.current.delete(id);
  }, []);
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const scrollTo = useCallback((id: string) => {
    setSelectedSection(id);
    sectionRefs.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const branch = workdir?.currentBranch ?? '…';
  const freshness = debrief ? FRESHNESS_BADGE[debrief.freshness] : null;

  return (
    <>
      {/* Mode header — the shell's unified header structure, debrief-tinted. */}
      <div
        style={{
          height: 56,
          flex: '0 0 56px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 16px',
          background: '#fff',
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onExit}
          title="Back to Reviews — Esc"
          style={{ padding: '0 8px' }}
        >
          <Icon name="chevron-right" size={12} color="var(--gray-500)" />
          <span style={{ marginLeft: 4 }}>Reviews</span>
        </button>

        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 9px',
            borderRadius: 7,
            background: cfg.tint,
            border: `1px solid ${cfg.tintBd}`,
            flex: '0 0 auto',
          }}
        >
          <Icon name={cfg.icon} size={12} color={cfg.accent} />
          <span style={{ fontSize: 12.5, fontWeight: 700, color: cfg.press }}>{cfg.label}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {debrief && (
            <>
              <span className="badge mono" style={{ background: 'rgba(0,0,0,0.06)' }}>
                {debrief.base}
              </span>
              <Icon name="arrow-right" size={11} color="var(--gray-400)" />
            </>
          )}
          <span className="badge mono" style={{ background: cfg.tint, color: cfg.press }}>
            {branch}
          </span>
          <span className="badge badge-purple">from your agent</span>
          {freshness && <span className={`badge ${freshness.cls}`}>{freshness.label}</span>}
          {debrief && (
            <span style={{ fontSize: 11, color: 'var(--gray-500)' }}>
              updated {relativeTimeFromEpoch(debrief.updatedAt)}
            </span>
          )}
        </div>

        <div style={{ flex: 1 }} />

        {/* The working-tree section toggle — the Debrief targets latest state,
            so this defaults ON (per-open, not persisted). */}
        <button
          type="button"
          className="btn"
          onClick={() => setIncludeUncommitted(!includeUncommitted)}
          title={
            includeUncommitted
              ? 'Hide the working-tree section'
              : 'Show uncommitted changes as a separate section'
          }
          style={
            includeUncommitted
              ? {
                  background: 'rgba(255,149,0,0.10)',
                  borderColor: 'rgba(255,149,0,0.28)',
                  color: '#b56500',
                }
              : undefined
          }
        >
          {includeUncommitted ? '−' : '+'} Uncommitted
          {uncommittedCount !== null && uncommittedCount > 0 && (
            <span className="badge badge-orange" style={{ marginLeft: 6 }}>
              {uncommittedCount}
            </span>
          )}
        </button>
        <div className="seg" aria-label="Diff view mode">
          <button
            type="button"
            onClick={() => setViewMode('split')}
            className={viewMode === 'split' ? 'active' : undefined}
          >
            Split
          </button>
          <button
            type="button"
            onClick={() => setViewMode('unified')}
            className={viewMode === 'unified' ? 'active' : undefined}
          >
            Unified
          </button>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onStartSelfReview}
          title="Review these changes yourself — notes, viewed marks, Mark reviewed"
          style={{ background: cfg.accent, borderColor: 'rgba(0,0,0,0.1)' }}
        >
          <Icon name={cfg.primary.icon} size={12} color="#fff" /> {cfg.primary.label}
        </button>
      </div>

      {debriefError && <div style={errorBanner}>{debriefError}</div>}
      {error && <div style={errorBanner}>{error}</div>}
      {markSeenError && <div style={errorBanner}>{markSeenError}</div>}

      {!debrief ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 40,
          }}
        >
          <div style={{ maxWidth: 460, fontSize: 13, color: 'var(--gray-600)', lineHeight: 1.6 }}>
            <div
              style={{ fontSize: 15, fontWeight: 700, color: 'var(--gray-900)', marginBottom: 6 }}
            >
              No Debrief for this branch
            </div>
            Only your coding agent can start a Debrief. Ask it to run the{' '}
            <span className="mono">self-review-debrief</span> skill — it writes an ordered,
            chaptered account of its changes here for you to read before self-reviewing.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Left — the chaptered timeline (design `V6_Timeline`, chaptered). */}
          <div
            style={{
              width: 248,
              flex: '0 0 248px',
              borderRight: '1px solid var(--hairline)',
              background: '#fbfaf8',
              overflow: 'auto',
              padding: '13px 8px',
            }}
          >
            <div
              className="section-label"
              style={{
                paddingLeft: 8,
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Icon name={cfg.icon} size={11} color={cfg.accent} /> {cfg.timelineLabel} ·{' '}
              {chapters.length} chapter{chapters.length === 1 ? '' : 's'}
            </div>
            {chapters.map((ch, ci) => {
              const id = `ch:${ci}`;
              const on = selectedSection === id;
              return (
                <div key={ch.title} style={{ marginBottom: 8 }}>
                  <button
                    type="button"
                    onClick={() => scrollTo(id)}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 6,
                      width: '100%',
                      textAlign: 'left',
                      border: 'none',
                      background: on ? cfg.tint : 'transparent',
                      borderRadius: 6,
                      padding: '4px 8px 2px',
                      cursor: 'default',
                      fontFamily: 'inherit',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.06,
                        textTransform: 'uppercase',
                        color: on ? cfg.press : 'var(--gray-500)',
                      }}
                    >
                      Ch. {ci + 1}
                    </span>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gray-700)' }}>
                      {ch.title}
                    </span>
                  </button>
                  {ch.files.map((file) => {
                    const meta = fileMeta.get(file);
                    return (
                      <button
                        key={file}
                        type="button"
                        onClick={() => scrollTo(id)}
                        title={file}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          width: '100%',
                          textAlign: 'left',
                          border: 'none',
                          background: 'transparent',
                          borderRadius: 6,
                          padding: '4px 8px',
                          cursor: 'default',
                          fontFamily: 'inherit',
                        }}
                      >
                        <span
                          className="mono"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 11.5,
                            color: 'var(--gray-800)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {file.split('/').pop()}
                        </span>
                        {meta ? (
                          <span
                            style={{ fontSize: 10, color: 'var(--gray-500)', whiteSpace: 'nowrap' }}
                          >
                            <span style={{ color: 'var(--green-d)' }}>+{meta.additions}</span>{' '}
                            <span style={{ color: 'var(--red-d)' }}>−{meta.deletions}</span>
                          </span>
                        ) : (
                          <span
                            className="badge badge-orange"
                            title="No longer in the diff at this base"
                          >
                            stale
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {everythingElse.length > 0 && (
              <button
                type="button"
                onClick={() => scrollTo('else')}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  background: selectedSection === 'else' ? cfg.tint : 'transparent',
                  borderRadius: 6,
                  padding: '4px 8px',
                  cursor: 'default',
                  fontFamily: 'inherit',
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.06,
                    textTransform: 'uppercase',
                    color: 'var(--gray-500)',
                  }}
                >
                  Everything else · {everythingElse.length}
                </span>
              </button>
            )}
            {includeUncommitted && (workdir?.files.length ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => scrollTo('wd')}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  background: selectedSection === 'wd' ? cfg.tint : 'transparent',
                  borderRadius: 6,
                  padding: '4px 8px',
                  cursor: 'default',
                  fontFamily: 'inherit',
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.06,
                    textTransform: 'uppercase',
                    color: 'var(--orange)',
                  }}
                >
                  Uncommitted · {workdir?.files.length}
                </span>
              </button>
            )}
          </div>

          {/* Center — chapter blocks: header + the agent's intro + diffs. */}
          <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: 'var(--gray-50)' }}>
            {loading && !committed && (
              <div
                style={{ padding: 40, textAlign: 'center', color: 'var(--gray-500)', fontSize: 13 }}
              >
                Loading the diff…
              </div>
            )}
            {chapters.map((ch, ci) => (
              <div
                key={ch.title}
                ref={(el) => registerSection(`ch:${ci}`, el)}
                style={{ padding: '16px 22px 4px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 12,
                      background: cfg.accent,
                      color: '#fff',
                      fontSize: 12,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flex: '0 0 24px',
                    }}
                  >
                    {ci + 1}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--gray-900)' }}>
                    {ch.title}
                  </div>
                  <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
                    {ch.files.length} file{ch.files.length === 1 ? '' : 's'}
                  </span>
                </div>
                {/* The agent's one intro for the chapter (ADR-0025) — a tinted
                    note block; deliberately not a thread (flag F7). */}
                <div
                  style={{
                    display: 'flex',
                    gap: 9,
                    padding: '9px 11px',
                    background: cfg.tint,
                    border: `1px solid ${cfg.tintBd}`,
                    borderRadius: 'var(--r-md)',
                    marginBottom: 12,
                  }}
                >
                  <div style={{ flex: '0 0 18px', marginTop: 1 }}>
                    <Icon name="sparkle" size={14} color={cfg.accent} />
                  </div>
                  <div
                    className="md"
                    style={{ fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.5 }}
                  >
                    <Markdown remarkPlugins={[remarkGfm]}>{ch.intro}</Markdown>
                  </div>
                </div>
                {ch.files.map((file) => {
                  const meta = fileMeta.get(file);
                  if (!meta) {
                    return (
                      <div
                        key={file}
                        style={{
                          padding: '8px 12px',
                          marginBottom: 12,
                          background: 'rgba(255,149,0,0.06)',
                          border: '1px solid rgba(255,149,0,0.22)',
                          borderRadius: 'var(--r-md)',
                          fontSize: 12,
                          color: '#b56500',
                        }}
                      >
                        <span className="mono">{file}</span> is no longer in the diff against{' '}
                        <span className="mono">{debrief.base}</span> — the agent narrated a state
                        the branch has moved past.
                      </div>
                    );
                  }
                  return <DebriefFileBlock key={file} file={meta} viewMode={viewMode} />;
                })}
              </div>
            ))}

            {everythingElse.length > 0 && (
              <div ref={(el) => registerSection('else', el)} style={{ padding: '16px 22px 4px' }}>
                <div
                  className="section-label"
                  style={{ padding: '0 0 10px', color: 'var(--gray-500)' }}
                >
                  Everything else · {everythingElse.length}
                </div>
                {everythingElse.map((f) => (
                  <DebriefFileBlock key={f.path} file={f} viewMode={viewMode} />
                ))}
              </div>
            )}

            {includeUncommitted && (workdir?.files.length ?? 0) > 0 && (
              <div ref={(el) => registerSection('wd', el)} style={{ padding: '16px 22px 20px' }}>
                <div
                  className="section-label"
                  style={{ padding: '0 0 2px', color: 'var(--orange)' }}
                >
                  Uncommitted · {workdir?.files.length}
                </div>
                <div style={{ fontSize: 11, color: 'var(--gray-500)', padding: '0 0 10px' }}>
                  Working-tree changes the agent left uncommitted — part of the state it debriefed.
                </div>
                {(workdir?.files ?? []).map((f) => (
                  <DebriefFileBlock key={f.path} file={f} viewMode={viewMode} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** A read-only file diff block (no notes, no viewed toggle — flag F7). */
function DebriefFileBlock({ file, viewMode }: { file: SelfReviewFileChange; viewMode: ViewMode }) {
  const badge = STATUS_BADGE[file.status];
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r-md)',
        marginBottom: 14,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: 36,
          flex: '0 0 36px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 14px',
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <span
          className="mono"
          style={{ fontSize: 12.5, color: 'var(--gray-800)', fontWeight: 500 }}
        >
          {file.path}
        </span>
        <span className={`badge ${badge.cls}`}>{badge.label}</span>
        <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
          +{file.additions} −{file.deletions}
        </span>
        {file.isBinary && (
          <span className="badge" style={{ background: 'rgba(0,0,0,0.06)' }}>
            binary
          </span>
        )}
        {file.isTruncated && (
          <span className="badge badge-orange" title="Diff was clipped at 256 KB">
            truncated
          </span>
        )}
      </div>
      <CommentableFileDiff
        file={file}
        viewMode={viewMode}
        inlineAnchors={[]}
        renderInline={() => null}
      />
    </div>
  );
}

const errorBanner: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--red-d)',
  background: 'rgba(255,59,48,0.08)',
  border: '1px solid rgba(255,59,48,0.20)',
  borderRadius: 'var(--r-sm)',
  padding: '6px 10px',
  margin: '8px 16px 0',
};
