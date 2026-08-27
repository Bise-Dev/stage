import { type CSSProperties, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import type { SelfReviewProgress } from '../../generated/SelfReviewProgress';
import type { AgentSession, OverviewRow } from '../../tauri';

/**
 * The branch pills shared by the table row and the branch menu (ADR-0028 —
 * the menu is no longer table-local, so neither are the pills it renders).
 */

/** Purple "debrief · new" pill / muted "debrief" / orange "debrief · outdated"
 *  — straight off L2's derived `DebriefFreshness`. */
export function DebriefPill({ r }: { r: OverviewRow }) {
  const f = r.branchMeta?.debriefFreshness ?? null;
  if (f === null) return null;
  if (f === 'new') {
    return (
      <span
        className="badge badge-purple"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto' }}
      >
        <span style={{ width: 5, height: 5, borderRadius: 3, background: 'var(--purple)' }} />
        debrief · new
      </span>
    );
  }
  if (f === 'outdated') {
    return (
      <span className="badge badge-orange" style={{ flex: '0 0 auto' }}>
        debrief · outdated
      </span>
    );
  }
  return (
    <span style={{ fontSize: 10.5, color: 'var(--gray-500)', flex: '0 0 auto' }}>debrief</span>
  );
}

/** Ellipsis in the *middle* so a long session name keeps both its start and
 *  its distinguishing tail readable (task names often share a prefix). CSS
 *  `text-overflow` can only cut the end, so this is done in text. */
function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** The live Claude Code session pill (opt-in via Settings): the session's
 *  name and status, exactly as Claude Code reports them. Right-click copies
 *  the `claude --resume` command for the session — and stops there, so the
 *  row's own context menu (ADR-0028) doesn't open on top of it. Claude
 *  terracotta while the session is busy — the working sibling of the
 *  DebriefPill it later hands off to. Shared by the branch rows and the
 *  "no worktree yet" tail. */
export function AgentSessionPill({
  s,
}: {
  s: Pick<AgentSession, 'name' | 'status' | 'sessionId'> | null;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  if (!s) return null;
  const busy = s.status === 'busy';
  const copyResume = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(`claude --resume ${s.sessionId}`);
      setCopied(true);
    } catch (err) {
      // Clipboard denial is the only failure here; the pill itself is fine.
      console.warn('agent_session_copy_failed', err);
    }
  };
  return (
    <span
      className={`badge ${busy ? 'badge-claude' : ''}`}
      onContextMenu={copyResume}
      title={`Claude Code session "${s.name}" — ${s.status}. Right-click to copy the resume command.`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        flex: '0 0 auto',
        maxWidth: 220,
      }}
    >
      <span style={{ flex: '0 0 auto', display: 'inline-flex' }}>
        <Icon name="claude" size={9} color={busy ? 'var(--claude)' : 'var(--gray-400)'} />
      </span>
      {copied ? (
        'resume command copied'
      ) : (
        <span style={{ whiteSpace: 'nowrap' }}>
          {middleTruncate(s.name, 26)} · {busy ? 'working' : s.status}
        </span>
      )}
    </span>
  );
}

/**
 * Has the author started reviewing this branch locally? Either local signal
 * counts: a file marked viewed, **or** a note written. Notes matter on their
 * own — commenting without marking anything viewed is a real way to work, and
 * a viewed-only test reads that branch as untouched.
 */
export function selfReviewStarted(sr: SelfReviewProgress | null | undefined): boolean {
  return !!sr && (sr.viewed > 0 || sr.notes > 0);
}

/** Shared shell for the blue self-review pill (progress and started alike). */
const SR_PILL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '2px 7px 2px 6px',
  borderRadius: 20,
  background: 'var(--blue-tint)',
  border: '1px solid rgba(0,122,255,0.28)',
  flex: '0 0 auto',
};

const SR_TEXT: CSSProperties = { fontSize: 10.5, fontWeight: 700, color: 'var(--blue-press)' };

/** `n note(s)`, or '' when there are none — the notes half of the tooltip. */
function noteSuffix(notes: number): string {
  return notes > 0 ? ` · ${notes} note${notes === 1 ? '' : 's'}` : '';
}

/** Blue pill while a self-review is underway (the done state was removed in L7
 *  — F3 rescinded). Two shapes off the same signals: viewed/total progress from
 *  the content-anchored marks, or — when notes are the only thing there — a
 *  plain "started", since a 0/N bar would read as untouched. */
export function SelfReviewPill({ sr }: { sr: SelfReviewProgress | null }) {
  if (!sr || !selfReviewStarted(sr)) return null;
  if (sr.viewed === 0) {
    return (
      <span title={`Self-review started${noteSuffix(sr.notes)}`} style={SR_PILL}>
        <Icon name="comment-fill" size={9} color="var(--blue)" />
        <span style={SR_TEXT}>self-review · started</span>
      </span>
    );
  }
  const pct = sr.total > 0 ? Math.min(100, Math.round((sr.viewed / sr.total) * 100)) : 0;
  return (
    <span
      title={`Self-review in progress · ${sr.viewed}/${sr.total} files viewed${noteSuffix(sr.notes)}`}
      style={SR_PILL}
    >
      <span
        style={{
          position: 'relative',
          width: 22,
          height: 4,
          borderRadius: 2,
          background: 'rgba(0,122,255,0.2)',
          display: 'inline-block',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            height: '100%',
            width: `${pct}%`,
            borderRadius: 2,
            background: 'var(--blue)',
          }}
        />
      </span>
      <span style={SR_TEXT}>
        {sr.viewed}/{sr.total}
      </span>
      {sr.notes > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, ...SR_TEXT }}>
          <Icon name="comment-fill" size={9} color="var(--blue)" />
          {sr.notes}
        </span>
      )}
    </span>
  );
}
