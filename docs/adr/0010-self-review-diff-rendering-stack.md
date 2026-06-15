# ADR-0010 · Diff rendering stack for the Self-Review screen

**Status:** accepted

The Self-Review screen ports an existing POC (`~/Projects/personal/local_pr_preview`) whose diff pane is built on `diff2html` + `highlight.js`, with comments grafted on by imperative DOM mutation (per-file Comment button injection, mousedown handlers on line-number cells, portals into diff2html's rendered HTML). The Stage v2 design's own technical recommendation went the other way — `@git-diff-view/react` + `shiki`, with comments as React widgets. We adopt the **React-first half** of the design's recommendation: the diff pane is `@git-diff-view/react`'s `DiffViewWithMultiSelect`, comments — inline (line/range) and file-level — render as widgets via the library's `renderExtendLine` / `renderWidgetLine` slots, and drag-to-select ranges flow through the library's built-in multi-select (`onAddWidgetClick` with `fromLineNumber`). Syntax highlighting stays on the library's bundled `lowlight` (highlight.js) for v1; the shiki integration the design suggested needs a custom `DiffHighlighter` adapter and is deferred to a follow-up PR.

## Considered options

- **Lift the POC's stack as-is** (`diff2html` + `highlight.js` + DOM-mutation comments) — rejected. It would ship working code faster, but every future Self-Review feature that wants richer per-line affordances (gutter icons, blame strips, virtualization for large diffs) would fight the imperative model. The fragility — diff2html-specific class selectors, post-render walks racing React — would compound. The cost of switching later is strictly higher than switching now.
- **Roll a custom diff renderer** — rejected. The POC proved diff merging + patch text is solvable in libgit2; rendering side-by-side syntax-highlighted diffs with widget slots is months of work to match a library.

## Consequences

- The POC's `DiffView.tsx`, `CommentOverlay.tsx`, range-selection logic, and `<mark>` text-node injection for search highlighting are **not direct ports** — they're a behavioral reference for a React-first redesign under `client/src/screens/selfReview/`.
- In-diff inline search highlighting is **deferred** out of this PR (only the file-list filter side of Cmd-F ships). Adding it back later is a pure visual layer on top of the existing filter index.
- Syntax highlighting uses the library's bundled `lowlight` (highlight.js) for v1. Migrating to `shiki` is a polish item: it requires implementing `DiffHighlighter` (`name`, `type`, language registration, AST conversion) and threading the engine through the library's `registerHighlighter` prop. Tracked as a follow-up.
- Drag-to-select line ranges flow through the library's `DiffViewWithMultiSelect` rather than the imperative pointerdown/mousemove/mouseup wiring the POC used. `onAddWidgetClick` fires with both `lineNumber` and `fromLineNumber` for ranges; we normalize start ≤ end on receive.
- We depend on a single library export (`DiffViewWithMultiSelect`); we pin the major to avoid silent regressions from breaking changes to its widget contract.
