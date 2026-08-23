# Stage — Architecture map

Stage is a local-first tool for human-tailored pull-request review: authors craft a guided walkthrough (a **Storyline** of **Chapters**) over their own branch; reviewers follow it and comment. GitHub stays the system of record; Stage stores only what git and GitHub can't represent.

> **What ships today is narrower than what this map describes.** The current version supports **local Self-Review with the agent's Debrief folded in, and nothing else**; the storyline / publish / reviewer half is built in `stage-core` but hidden in the webview behind one flag (`client/src/featureFlags.ts`) and refused by the CLI. See **ADR-0028**. The layers, stores and decisions below are unchanged by that gate — it is a webview + CLI concern only.

This page is a **map**, not a spec — it carries no detail of its own. Each concern points to where the canonical answer lives:

- **Domain language** → [`CONTEXT.md`](../CONTEXT.md) (the glossary; the single source for what each term means).
- **Decisions & rationale** → [`docs/adr/`](./adr/) (one ADR per decision; the "why").
- **Forward goals** → [`docs/ROADMAP.md`](./ROADMAP.md) (what we're deliberately not building yet).
- **Persistence** → the two stores below; their schemas live in code (`client/stage-core/src/store.rs`, `client/stage-core/src/review_folder.rs`). There is no hand-maintained data-model doc.

## Topology

```
Tauri app (React/TS webview + Rust)  ⇄  local git / gh  ⇄  GitHub
            ▲
  stage-cli (agent interface)
```

There is **no Stage backend and no Stage account** (ADR-0022). The desktop app reaches GitHub exclusively through the user's own local `git` and `gh` credentials; the `gh` token owner *is* the identity. A coding agent participates through **`stage-cli`** against the same local store — no network, no auth (ADR-0011; MCP is deferred, see ROADMAP).

Internally the app is three layers:

- **`client/stage-core`** (Rust) — the whole engine: diffs, storyline/chapters, debrief, notes, overview, staleness, publish, reviewer entry, PR activity. Everything user-visible is computed here.
- **`client/src-tauri`** — thin command bindings over stage-core (ts-rs-typed DTOs; networked commands off the UI thread, ADR-0023).
- **`client/src`** (React/TS) — **visualizes DTOs only**; TS never reads `.stage`, git, or `gh` itself (ADR-0022 §7).

## What Stage stores

Split at the **Ready to share** gesture (ADR-0022 §3):

- **Committed `.stage/<branch>/`** — the shareable Review artifact: `review.toml`, one file per **Chapter** under `chapters/`, and `pr.md` (the PR-description draft). Format v2 per ADR-0025; the legacy per-step layout is not read.
- **Per-machine SQLite store** (private, pre-publish) — Debrief, Self-Review notes, the draft Review + its chapters, and drafted review comments awaiting one-shot submission (ADR-0026).

Everything else — PR data, comments/reviews once submitted, CI, branches — lives on GitHub and is fetched on demand, never mirrored.

## Decision map

| Concern | ADR |
|---|---|
| Local `.stage` folder replaces the backend (the architecture) | 0022 |
| Self-Review diff rendering stack | 0010 |
| Agent self-review (Debrief) is a local CLI, not a service | 0011 |
| Self-Review's one annotation concept: Self-Review notes | 0012 |
| `st open` — CLI launches the GUI into Self-Review (named `stage` in ADR-0014) | 0014 |
| Keyboard shortcuts + reload | 0015 |
| Git worktrees: observe-only, Repo keyed by common-dir | 0016 |
| Storyline diff is a committed tree↔tree diff | 0018 |
| Publish owns branch push + GitHub precondition | 0019 |
| Networked Tauri commands run off the UI thread | 0023 |
| Publish gates on uncommitted work (dispositions) | 0024 |
| Chapters replace steps as the storyline unit (.stage format v2) | 0025 |
| Review comments draft locally, submit as one GitHub review | 0026 |
| Working-tree mutations are scoped, confirmed actions | 0027 |
| The review surface is gated, not deleted, until it ships | 0028 |

ADRs 0001–0009, 0013, 0017, 0020–0021 concern the retired backend/auth architecture and stand as history; ADR-0003's write-through principle is superseded by 0026 for composing a review.

ADR-0028 does not supersede 0014, 0018, 0019, 0024, 0025 or 0026 — it scopes them: they still describe how the review surface works, just not what a user of this version can reach.
