# ADR-0011 · Agent self-review (Debrief) is a local `stage` CLI + app store, not a backend or MCP surface

**Status:** accepted
**Date:** 2026-06-01

## Context

A new capability: let a coding agent (e.g. Claude Code) produce a reviewable account of the work it just did, which the **author** reviews locally, and whose review feedback flows **back** to the agent. This is a second review cycle, distinct from the existing one:

- **Cycle 1 (new):** agent authors a **Debrief** over its own contributions → author reviews it locally and leaves **Review notes** → agent reads the notes, revises, regenerates. A local author↔agent loop.
- **Cycle 2 (existing):** author composes a **Storyline** for external reviewers → Publish. Unchanged.

Two existing facts shape the design:

1. The backend **Workspace** and **Storyline** are server entities that require Stage authentication (GitHub-as-IdP, an interactive OAuth loopback that yields an in-memory `stg_` session token). Per ADR-0001 the Local Client holds no GitHub credentials and only ever holds the Stage session token.
2. **Self-Review** is deliberately **local and auth-free** (`CONTEXT.md`); the diff is computed entirely in `client/src-tauri/src/git.rs`.

The agent is a **separate process** from the Tauri app: it has the filesystem, git, and shell, but it does **not** hold a Stage session token, and there is no non-interactive / machine-to-machine auth anywhere in the backend. So: where does cycle-1 data live, and how does the agent write something the Tauri app can read?

## Decision

Cycle 1 is **local-only and auth-free**. Concretely:

- The agent writes through a new **`stage` CLI** (Rust, reusing the existing `stage_client_lib` crate) into an **app-data store** (SQLite) keyed by `(repo, branch)`. No network, no Stage token, no GitHub credentials.
- The **Tauri app** reads the same store to render the Debrief inside the (enriched) Self-Review screen, and **writes** Review notes into it — making the app a second writer, which is why the store is SQLite rather than a flat file.
- The Debrief is composed against the existing **Base-scope** diff (`merge-base(base, HEAD)` → working tree) from `git.rs` — no new git code.
- **Review notes** anchor to a **diff location** (file path + optional line range), not to Debrief step identity, so they survive the agent regenerating the Debrief. Lifecycle: `open → addressed (agent, with a reply) → resolved (author)`. Notes whose anchor no longer matches the current diff are flagged **outdated** and retained, reusing the **Stale step** pattern.
- The backend **Workspace** / **Storyline** entities and their auth are **untouched**. They keep their meaning: created at Ready-to-share, for reviewers.
- A future **MCP server** may wrap the same CLI core for nicer agent ergonomics; that is an additive wrapper, not a different storage or auth model.
- **Promotion** of a Debrief into a Storyline at Ready-to-share is **deferred**; the design does not preclude it (the Debrief persists locally and shares the Storyline's ordered-steps-with-intros shape, so a future bridge is a copy).

## Considered alternatives

- **Backend, agent acts as the user (reuse Workspace/Storyline).** Rejected. Requires a non-interactive agent token — none exists; the session token is interactive-only and held in memory. It would break "Self-Review is auth-free" and force redefining Workspace/Storyline to exist before Ready-to-share. The promotion convenience (same object) does not justify inventing machine auth.
- **Backend, new entities for agent self-review.** Rejected. Still needs agent auth, and adds a second parallel backend surface to maintain alongside the existing one.
- **Repo files (`.stage/…`) written directly by the agent, no CLI.** Rejected. Puts Stage's own data **inside the user's repo** — against the project tenet that Stage "stores only what git and GitHub cannot" — risks the self-review file appearing in its own diff, and offers no write-time validation (schema drift).
- **MCP-first instead of a CLI.** Deferred, not rejected. A stdio MCP server is the most ergonomic agent surface and matches the original "mcp for self review" idea, but it is a server to build and configure. A CLI is simpler to build and test, and an MCP server can wrap the same core later.

## Consequences

**Positive:**

- Preserves the local-first, auth-free character of Self-Review; the agent needs no credentials of any kind — the cleanest possible security posture for a process Stage does not control.
- Reuses `git.rs` Base-scope diffing and the existing per-line comment-thread UI; no backend changes.
- Clean conceptual separation from cycle 2: Debrief/Review note (local, agent/author) vs Storyline/IntroComment (backend, reviewer-facing).

**Negative:**

- Introduces the **first local persistence** in the client (a SQLite dependency) and a **shared store written by two processes** (CLI + Tauri app); they must agree on the store location keyed by `(repo, branch)`.
- The author↔agent loop is **human-mediated** (no push): the author shuttles between the Tauri app and the agent session; the agent reads notes only when re-invoked.
- The **promotion** bridge into cycle 2 is still owed.

## Reference

- `CONTEXT.md` — **Debrief**, **Review note**, **Self-Review**, **Stale step**.
- ADR-0001 (three-tier topology; no GitHub credentials on the client).
- ADR-0010 (self-review diff rendering stack); `client/src-tauri/src/git.rs::self_review_diff` (Base scope).
- `client/src-tauri/src/api/` — `stage_client_lib`, the crate the `stage` CLI reuses.
