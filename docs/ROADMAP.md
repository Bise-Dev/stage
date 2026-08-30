# Roadmap

Forward-looking goals that we are deliberately *not* building yet, but are aiming for. Keep this list short — only items that change how we'd design today's code if we forgot about them.

## The near-term direction: turning the review surface back on

What shipped: the current baseline (durable parts in ADR-0025/0026/0027 + CONTEXT.md) — a branch-table home replacing the Overview, one shared shell whose Self-review mode renders the agent's Debrief inline, and confirmed git actions.

What the current version **supports** is narrower still: **local Self-Review + Debrief only**. The storyline / publish / reviewer half is implemented, but its UI is commented out.

So the near-term goal is not new capability, it's **making that half good enough to uncomment**: the create-review wizard, publish, and reviewer entry need the polish and end-to-end confidence the self-review flow already has. This is active work, not a deferred goal — it's listed here only so the deferred items below read in context. **Implication:** don't build on the assumption that a user can publish today, and don't delete the commented-out code to tidy up — it's meant to come back.

## MCP as an agent interface

**Today:** the coding agent drives Stage through `stage-cli` against the shared local store (ADR-0011) — no server, no auth.

**Goal:** optionally expose the same operations as an MCP server so MCP clients get typed tools + discoverability without shelling out.

**Why not now:** the CLI covers the loop end-to-end and adding a second protocol surface before the domain model settles would freeze the wrong API. **Implication:** keep every agent-facing operation a thin wrapper over one stage-core function, so a future MCP server is a second frontend, not a second implementation.

## Attachments in PR descriptions

**Today:** the create-review wizard's PR-description step is text-only.

**Goal:** attach images/logs the way github.com's editor does.

**Why not now:** GitHub has **no public API for user-image uploads**; the only workaround is committing assets into the repo, which pollutes history. Revisit if GitHub ships an upload API. **Implication:** the PR body is plain markdown in `.stage/<branch>/pr.md` — nothing assumes attachment URLs.

## Debrief history

**Today:** one Debrief per branch, overwritten on every agent pass, with the head SHA + timestamp of the pass recorded (CONTEXT.md → *Debrief*).

**Goal:** optionally retain prior debriefs so an author can see how the agent's account evolved across passes.

**Why not now:** no UI exists or is designed for history; the seen/outdated chips only need the latest. **Implication:** the store keys debriefs by branch — adding a version dimension later is a migration, not a redesign, and nothing should assume "exactly one debrief row per branch" outside the store layer.

## Decisions document

**Today:** an archived Review (PR merged/closed) keeps its committed `.stage` storyline.

**Goal:** export an archived Review — chapters, intros, resolved discussion — as a durable "why this change looks the way it does" document.

**Why not now:** the archive read-path barely exists; exporting before people archive reviews is speculative. **Implication:** never garbage-collect `.stage` folders of closed PRs.

## Background sync

**Today:** landing separately (snapshot-serving overview + adaptive `gh` polling): the branch table renders from a snapshot and refreshes without user-initiated fetches.

**Goal (beyond it):** push-style freshness (webhooks or notifications API) so remote review activity appears without polling pressure. **Implication:** UI reads snapshots; nothing in the webview assumes it triggered the fetch that produced the data it renders.
