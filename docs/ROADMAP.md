# Roadmap

Forward-looking goals that we are deliberately *not* building yet, but are aiming for. Keep this list short — only items that change how we'd design today's code if we forgot about them.

## Stage Backend (POC implemented; hardening to follow)

**Today (POC):** The Stage Backend exists as a Django 5.2 + DRF service (see `docs/design.md`). It holds GitHub credentials (single admin PAT for v1), brokers GitHub API calls, and persists Workspace + Storyline + IntroComment state in Postgres. The client integration is not wired yet on the Rust side; the contract is published in `docs/api.md` + `docs/data-model.md`.

**Next hardening goals (phase 2):**
- Per-user GitHub OAuth (replace the shared admin PAT — see ADR-0004 and `docs/design.md` § tech debt). Reuse the device-flow scaffold that already exists for session login.
- Realtime push (SSE per workspace) to surface storyline edits / new IntroComments / github changes without client polling.
- GitHub webhook ingress (smee.io for dev; public URL for prod) so PR-side state changes propagate without a client refresh.
- Per-route conditional ETag cache on github read endpoints to reduce rate-limit pressure.

## Local-first review actions with eventual sync to GitHub

**Today (POC):** Review actions (per-line comments, threaded replies, approve / request changes / comment) are **write-through** — the client sends them to the Stage backend, which immediately writes them as native GitHub review activity. GitHub is the source of truth for review state. If GitHub is unreachable, Stage cannot accept review actions.

**Goal:** Move to a **local-first** model where review actions are first-class Stage entities. Authoring is instant and offline-capable; the backend reconciles state with GitHub in the background and resolves conflicts (e.g. a reply made directly on github.com while the reviewer was offline). The user experience target is Linear-grade snappiness.

**Why we're not doing it now:** Building a real sync engine (queues, conflict resolution, retry semantics, idempotency keys for GitHub writes) is a multi-week effort that does not earn its keep at POC stage. Write-through gets the storyline experience in front of users with a fraction of the code.

**Implication for today's design:** Keep the client's review-action code path behind a thin interface in the backend client so that today's "POST and wait" can later be swapped for "enqueue, optimistically render, reconcile" without touching the UI.
