/**
 * Review notes → markdown. A secondary convenience export (ADR-0012): the
 * store/CLI is the primary channel the agent reads, but "Copy as markdown"
 * still serves agents/contexts not wired to the `stage` CLI. Renders *all*
 * notes (with status tags + threads); snippets capped at SNIPPET_LINE_CAP.
 */
import type { SelfReviewFileChange, SelfReviewNoteView, Side } from '../../tauri';

const SNIPPET_LINE_CAP = 20;

const STATUS_TAG: Record<SelfReviewNoteView['status'], string> = {
  open: 'open',
  addressed: 'addressed',
  resolved: 'resolved',
};

export function notesToMarkdown(
  branch: string,
  baseRef: string | null,
  files: SelfReviewFileChange[],
  /** The uncommitted section's files — their notes render under their own
   *  heading, and their snippets must come from *this* diff, not the
   *  committed one (same path, different line numbers). */
  uncommittedFiles: SelfReviewFileChange[],
  notes: SelfReviewNoteView[],
): string {
  const scopeLabel = `vs ${baseRef ?? 'base'}`;
  const anchored = notes.filter((n) => n.anchor !== null);
  const general = notes.filter((n) => n.anchor === null);
  // Section-qualified: the same path in both sections is two review targets.
  const fileCount = new Set(
    anchored.map((n) => `${n.anchor?.uncommitted ? 'u' : 'c'}:${n.anchor?.file}`),
  ).size;
  const today = new Date().toISOString().slice(0, 10);

  const out: string[] = [];
  out.push(`# Self-Review — ${branch} (${scopeLabel})`);
  out.push(`${fileCount} files · ${notes.length} notes · ${today}`);
  out.push('');

  if (notes.length === 0) {
    out.push('(no notes)');
    return `${out.join('\n')}\n`;
  }

  // Two passes, one per Self-Review section: the committed diff first, then
  // the working tree. A path can appear in both with different line numbers,
  // so they never share a heading — and each note's snippet is read from its
  // own section's patch.
  emitSection(out, 'committed', files, anchored);
  emitSection(out, 'uncommitted', uncommittedFiles, anchored);

  if (general.length > 0) {
    out.push('## General');
    for (const n of general) {
      for (const line of renderNote(n, undefined)) out.push(line);
    }
    out.push('');
  }

  return `${out.join('\n').trimEnd()}\n`;
}

/** Emit `## path` blocks for one section's notes, in the section's own file
 *  order — same as the sidebar — so an eyeball scan of the markdown matches the
 *  screen scan. Files not in this section's diff sort last (still emitted; a
 *  note is never dropped for having lost its file). */
function emitSection(
  out: string[],
  section: 'committed' | 'uncommitted',
  files: SelfReviewFileChange[],
  anchored: SelfReviewNoteView[],
): void {
  const uncommitted = section === 'uncommitted';
  const mine = anchored.filter((n) => (n.anchor?.uncommitted ?? false) === uncommitted);
  if (mine.length === 0) return;

  const fileOrder = new Map<string, number>();
  files.forEach((f, i) => fileOrder.set(f.path, i));
  const byFile = new Map<string, SelfReviewNoteView[]>();
  for (const n of mine) {
    const file = n.anchor?.file;
    if (!file) continue;
    const arr = byFile.get(file) ?? [];
    arr.push(n);
    byFile.set(file, arr);
  }
  const orderedPaths = [...byFile.keys()].sort(
    (a, b) =>
      (fileOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (fileOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
  );

  if (uncommitted) {
    out.push('## Uncommitted (working tree)');
    out.push('');
  }
  for (const path of orderedPaths) {
    out.push(`## ${path}${uncommitted ? ' *(uncommitted)*' : ''}`);
    const file = files.find((f) => f.path === path);
    for (const n of byFile.get(path) ?? []) {
      for (const line of renderNote(n, file)) out.push(line);
    }
    out.push('');
  }
}

function renderNote(n: SelfReviewNoteView, file: SelfReviewFileChange | undefined): string[] {
  const lines: string[] = [];
  const a = n.anchor;
  const tags = `[${STATUS_TAG[n.status]}${n.outdated ? ', outdated' : ''}]`;

  if (a && a.lineStart != null) {
    const range =
      a.lineEnd == null || a.lineEnd === a.lineStart
        ? `L${a.lineStart}`
        : `L${a.lineStart}–${a.lineEnd}`;
    const statusTag = file ? ` (${file.status})` : '';
    lines.push(`- **${range}**${statusTag} ${tags}: ${n.body}`);
    if (file?.patch && !file.isBinary) {
      const snippet = extractSnippet(
        file.patch,
        a.side ?? 'right',
        a.lineStart,
        a.lineEnd ?? a.lineStart,
      );
      if (snippet && snippet.length > 0) {
        const lang = inferLanguage(file.path);
        const fence = '```';
        lines.push(`  ${fence}${lang}`);
        for (const l of snippet) lines.push(`  ${l}`);
        lines.push(`  ${fence}`);
      }
    }
  } else if (a) {
    lines.push(`- **file-level** ${tags}: ${n.body}`);
  } else {
    lines.push(`- **general** ${tags}: ${n.body}`);
  }

  // The thread: each reply tagged by author.
  for (const r of n.replies) lines.push(`  - ${r.author}: ${r.body}`);
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
    } else if (raw.startsWith(' ')) {
      // Context: present on both sides; advance both counters.
      const lineNo = side === 'left' ? leftNo : rightNo;
      leftNo += 1;
      rightNo += 1;
      collectOne(raw.slice(1), lineNo);
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

/**
 * Same map, exported for callers that need to decide whether to pass
 * `fileLang` to the diff renderer at all (passing an unknown extension
 * triggers the lowlight `"not support current lang: <ext> yet"` warning).
 */
export function inferDiffLanguage(path: string): string | undefined {
  const lang = inferLanguage(path);
  return lang ? lang : undefined;
}
