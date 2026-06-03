# ADR-0012 · Self-Review has one annotation concept: the threaded Review note

**Status:** accepted
**Date:** 2026-06-03
**Extends:** ADR-0011 (agent self-review is a local CLI + app store)

## Context

ADR-0011 introduced two ways to annotate a Self-Review diff that grew up
separately and never merged:

- **Ephemeral Comments** — React state only, file/line anchors (with a `side`),
  author reply threads. They existed solely to feed "Copy as markdown" and were
  **invisible to the agent** (never written to the store).
- **Review notes** — SQLite-backed, agent-readable via the `stage` CLI, with a
  single `agent_reply` and an `open → addressed → resolved` lifecycle. Created
  only from the rail, file-anchored.

The trap: the author naturally clicks the diff's **"Comment"** button — the
export-only kind — so their feedback never reaches the agent. Two systems, one
of them a dead end.

## Decision

Collapse the two into **one concept: the Review note**. Every annotation the
author makes during Self-Review is a persisted, agent-readable Review note.
The ephemeral Comment layer is retired.

Concretely:

1. **Decoupled from the Debrief.** A Review note is the author's annotation on a
   diff location, agent-readable whether or not a Debrief (or any agent) exists.
   The Debrief is no longer a precondition — it is what a note *may* respond to.
2. **Threaded.** The note keeps its `body` as the opening author post; a new
   `review_note_reply` table holds follow-up entries, each tagged
   `author | agent`. This replaces the single `agent_reply` column (backfilled
   into the table on migration).
3. **Status is maintained by posting.** Agent reply → `addressed`; an author
   reply on an `addressed` note re-raises it to `open`; `resolved` is the only
   terminal state and author-only. The CLI `address` verb stays "append agent
   reply + mark addressed" in one op.
4. **`side` on the anchor.** `NoteAnchor` gains a nullable `side` (`left|right`,
   null for file-level) so notes can target deleted lines and line-level
   staleness can reconcile against the correct side.
5. **Line-level staleness, computed in `stage-core`.** The line-indexing logic
   moves from the TS ephemeral layer into `stage-core` so the CLI (agent) and
   the Tauri app agree. A line-anchored note is `outdated` when its file leaves
   the Base diff *or* its line range on its side is gone; file/anchorless notes
   stay file-level / never-stale. Reuses the **Stale step** pattern.
6. **Anchor is optional.** `anchor: Option<NoteAnchor>` supports general,
   un-anchored feedback. Three granularities: line, file, none.
7. **Rendered both inline and in the rail.** Line notes render inline at their
   line (primary, code context); the rail is the index and the home for
   anchorless and outdated notes that have no inline anchor.
8. **Markdown export retained**, reframed as a secondary convenience (the
   store/CLI is the primary agent channel). Sourced from notes, it renders all
   notes with status tags + threads — for agents/contexts not wired to the CLI.
9. **The diff affordance is "Note", not "Comment"** — the glossary bans the
   overloaded "comment".

## Considered alternatives

- **Keep two systems (ephemeral comment + persistent note).** Rejected — this is
  the dead-end trap itself: the author's most natural gesture never reaches the
  agent.
- **Single `agent_reply`, no threads.** Rejected in favour of a full
  author↔agent thread: the author wants to push back on an agent's fix in place
  rather than overwrite or lose the exchange.
- **File-level staleness only.** Rejected — a note anchored to lines the agent
  already edited away (file still present) would read as fresh, misleading the
  agent. Computing line-level in TS only was also rejected: the CLI and app
  would disagree about the same note in the same phase, the kind of confusing
  partial state CLAUDE.md forbids.
- **Normalize line anchors to the new-file side only.** Rejected — loses
  annotating deletions and forces ripping out working side-aware logic.

## Consequences

**Positive:** one mental model; the author's natural gesture reaches the agent;
notes carry the full conversation; staleness is precise and consumer-agnostic.

**Negative:** a store migration (replies table, `side` column, nullable anchor,
`agent_reply` backfill); the line-indexing logic must be ported into
`stage-core` and the patch threaded through both the CLI and Tauri note-list
paths.

## Reference

- `CONTEXT.md` — **Review note**, **Self-Review**, **Debrief**, **Stale step**.
- ADR-0011 (cycle-1 architecture); ADR-0010 (self-review diff rendering stack).
- `client/stage-core/src/{domain,store}.rs`; `client/stage-cli/src/main.rs`;
  `client/src-tauri/src/commands.rs`; `client/src/screens/selfReview/`.
