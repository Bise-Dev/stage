import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from '../../components/Icon';

/**
 * The Debrief's inline presence in the diff (v6-light L7, §3b M1): a collapsed
 * chapter banner above the chapter's FIRST file's diff — title always visible,
 * the agent's one intro (ADR-0025) expandable in place. Deliberately not a
 * thread and not a full-screen mode: the narrative rides along the diff the
 * author is already reading; Q&A stays in Self-Review notes (flag F7).
 *
 * Collapse state is per-mount by design — a fresh open re-collapses.
 */

// The debrief accent (the retired mode's palette, kept for the agent voice).
const ACCENT = 'var(--purple)';
const PRESS = '#7b2cab';
const TINT = 'rgba(175,82,222,0.10)';
const TINT_BD = 'rgba(175,82,222,0.24)';

export type ChapterBannerData = {
  /** 1-based chapter number (presentation order). */
  index: number;
  title: string;
  /** The agent's markdown intro for the whole chapter. */
  intro: string;
  fileCount: number;
};

export function ChapterBanner({ chapter }: { chapter: ChapterBannerData }) {
  // Expanded by default — the intro is the chapter's narrative, not an aside.
  const [open, setOpen] = useState(true);
  return (
    <div
      style={{
        background: TINT,
        border: `1px solid ${TINT_BD}`,
        borderRadius: 'var(--r-md)',
        marginBottom: 10,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Collapse the chapter intro' : 'Read the chapter intro'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          textAlign: 'left',
          border: 'none',
          background: 'transparent',
          padding: '7px 12px',
          cursor: 'default',
          fontFamily: 'inherit',
        }}
      >
        <Icon name="sparkle" size={12} color={ACCENT} />
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: PRESS,
            flex: '0 0 auto',
          }}
        >
          Ch. {chapter.index}
        </span>
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--gray-800)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {chapter.title}
        </span>
        <span style={{ fontSize: 11, color: 'var(--gray-500)', flex: '0 0 auto' }}>
          {chapter.fileCount} file{chapter.fileCount === 1 ? '' : 's'}
        </span>
        <div style={{ flex: 1 }} />
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} color={PRESS} />
      </button>
      {open && (
        <div
          className="md"
          style={{
            padding: '2px 12px 10px 32px',
            fontSize: 12.5,
            color: 'var(--gray-800)',
            lineHeight: 1.5,
          }}
        >
          <Markdown remarkPlugins={[remarkGfm]}>{chapter.intro}</Markdown>
        </div>
      )}
    </div>
  );
}
