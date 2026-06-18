import { useCallback, useEffect, useState } from 'react';

import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { TitleBar } from '../../components/TitleBar';
import {
  type DashboardRow,
  type PrRef,
  type ReviewStatus,
  dashboardOverview,
  openUrl,
} from '../../tauri';

/**
 * The per-repo dashboard (DB-1..5 #84–88, ADR-0022 §6/§7). A **pure renderer**:
 * Rust assembles the local-store draft scan + the `gh` PR search into view-ready
 * rows with all state already derived (status, signal, the Stage-vs-plain flag,
 * archived), and this screen only displays them. It derives nothing — no `gh`,
 * `git`, or `.stage` reads here. A published row opens in the local-first reviewer
 * (milestone F); the external ↗ still links out to github.com.
 */

/** Parse `{owner}/{name}#{number}` out of a PR's github.com URL
 *  (`https://github.com/{owner}/{name}/pull/{n}`). Returns null on any shape we
 *  don't recognise (fail-soft: the row falls back to the GitHub external link). */
function prRefFromUrl(url: string | null): PrRef | null {
  if (!url) return null;
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], name: m[2], number: Number(m[3]) };
}

/** Status badge text + colour. Status is derived in Rust (WS-5), never stored. */
const STATUS_BADGE: Record<ReviewStatus, { label: string; color: string; bg: string }> = {
  draft: { label: 'Draft', color: '#6b6b6b', bg: 'rgba(120,120,120,0.12)' },
  open: { label: 'Open', color: '#1f6feb', bg: 'rgba(31,111,235,0.12)' },
  approved: { label: 'Approved', color: '#1a7f37', bg: 'rgba(26,127,55,0.12)' },
  changes_requested: {
    label: 'Changes requested',
    color: '#bc4c00',
    bg: 'rgba(188,76,0,0.12)',
  },
  merged: { label: 'Merged', color: '#8250df', bg: 'rgba(130,80,223,0.12)' },
  closed: { label: 'Closed', color: '#cf222e', bg: 'rgba(207,34,46,0.12)' },
};

function StatusBadge({ status }: { status: ReviewStatus }) {
  const s = STATUS_BADGE[status];
  return (
    <span
      style={{
        flex: '0 0 auto',
        fontSize: 11,
        fontWeight: 600,
        color: s.color,
        background: s.bg,
        borderRadius: 'var(--r-sm)',
        padding: '1px 7px',
        whiteSpace: 'nowrap',
      }}
    >
      {s.label}
    </span>
  );
}

function Row({ row, onOpenReview }: { row: DashboardRow; onOpenReview: (pr: PrRef) => void }) {
  const pr = prRefFromUrl(row.url);
  // A published row (has a PR) opens in the local-first reviewer; a pre-publish
  // draft (no PR) isn't openable from here yet — compose it from its branch.
  const open = () => {
    if (pr) onOpenReview(pr);
    else if (row.url) openUrl(row.url).catch((e) => console.warn('open_url_failed', e));
  };
  const clickable = pr !== null || row.url !== null;
  return (
    <button
      type="button"
      onClick={clickable ? open : undefined}
      disabled={!clickable}
      title={pr ? 'Open in Stage' : clickable ? 'Open on GitHub' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        textAlign: 'left',
        padding: '8px 10px',
        border: '1px solid var(--border, rgba(0,0,0,0.08))',
        borderRadius: 'var(--r-sm)',
        background: row.archived ? 'rgba(0,0,0,0.02)' : '#fff',
        opacity: row.archived ? 0.7 : 1,
        cursor: clickable ? 'pointer' : 'default',
        font: 'inherit',
      }}
    >
      {/* Stage-guided vs plain (DB-2): a Stage review carries a doc-stack mark. */}
      <span
        title={row.stageGuided ? 'Stage-guided review' : 'Plain pull request'}
        style={{ flex: '0 0 auto', display: 'flex', color: 'var(--gray-500)' }}
      >
        <Icon name={row.stageGuided ? 'doc-stack' : 'gh'} size={14} />
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {row.title}
          {row.prNumber !== null && (
            <span style={{ color: 'var(--gray-400)', fontWeight: 400 }}> #{row.prNumber}</span>
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--gray-500)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 1,
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 220,
            }}
          >
            <Icon name="branch" size={11} />
            {row.branch}
          </span>
          {!row.stageGuided && <span title="Author skipped Stage">plain</span>}
          {row.role === 'reviewer' && <span>by {row.authorLogin}</span>}
        </div>
      </div>

      {/* Signal (DB-2): ±lines + comment count. */}
      <span style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: '#1a7f37', fontVariantNumeric: 'tabular-nums' }}>
          +{row.signal.added}
        </span>
        <span style={{ fontSize: 11, color: '#cf222e', fontVariantNumeric: 'tabular-nums' }}>
          −{row.signal.removed}
        </span>
        {row.signal.comments > 0 && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--gray-500)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
            }}
          >
            <Icon name="comment-fill" size={11} />
            {row.signal.comments}
          </span>
        )}
      </span>

      <StatusBadge status={row.status} />
    </button>
  );
}

function Group({
  title,
  rows,
  onOpenReview,
}: {
  title: string;
  rows: DashboardRow[];
  onOpenReview: (pr: PrRef) => void;
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        className="section-label"
        style={{ padding: '0 2px', marginBottom: 6, display: 'flex', gap: 6 }}
      >
        {title}
        <span style={{ color: 'var(--gray-400)' }}>{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--gray-400)', padding: '4px 2px' }}>
          Nothing here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((row) => (
            <Row
              key={`${row.role}:${row.prNumber ?? row.branch}`}
              row={row}
              onOpenReview={onOpenReview}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Dashboard({
  onBack,
  onOpenReview,
}: {
  onBack: () => void;
  onOpenReview: (pr: PrRef) => void;
}) {
  const [rows, setRows] = useState<DashboardRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);

  const load = useCallback(async (withArchived: boolean) => {
    setLoading(true);
    try {
      const view = await dashboardOverview(withArchived);
      setRows(view.rows);
      setError(null);
    } catch (e) {
      // Fail loud (CLAUDE.md): render the verbatim cause, never a fallback list.
      setError(String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(includeArchived);
  }, [load, includeArchived]);

  const yours = rows.filter((r) => r.role === 'author');
  const review = rows.filter((r) => r.role === 'reviewer');
  const archivedCount = rows.filter((r) => r.archived).length;

  return (
    <div className="stage">
      <div className="win">
        <TitleBar
          title="Stage"
          right={
            <button
              type="button"
              className="btn"
              onClick={onBack}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Icon name="chevron-left" size={12} />
              Home
            </button>
          }
        />
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 18px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 14,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700 }}>Dashboard</div>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => setIncludeArchived((v) => !v)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                background: 'none',
                border: 'none',
                padding: '2px',
                cursor: 'pointer',
                fontSize: 11.5,
                color: 'var(--gray-500)',
              }}
            >
              <Icon name="eye" size={12} color="var(--gray-500)" />
              {includeArchived
                ? 'Hide archived'
                : `Show archived${archivedCount ? ` (${archivedCount})` : ''}`}
            </button>
          </div>

          {error && (
            <ErrorBanner
              title="Couldn't load the dashboard"
              detail={error}
              onClose={() => setError(null)}
            />
          )}

          {loading && rows.length === 0 && !error ? (
            <div style={{ fontSize: 12, color: 'var(--gray-400)', padding: '8px 2px' }}>
              Loading…
            </div>
          ) : (
            <>
              <Group title="Authored by you" rows={yours} onOpenReview={onOpenReview} />
              <Group title="Awaiting your review" rows={review} onOpenReview={onOpenReview} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
