import type { GithubCommentSide, GithubReview, GithubReviewComment } from '../../tauri';

/**
 * Pure helpers for rendering GitHub review activity in the reviewer storyline
 * viewer (Step 3). Kept out of the component so the anchoring / threading /
 * decision logic is easy to read and reason about in isolation.
 */

/** A review-comment thread: the root (top-level) comment plus its replies in
 *  chronological order. GitHub flattens threads — every reply carries
 *  `in_reply_to_id` pointing at the thread's root comment. */
export type GithubCommentThread = {
  root: GithubReviewComment;
  replies: GithubReviewComment[];
};

/** Where a comment anchors in the diff: a side + a 1-based line number on that
 *  side. `null` when the comment carries no usable position at all. */
export type CommentAnchor = { side: GithubCommentSide; line: number };

/** The set of line numbers actually present in a file's rendered diff, split by
 *  side. A RIGHT comment's `line` must be in `right`, a LEFT comment's in
 *  `left`, for it to anchor inline; otherwise it's an off-diff comment. */
export type VisibleLines = { left: Set<number>; right: Set<number> };

/**
 * Parse a unified-diff patch into the set of line numbers visible on each side.
 *
 * Walks each `@@ -oldStart,oldCount +newStart,newCount @@` hunk: context lines
 * advance (and are visible on) both sides, `+` lines the new (RIGHT) side, `-`
 * lines the old (LEFT) side. File-header lines (`---`/`+++`) and the
 * "\ No newline at end of file" marker are ignored. Tolerant of the header-less
 * GitHub patch and of the synthesized `---`/`+++` header the viewer prepends.
 */
export function parseVisibleLines(patch: string): VisibleLines {
  const left = new Set<number>();
  const right = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      // @@ -oldStart[,oldCount] +newStart[,newCount] @@
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
        inHunk = true;
      }
      continue;
    }
    if (!inHunk) continue; // pre-hunk header lines (---/+++)
    const c = raw[0];
    if (c === '+') {
      right.add(newLine);
      newLine += 1;
    } else if (c === '-') {
      left.add(oldLine);
      oldLine += 1;
    } else if (c === '\\') {
      // "\ No newline at end of file" — not a real line.
    } else {
      // Context line (' ' or, defensively, anything else): visible both sides.
      left.add(oldLine);
      right.add(newLine);
      oldLine += 1;
      newLine += 1;
    }
  }
  return { left, right };
}

/**
 * Group flat review comments into threads keyed by their root comment.
 *
 * A comment with `in_reply_to_id == null` is a root; replies attach to the root
 * whose id equals their `in_reply_to_id`. A reply whose root is missing from the
 * list (shouldn't happen, but be safe) is promoted to its own root so it's never
 * dropped (fail loud — every comment renders somewhere). Replies are sorted by
 * id (monotonic with creation on GitHub).
 */
export function groupCommentThreads(comments: GithubReviewComment[]): GithubCommentThread[] {
  const roots = new Map<number, GithubCommentThread>();
  for (const c of comments) {
    if (c.in_reply_to_id == null) {
      const existing = roots.get(c.id);
      if (existing) existing.root = c;
      else roots.set(c.id, { root: c, replies: [] });
    }
  }
  const orphans: GithubReviewComment[] = [];
  for (const c of comments) {
    if (c.in_reply_to_id == null) continue;
    const thread = roots.get(c.in_reply_to_id);
    if (thread) thread.replies.push(c);
    else orphans.push(c);
  }
  for (const o of orphans) roots.set(o.id, { root: o, replies: [] });
  const threads = [...roots.values()];
  for (const t of threads) t.replies.sort((a, b) => a.id - b.id);
  // Stable order: by root line then id, so the band/inline order is predictable.
  threads.sort((a, b) => a.root.id - b.root.id);
  return threads;
}

/** A thread's diff anchor: the root's current `line`/`side`, falling back to
 *  `original_line`/`original_side` when the comment has slid off the live diff
 *  (GitHub nulls `line` then). `null` when no position is available at all. */
export function threadAnchor(thread: GithubCommentThread): CommentAnchor | null {
  const r = thread.root;
  if (r.line != null && r.side != null) return { side: r.side, line: r.line };
  if (r.original_line != null) return { side: r.original_side ?? 'RIGHT', line: r.original_line };
  return null;
}

/** True when the thread anchors to a line that's actually rendered in the diff
 *  for the matching side — i.e. it can be shown inline rather than off-diff. */
export function isOnDiff(thread: GithubCommentThread, visible: VisibleLines): boolean {
  const a = threadAnchor(thread);
  if (!a) return false;
  return (a.side === 'LEFT' ? visible.left : visible.right).has(a.line);
}

/**
 * The current review verdict per reviewer, GitHub-style: for each user, their
 * most recent submitted review among APPROVED / CHANGES_REQUESTED / DISMISSED
 * decides. A trailing DISMISSED clears their verdict (they drop out). COMMENTED
 * and PENDING never set a verdict. Returns logins bucketed by their live state.
 */
export function reviewersByState(reviews: GithubReview[]): {
  approved: string[];
  changesRequested: string[];
} {
  const VERDICT: ReadonlySet<string> = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
  // Latest verdict-bearing review per login (by submitted_at, falling back to id).
  const latest = new Map<string, GithubReview>();
  for (const rev of reviews) {
    const login = rev.user?.login;
    if (!login || !VERDICT.has(rev.state)) continue;
    const cur = latest.get(login);
    if (!cur || sortKey(rev) >= sortKey(cur)) latest.set(login, rev);
  }
  const approved: string[] = [];
  const changesRequested: string[] = [];
  for (const [login, rev] of latest) {
    if (rev.state === 'APPROVED') approved.push(login);
    else if (rev.state === 'CHANGES_REQUESTED') changesRequested.push(login);
    // DISMISSED → no current verdict.
  }
  approved.sort();
  changesRequested.sort();
  return { approved, changesRequested };
}

function sortKey(rev: GithubReview): string {
  // submitted_at is ISO-8601, lexically sortable; fall back to a zero-padded id
  // so a missing timestamp still orders deterministically after dated reviews.
  return rev.submitted_at ?? `0000-00-00T00:00:00Z#${String(rev.id).padStart(12, '0')}`;
}
