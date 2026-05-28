# Roadmap

Forward-looking goals that we are deliberately *not* building yet, but are aiming for. Keep this list short — only items that change how we'd design today's code if we forgot about them.

## Stage Backend (POC implemented; hardening to follow)

**Today (POC):** The Stage Backend exists as a Django 5.2 + DRF service (see `docs/design.md`). It holds GitHub credentials (single admin PAT for v1), brokers GitHub API calls, and persists Workspace + Storyline + IntroComment state in Postgres. The client integration is not wired yet on the Rust side; the contract is published in `docs/api.md` + `docs/data-model.md`.

**Next hardening goals (phase 2):**
- **2a — GitHub App installation token** (small, ~80 lines + one-time github app setup). Replace the admin PAT with a token minted from a GitHub App's private key. Actions appear as `stage-bot[bot]` on github (clean machine attribution); same security posture, same code paths. Env vars switch from `GITHUB_ADMIN_PAT` to `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_INSTALLATION_ID`. `GithubGateway` constructor refactors `token=...` → `token_getter=...` w/ a JWT-mint + installation-token-exchange + 5-min-pre-expiry refresh cache. This is **not** the same as the existing OAuth App (which is for user device-flow identity and stays as-is).
- **2b — Per-user GitHub OAuth on-behalf-of** (larger, multi-week). Each action attributed to the actual Stage user on github. Extends the existing OAuth-App device-flow scaffold: scope upgrade (`read:user` → `read:user` + `repo`), encrypted token storage, refresh handling. ADR-required when undertaken.
- Realtime push (SSE per workspace) to surface storyline edits / new IntroComments / github changes without client polling.
- GitHub webhook ingress (smee.io for dev; public URL for prod) so PR-side state changes propagate without a client refresh.
- Per-route conditional ETag cache on github read endpoints to reduce rate-limit pressure.

## Workspaces-overview aggregation: GraphQL batch fan-out

**Today (POC):** The repo-scoped overview endpoint (see `docs/adr/0009-workspaces-overview-aggregation-endpoint.md`) enriches each PR-backed row by fanning out **parallel REST calls** through `GithubGateway` (review decision, additions/deletions, review-comment count), behind a short-TTL `(user, repo)` cache. This is N+1 GitHub calls per load — fine for POC-sized PR counts.

**Goal:** Replace the per-PR REST fan-out with a **single GitHub GraphQL query** that fetches `reviewDecision`, `additions`, `deletions`, and `comments.totalCount` for all the repo's relevant PRs at once. Cuts a screen load from N round-trips to one.

**Why we're not doing it now:** GraphQL is a new gateway capability (query + auth + response mapping + tests) and the REST fan-out is adequate at POC scale. Revisit when a repo's open-PR/workspace count makes the N+1 latency or rate-limit pressure bite.

**Implication for today's design:** Keep the per-PR enrichment behind a single function in the aggregator selector so the REST fan-out can be swapped for one GraphQL call without touching the endpoint's response shape.

## Transactional outbox for github-coupled writes

**Today (POC):** `pull_request_open` will land an **idempotent open** patch (look up by `head_ref` before creating, adopt an existing PR if found) — this closes the only currently-known stuck-state where a github write succeeds but the DB write fails afterward. See `docs/design.md` § 6 + § 14.

**Goal:** Move to a proper **two-phase / outbox** pattern for any operation that combines a github side-effect with Stage DB state. Pattern: write the *intent* to a Stage-owned outbox row inside the DB transaction, then attempt the github call from a worker; on success mark the outbox row done and apply downstream state; on failure retry with backoff. This eliminates the "github committed, DB rolled back" hazard for every coupled write, not just `open_pr`.

**Why we're not doing it now:** The idempotent-open patch covers the only real stuck-state today. Other write-through paths (intro comments, reviews, PR actions) are caller-retry-safe because github itself is the source of truth for those — a failed write just means the user retries the action. Building an outbox + worker is a multi-week effort that earns its keep only once we have more coupled writes or move to local-first review actions (see below).

**Implication for today's design:** Keep `pull_request_open` the only place doing multi-step github + DB orchestration. New features that combine a github write with a Stage DB mutation should be flagged in design review as "this needs the outbox before it ships."

## Local-first review actions with eventual sync to GitHub

**Today (POC):** Review actions (per-line comments, threaded replies, approve / request changes / comment) are **write-through** — the client sends them to the Stage backend, which immediately writes them as native GitHub review activity. GitHub is the source of truth for review state. If GitHub is unreachable, Stage cannot accept review actions.

**Goal:** Move to a **local-first** model where review actions are first-class Stage entities. Authoring is instant and offline-capable; the backend reconciles state with GitHub in the background and resolves conflicts (e.g. a reply made directly on github.com while the reviewer was offline). The user experience target is Linear-grade snappiness.

**Why we're not doing it now:** Building a real sync engine (queues, conflict resolution, retry semantics, idempotency keys for GitHub writes) is a multi-week effort that does not earn its keep at POC stage. Write-through gets the storyline experience in front of users with a fraction of the code.

**Implication for today's design:** Keep the client's review-action code path behind a thin interface in the backend client so that today's "POST and wait" can later be swapped for "enqueue, optimistically render, reconcile" without touching the UI.
