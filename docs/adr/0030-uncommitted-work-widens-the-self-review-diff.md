# ADR-0030 · "+ Uncommitted" widens the Self-Review diff instead of appending a section

**Status:** accepted
**Date:** 2026-09-03
**Amends:** the two-section Self-Review scope model (flag F4) and the `CONTEXT.md` **Self-Review** glossary entry.

## Context

Self-Review rendered its scope as **two stacked sections**: the committed diff
(`merge_base(base, HEAD) → HEAD`, tree-to-tree) as the reviewable unit, and —
when "+ Uncommitted" was on — the working-tree diff (`HEAD → index → workdir`)
appended below it under its own heading, in the sidebar and in the diff pane.

That split is wrong for the thing the author is actually doing. During
Self-Review the author is looking at *their branch's change*, and the fact that
some of it is committed and some of it isn't yet is an accident of when they
last ran `git commit`. A file they committed to on Monday and edited again this
morning appeared **twice** — two sidebar rows with the same path, two diff
blocks, two "viewed" states, two anchor spaces for notes — and neither block
showed the change as a whole. Reading them together meant mentally applying one
patch on top of the other.

The rest of the system had already settled on the merged reading:

- `SelfReviewScope::Base` — `merge_base(base, HEAD) → working tree` — has always
  produced exactly one entry per file, committed and uncommitted hunks in one
  patch.
- The `stage` CLI's `self-review scope` and the Debrief skill describe the
  reviewable set as "committed branch work **and** uncommitted edits" and read
  it from that Base-scope diff.
- `notes_with_outdated` already checked every committed-section anchor against
  the **Base-scope** diff, not the tree-to-tree one the screen was rendering —
  so with a dirty tree, line anchors could be called outdated against a diff the
  author was never shown.

Only the webview held the two-section model, and it was the surface where it
cost the most.

## Decision

**1 · "+ Uncommitted" is a scope switch, not a second section.** Off, the
reviewable diff is the committed one (`committed_diff`, ADR-0018) — exactly what
the PR will contain. On, it is the Base-scope diff
(`merge_base(base, HEAD) → working tree`). Either way the screen renders **one
list and one block per file**. A file with both committed and uncommitted work
shows up once, with all of it in a single patch.

**2 · One anchor space, keyed by path.** The section-qualified ids
(`c:<path>` / `u:<path>`) are gone: sidebar rows, diff blocks, scroll targets,
note buckets and viewed marks are all keyed by the file path. `NoteAnchor`'s
`uncommitted` flag stays on the wire so notes written before this ADR still
resolve to their file, and new notes are always written with `uncommitted:
false` — there is no longer a second section to distinguish.

**3 · Both scopes resolve the base the same way.** `SelfReviewScope::Base` now
goes through `resolve_base_commit`, preferring `origin/<base>` over a
possibly-stale local branch of the same name, as `committed_diff` already did
(ADR-0016/ADR-0018), and reports the ref it actually used. Toggling the switch
changes what the diff covers; it must never move the base underneath the author.

**4 · Viewed marks apply in both scopes.** The uncommitted section had no
"viewed" checkbox, on the reasoning that a working-tree edit has no blob to
anchor a mark to. With one merged block per file that carve-out would mean the
same row loses its checkbox whenever the author touches the file. Marks stay
content-anchored (F2b) and simply go stale when the content moves, which is what
they already do for a committed file that gets amended.

**5 · The committed-only scope still says what it is leaving out.** The warning
banner ("N uncommitted files are not part of this review") stays: it is the
honest counterpart to a scope that deliberately excludes work on disk.

## Considered alternatives

- **Merge the sidebar only, keep two diff blocks per path.** Rejected: it fixes
  the duplicate row and keeps the duplicate reading. The author still has to
  compose two patches in their head to see the change.
- **Always review the merged scope; drop the toggle.** Rejected: "what will the
  PR contain" is a real and different question, asked right before Ready to
  share — and it is the scope Storyline composition works in (ADR-0018).
- **Keep two sections but de-duplicate, showing a path in only one of them.**
  Rejected: whichever section wins, its patch is a partial account of the file.
- **Migrate stored `uncommitted: true` anchors to `false`.** Rejected as
  unnecessary: those anchors' right-side line numbers already refer to the
  working tree, which is the merged diff's right side, so they land correctly;
  and `notes_with_outdated` still checks them against the workdir diff, which is
  the stricter of the two.

## Consequences

- `useSectionedDiff` becomes `useReviewDiff`, returning one `diff` rather than a
  `committed` / `workdir` pair; it still fetches the workdir diff in both scopes
  for the current branch name and the toggle's badge count.
- `FileList`/`DiffPane` lose their `uncommittedFiles` props, the
  `committedId`/`uncommittedId`/`anchorId` helpers, and the `section` prop on a
  file block. "Copy as markdown" emits one list of `## path` sections with no
  "Uncommitted (working tree)" heading.
- With a dirty tree, a Self-Review with "+ Uncommitted" on now agrees
  line-for-line with what `stage self-review notes` computes staleness against.
- Notes written before this ADR against the uncommitted section keep their
  bodies and threads and render on their file's single block.
