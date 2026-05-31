/**
 * Self-Review comment + anchor model — see grill-with-docs Q4/Q10 and
 * docs/adr/0010. Comments live in React state only; the markdown export is
 * the artifact, not the comments themselves.
 */

/** Maps to @git-diff-view/react's SplitSide: 'left' = deletion, 'right' = addition. */
export type Side = 'left' | 'right';

/** A comment attached to a contiguous line range in a single file's diff. */
export type LineAnchor = {
  kind: 'line';
  filePath: string;
  side: Side;
  /** 1-indexed line numbers in the file as it exists on `side`. */
  lineStart: number;
  lineEnd: number;
};

/** A comment attached to a whole file (no line context). */
export type FileAnchor = {
  kind: 'file';
  filePath: string;
};

/**
 * An anchor whose target no longer exists in the refreshed diff. Surfaced
 * collapsed at the top of the file's diff card so the user knows there are
 * notes that need a new home (or copy-to-markdown + delete).
 */
export type DanglingAnchor = {
  kind: 'dangling';
  filePath: string;
  originalAnchor: LineAnchor | FileAnchor;
  reason: 'line_gone' | 'file_gone';
};

export type Anchor = LineAnchor | FileAnchor | DanglingAnchor;

export type Reply = {
  id: string;
  body: string;
  createdAt: number;
};

export type Comment = {
  id: string;
  anchor: Anchor;
  body: string;
  createdAt: number;
  replies: Reply[];
};

/** Single active composer at a time (Q10). */
export type ComposerTarget =
  | { kind: 'new-line'; anchor: LineAnchor }
  | { kind: 'new-file'; anchor: FileAnchor }
  | { kind: 'reply'; parentId: string };
