import { useCallback, useEffect, useRef, useState } from 'react';
import type { SelfReviewDiff, SelfReviewFileChange } from '../../tauri';
import { commentsToMarkdown } from './markdown';
import type {
  Anchor,
  Comment,
  ComposerTarget,
  DanglingAnchor,
  FileAnchor,
  LineAnchor,
} from './types';

function newId(): string {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Walk a unified patch and emit the set of line numbers present per side. We
 * use this to detect a comment whose anchor lines no longer exist after an
 * edit — e.g. an edit removed lines 50–52 and the user had a comment there.
 */
function indexFileLines(file: SelfReviewFileChange): {
  left: Set<number>;
  right: Set<number>;
} {
  const left = new Set<number>();
  const right = new Set<number>();
  if (!file.patch || file.isBinary) return { left, right };

  let leftNo = 0;
  let rightNo = 0;
  for (const raw of file.patch.split('\n')) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      leftNo = Number.parseInt(hunk[1], 10);
      rightNo = Number.parseInt(hunk[2], 10);
      continue;
    }
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      right.add(rightNo);
      rightNo += 1;
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      left.add(leftNo);
      leftNo += 1;
    } else if (raw.startsWith(' ') || raw === '') {
      left.add(leftNo);
      right.add(rightNo);
      leftNo += 1;
      rightNo += 1;
    }
  }
  return { left, right };
}

function reconcileAnchor(anchor: Anchor, diff: SelfReviewDiff): Anchor {
  if (anchor.kind === 'dangling') return anchor;
  const file = diff.files.find((f) => f.path === anchor.filePath);
  if (!file) {
    return {
      kind: 'dangling',
      filePath: anchor.filePath,
      originalAnchor: anchor,
      reason: 'file_gone',
    } satisfies DanglingAnchor;
  }
  if (anchor.kind === 'file') return anchor;
  const { left, right } = indexFileLines(file);
  const set = anchor.side === 'left' ? left : right;
  // A range is intact iff every line in [start, end] is still present.
  for (let n = anchor.lineStart; n <= anchor.lineEnd; n += 1) {
    if (!set.has(n)) {
      return {
        kind: 'dangling',
        filePath: anchor.filePath,
        originalAnchor: anchor,
        reason: 'line_gone',
      } satisfies DanglingAnchor;
    }
  }
  return anchor;
}

export type UseSelfReviewComments = {
  comments: Comment[];
  composer: ComposerTarget | null;
  startLineComment(anchor: LineAnchor): void;
  startFileComment(filePath: string): void;
  startReply(parentId: string): void;
  saveCurrent(body: string): void;
  /**
   * Direct one-shot create — used by the @git-diff-view widget slot path
   * (the library owns the composer slot, so we don't go through the React
   * composer state machine that the file/reply flows use).
   */
  saveLineComment(anchor: LineAnchor, body: string): void;
  cancelComposer(): void;
  deleteComment(id: string): void;
  /** Returns the markdown that was written to the clipboard. */
  copyAsMarkdown(): Promise<string>;
};

export function useSelfReviewComments(diff: SelfReviewDiff | null): UseSelfReviewComments {
  const [comments, setComments] = useState<Comment[]>([]);
  const [composer, setComposer] = useState<ComposerTarget | null>(null);

  // Branch-switch detection: when current_branch shifts we clear all drafts
  // (Q4-A). Anything else (head sha drift, file edits) goes through anchor
  // reconciliation, not clearing. We intentionally don't list `comments` as
  // a dep — reading it via state setters' updater fn would still let us log
  // the cleared count, but a dep would re-fire on every comment add and
  // wipe the in-progress composer.
  const lastBranchRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: diff-keyed by design (see comment)
  useEffect(() => {
    if (!diff) return;
    const prev = lastBranchRef.current;
    lastBranchRef.current = diff.currentBranch;
    if (prev !== null && prev !== diff.currentBranch) {
      // Q4-A: log the cleared count so it isn't silent.
      console.warn('self_review_branch_change_clear', {
        from: prev,
        to: diff.currentBranch,
        cleared: comments.length,
      });
      setComments([]);
      setComposer(null);
      return;
    }
    // Same branch: reconcile each anchor against the refreshed diff.
    setComments((cur) =>
      cur.map((c) => {
        const next = reconcileAnchor(c.anchor, diff);
        return next === c.anchor ? c : { ...c, anchor: next };
      }),
    );
    // We intentionally don't depend on `comments` here — that would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff]);

  const startLineComment = useCallback((anchor: LineAnchor) => {
    setComposer({ kind: 'new-line', anchor });
  }, []);

  const startFileComment = useCallback((filePath: string) => {
    setComposer({ kind: 'new-file', anchor: { kind: 'file', filePath } satisfies FileAnchor });
  }, []);

  const startReply = useCallback((parentId: string) => {
    setComposer({ kind: 'reply', parentId });
  }, []);

  const cancelComposer = useCallback(() => setComposer(null), []);

  const saveCurrent = useCallback(
    (body: string) => {
      if (!composer) return;
      const trimmed = body.trim();
      if (!trimmed) {
        setComposer(null);
        return;
      }
      const now = Date.now();
      if (composer.kind === 'reply') {
        setComments((cur) =>
          cur.map((c) =>
            c.id === composer.parentId
              ? { ...c, replies: [...c.replies, { id: newId(), body: trimmed, createdAt: now }] }
              : c,
          ),
        );
      } else {
        const next: Comment = {
          id: newId(),
          anchor: composer.anchor,
          body: trimmed,
          createdAt: now,
          replies: [],
        };
        setComments((cur) => [...cur, next]);
      }
      setComposer(null);
    },
    [composer],
  );

  const saveLineComment = useCallback((anchor: LineAnchor, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    const next: Comment = {
      id: newId(),
      anchor,
      body: trimmed,
      createdAt: Date.now(),
      replies: [],
    };
    setComments((cur) => [...cur, next]);
    setComposer(null);
  }, []);

  const deleteComment = useCallback((id: string) => {
    setComments((cur) => cur.filter((c) => c.id !== id));
  }, []);

  const copyAsMarkdown = useCallback(async () => {
    if (!diff) {
      throw new Error('self_review_copy_no_diff');
    }
    const md = commentsToMarkdown(diff, comments);
    await navigator.clipboard.writeText(md);
    return md;
  }, [diff, comments]);

  return {
    comments,
    composer,
    startLineComment,
    startFileComment,
    startReply,
    saveCurrent,
    saveLineComment,
    cancelComposer,
    deleteComment,
    copyAsMarkdown,
  };
}
