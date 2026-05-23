# Roadmap

Forward-looking goals that we are deliberately *not* building yet, but are aiming for. Keep this list short — only items that change how we'd design today's code if we forgot about them.

## Stage Backend (phase 2)

**Today (POC):** The Stage Backend does not exist yet. The client is built standalone against local git, persisting any Stage-native data (Workspace, Storyline) locally on disk. PR creation and reviewing-other-people's-workspaces flows are not functional yet.

**Goal:** Add the Stage Backend as a separate service (see the three-tier topology in `CONTEXT.md`). The backend will hold GitHub credentials, broker GitHub API calls, and host shared Workspace + Storyline state.

**Implication for today's design:** Reserve a `BackendClient` Tauri command surface inside the Rust side of the client. Today, those commands either do not exist yet or are no-ops; tomorrow, they are implemented against the real backend. The client UI should be coded against this seam (a typed interface), not against direct local-storage calls, so phase 2 is a single-layer swap.

## Local-first review actions with eventual sync to GitHub

**Today (POC):** Review actions (per-line comments, threaded replies, approve / request changes / comment) are **write-through** — the client sends them to the Stage backend, which immediately writes them as native GitHub review activity. GitHub is the source of truth for review state. If GitHub is unreachable, Stage cannot accept review actions.

**Goal:** Move to a **local-first** model where review actions are first-class Stage entities. Authoring is instant and offline-capable; the backend reconciles state with GitHub in the background and resolves conflicts (e.g. a reply made directly on github.com while the reviewer was offline). The user experience target is Linear-grade snappiness.

**Why we're not doing it now:** Building a real sync engine (queues, conflict resolution, retry semantics, idempotency keys for GitHub writes) is a multi-week effort that does not earn its keep at POC stage. Write-through gets the storyline experience in front of users with a fraction of the code.

**Implication for today's design:** Keep the client's review-action code path behind a thin interface in the backend client so that today's "POST and wait" can later be swapped for "enqueue, optimistically render, reconcile" without touching the UI.
