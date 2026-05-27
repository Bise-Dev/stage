/* Data model + sources for the Workspaces screen.
 *
 * Only the "Open PRs" bucket is wired to live data today (githubPrs). The
 * Self-Review / Ready-to-share / In-review buckets have no backend yet and are
 * fed from the typed stubs below. See docs/NOT-IMPLEMENTED.md.
 *
 * Bucket vocabulary follows CONTEXT.md, not the design prototype:
 *   Self-Review    — a branch with no Workspace (author iterating locally)
 *   Ready to share — a Workspace created but not yet published (no PR)
 *   In review      — a published Workspace (has a GitHub PR)
 *   Open PRs       — a GitHub PR with no Stage Workspace (read-only passthrough)
 */

import type { GithubPrSearchItem } from '../../tauri';

/** Published-workspace states (the design's badge set, minus the banned ones). */
export type WorkspaceState =
  | 'draft'
  | 'ready-to-share'
  | 'in-review'
  | 'reviewing'
  | 'requested'
  | 'approved';

/** Self-Review: a branch with no Workspace. */
export interface BranchRow {
  id: string;
  branch: string;
  author: string;
  added: number;
  removed: number;
  updated: string;
}

/** A Workspace — either pre-publish ("Ready to share") or published ("In review"). */
export interface WorkspaceRow {
  id: string;
  branch: string;
  title: string;
  author: string;
  added: number;
  removed: number;
  updated: string;
  state: WorkspaceState;
  /** Set once published. Absent ⇒ pre-publish (Ready to share). */
  prNumber?: number;
  storyline: number;
  comments: number;
}

/** An open GitHub PR with no Workspace. Live (githubPrs) — branch/stats unknown. */
export interface ExternalPrRow {
  id: string;
  prNumber: number;
  title: string;
  author: string;
  updated: string;
  role: 'author' | 'reviewer';
  htmlUrl: string;
}

export const YOU = 'You';

/* ─── Stubs (no backend yet) ─────────────────────────────────────────── */

export const STUB_BRANCHES: BranchRow[] = [
  {
    id: 'br-edge-cases',
    branch: 'experiment/edge-cases',
    author: YOU,
    added: 31,
    removed: 14,
    updated: '5m ago',
  },
  {
    id: 'br-docs-typos',
    branch: 'docs/api-typos',
    author: YOU,
    added: 12,
    removed: 8,
    updated: 'yesterday',
  },
  {
    id: 'br-mira-cache',
    branch: 'mira/cache-key-fix',
    author: 'Mira Park',
    added: 18,
    removed: 6,
    updated: '3h ago',
  },
];

export const STUB_WORKSPACES: WorkspaceRow[] = [
  // Ready to share (workspace, no PR)
  {
    id: 'ws-stripe-webhook',
    branch: 'fix/stripe-webhook-retry',
    title: 'Idempotent retries for Stripe webhook handler',
    author: YOU,
    added: 64,
    removed: 22,
    updated: '12 min ago',
    state: 'draft',
    storyline: 0,
    comments: 0,
  },
  {
    id: 'ws-eslint-bump',
    branch: 'tooling/eslint-bump',
    title: 'Bump ESLint to 9 + fix new rule violations',
    author: YOU,
    added: 142,
    removed: 138,
    updated: '1h ago',
    state: 'ready-to-share',
    storyline: 3,
    comments: 0,
  },
  // In review (workspace + PR)
  {
    id: 'ws-checkout-v2',
    branch: 'feat/checkout-v2',
    title: 'Replace legacy checkout with multi-step flow',
    author: YOU,
    added: 412,
    removed: 87,
    updated: 'just now',
    state: 'in-review',
    prNumber: 482,
    storyline: 7,
    comments: 6,
  },
  {
    id: 'ws-dashboard-perf',
    branch: 'mira/dashboard-perf',
    title: 'Memoize dashboard widgets; drop redundant fetches',
    author: 'Mira Park',
    added: 138,
    removed: 96,
    updated: '2h ago',
    state: 'reviewing',
    prNumber: 481,
    storyline: 5,
    comments: 3,
  },
  {
    id: 'ws-sso-okta',
    branch: 'jon/sso-okta',
    title: 'Okta SSO provider behind feature flag',
    author: 'Jon Singh',
    added: 731,
    removed: 14,
    updated: 'yesterday',
    state: 'requested',
    prNumber: 479,
    storyline: 9,
    comments: 11,
  },
  {
    id: 'ws-empty-states',
    branch: 'sam/empty-states-polish',
    title: 'Empty state illustrations + copy pass',
    author: 'Sam Okafor',
    added: 92,
    removed: 38,
    updated: 'Mon',
    state: 'approved',
    prNumber: 478,
    storyline: 3,
    comments: 2,
  },
];

/* ─── Live: GitHub PRs → Open PRs bucket ─────────────────────────────── */

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** "2h ago", "3 days ago" — for github updated_at timestamps. */
export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });
  for (const [unit, secs] of RELATIVE_UNITS) {
    if (seconds >= secs) return fmt.format(-Math.floor(seconds / secs), unit);
  }
  return 'just now';
}

export function externalPrFromGithub(
  item: GithubPrSearchItem,
  role: 'author' | 'reviewer',
): ExternalPrRow {
  return {
    id: `pr-${item.number}`,
    prNumber: item.number,
    title: item.title,
    author: role === 'author' ? YOU : item.user.login,
    updated: relativeTime(item.updated_at),
    role,
    htmlUrl: item.html_url,
  };
}
