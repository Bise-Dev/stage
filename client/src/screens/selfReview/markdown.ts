/**
 * Comments → markdown. This *is* the Self-Review output artifact (Q5): the
 * user copies this and pastes it into a coding agent. Format defined in the
 * grill session; snippets capped at SNIPPET_LINE_CAP.
 */
import type { SelfReviewDiff, SelfReviewFileChange } from '../../tauri';
import type { Comment, Side } from './types';

const SNIPPET_LINE_CAP = 20;

export function commentsToMarkdown(diff: SelfReviewDiff, comments: Comment[]): string {
  const scopeLabel = diff.scope === 'workdir' ? 'uncommitted' : `vs ${diff.baseRef ?? 'base'}`;
  const fileCount = new Set(comments.map((c) => c.anchor.filePath)).size;
  const today = new Date().toISOString().slice(0, 10);

  const out: string[] = [];
  out.push(`# Self-Review — ${diff.currentBranch} (${scopeLabel})`);
  out.push(`${fileCount} files · ${comments.length} comments · ${today}`);
  out.push('');

  if (comments.length === 0) {
    out.push('(no comments)');
    return `${out.join('\n')}\n`;
  }

  // File order follows the diff payload — same as the sidebar — so an eyeball
  // scan of the markdown matches the screen scan.
  const fileOrder = new Map<string, number>();
  diff.files.forEach((f, i) => fileOrder.set(f.path, i));
  const byFile = new Map<string, Comment[]>();
  for (const c of comments) {
    const arr = byFile.get(c.anchor.filePath) ?? [];
    arr.push(c);
    byFile.set(c.anchor.filePath, arr);
  }
  const orderedPaths = [...byFile.keys()].sort(
    (a, b) =>
      (fileOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (fileOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
  );

  for (const path of orderedPaths) {
    out.push(`## ${path}`);
    const file = diff.files.find((f) => f.path === path);
    const list = byFile.get(path) ?? [];
    for (const c of list) {
      for (const line of renderComment(c, file)) out.push(line);
    }
    out.push('');
  }

  return `${out.join('\n').trimEnd()}\n`;
}

function renderComment(c: Comment, file: SelfReviewFileChange | undefined): string[] {
  const a = c.anchor;
  const lines: string[] = [];

  if (a.kind === 'line') {
    const range = a.lineStart === a.lineEnd ? `L${a.lineStart}` : `L${a.lineStart}–${a.lineEnd}`;
    const statusTag = file ? ` (${file.status})` : '';
    lines.push(`- **${range}**${statusTag}: ${c.body}`);
    if (file?.patch && !file.isBinary) {
      const snippet = extractSnippet(file.patch, a.side, a.lineStart, a.lineEnd);
      if (snippet && snippet.length > 0) {
        const lang = inferLanguage(file.path);
        const fence = '```';
        lines.push(`  ${fence}${lang}`);
        for (const l of snippet) lines.push(`  ${l}`);
        lines.push(`  ${fence}`);
      }
    }
  } else if (a.kind === 'file') {
    lines.push(`- **file-level**: ${c.body}`);
  } else {
    const orig = a.originalAnchor;
    const tag = orig.kind === 'line' ? `L${orig.lineStart}–${orig.lineEnd}` : 'file-level';
    lines.push(`- **${tag}** (dangling): ${c.body}`);
  }

  for (const r of c.replies) lines.push(`  - reply: ${r.body}`);
  return lines;
}

/**
 * Walk a unified diff and collect the source lines that fall in
 * `[lineStart, lineEnd]` on the requested side. Cap at SNIPPET_LINE_CAP +
 * a sentinel line indicating how many more were elided.
 *
 * `side === 'right'` collects `+` and context lines (the post-change file);
 * `side === 'left'` collects `-` and context lines (the pre-change file).
 */
function extractSnippet(
  patch: string,
  side: Side,
  lineStart: number,
  lineEnd: number,
): string[] | null {
  const collected: string[] = [];
  let leftNo = 0;
  let rightNo = 0;
  let inHunk = false;
  let overflow = 0;

  for (const raw of patch.split('\n')) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      leftNo = Number.parseInt(hunk[1], 10);
      rightNo = Number.parseInt(hunk[2], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"

    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      const lineNo = rightNo;
      rightNo += 1;
      if (side !== 'right') continue;
      collectOne(raw.slice(1), lineNo);
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      const lineNo = leftNo;
      leftNo += 1;
      if (side !== 'left') continue;
      collectOne(raw.slice(1), lineNo);
    } else if (raw.startsWith(' ') || raw === '') {
      // Context: present on both sides; advance both counters.
      const lineNo = side === 'left' ? leftNo : rightNo;
      leftNo += 1;
      rightNo += 1;
      collectOne(raw.startsWith(' ') ? raw.slice(1) : raw, lineNo);
    }
  }

  function collectOne(body: string, lineNo: number) {
    if (lineNo < lineStart || lineNo > lineEnd) return;
    if (collected.length < SNIPPET_LINE_CAP) collected.push(body);
    else overflow += 1;
  }

  if (collected.length === 0) return null;
  if (overflow > 0) collected.push(`… (${overflow} more lines)`);
  return collected;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  cpp: 'cpp',
  c: 'c',
  h: 'c',
  hpp: 'cpp',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  xml: 'xml',
};
function inferLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANG[ext] ?? '';
}
