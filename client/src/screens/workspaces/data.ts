/* Time formatting helpers for the Workspaces screen.
 *
 * Workspace/PR rows now come live from the repo-overview aggregator (see
 * docs/adr/0009) and local branches from gitLocalBranches — there is no stub
 * data left here.
 */

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** "2h ago", "3 days ago" — from an ISO timestamp. */
export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });
  for (const [unit, secs] of RELATIVE_UNITS) {
    if (seconds >= secs) return fmt.format(-Math.floor(seconds / secs), unit);
  }
  return 'just now';
}

/** Relative time from epoch seconds (UTC) — used for local-branch commit times. */
export function relativeTimeFromEpoch(seconds: number): string {
  return relativeTime(new Date(seconds * 1000).toISOString());
}
