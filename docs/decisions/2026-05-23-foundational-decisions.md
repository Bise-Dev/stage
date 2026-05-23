# Foundational Decisions — Local PR Review Backend

**Session date:** 2026-05-23
**Author:** ybouzonie
**Status:** In progress (brainstorming)

This log captures every architectural decision made during the design session, with the rationale and alternatives considered. Future updates land as new dated entries below.

---

## D1 · Workspace identity = PR-scoped

A workspace exists only when there is a github PR. No pre-PR workspaces.

**Two creation modes:**
- **Author mode** — `create-pr` creates the github PR via `gh`, then spins up a workspace bound to that PR.
- **Reviewer mode** — `import-pr <number>` (or equivalent) takes an existing github PR and spins up a workspace for reviewing it.

**Why:** Avoids the ambiguity of "promote draft workspace to PR workspace". Github PR number is a stable, unique identity. Aligns with the goal: enhance review for *either* your own PR or someone else's.

**Rejected alternatives:**
- Branch-scoped workspace promoting to PR — extra lifecycle state.
- Two-phase Draft + PR workspace — duplication + transition logic.
- Polymorphic repo+ref pointer — flexibility we don't need.

---

## D2 · Storyline transport = DB row (REVISED on 2026-05-23 after pivot)

~~Original decision: store as `.local-review/storyline.json` in PR branch.~~ **Superseded.**

Storyline (file order + intros) is stored as a DB row in the shared backend. Author writes via API; reviewer reads via the same API. No git commit, no file in branch.

**Why revised:** Backend pivoted from per-user local to shared deployable service. DB is now source of truth. Cross-user transport is solved by HTTP + DB — git transport is unnecessary infrastructure.

**Implications:**
- No branch-protection / signed-commit failure modes.
- No auto-push / stale-because-not-pushed-yet problem.
- Storyline becomes mutable in DB. Edits surface immediately to reviewers via SSE.
- Storyline edit authorization needed (see D13).

---

## D3 · Sync model = event-driven (webhooks in, gated push out)

**Github → local:** Github webhook subscription delivers events to the backend's webhook endpoint.

**Local → github:** Outbound mutations wrap `gh` CLI / PyGithub. Each push checks "are we synced with github?" before sending; if not, surface conflict to user (don't auto-overwrite).

**Mandatory companion:** Reconciliation poll (low cadence, e.g., every 5 min while workspace open) catches missed webhook deliveries. Webhooks fail; poll is the safety net.

**Why:** "Constant sync" feel without aggressive polling load. Optimistic concurrency on push prevents lost updates.

**Rejected alternatives:**
- Pure polling (latency = cadence, wasted requests).
- Manual refresh only (stale data, defeats "constant sync").
- Event-driven without reconciliation (silent breakage on webhook loss).

---

## D4 · Webhook ingress (REVISED on 2026-05-23 after pivot)

- **Production deploy:** backend has a public HTTPS URL natively. Github webhook posts directly to `/webhooks/github`. No tunnel needed.
- **Local development:** developer runs a tunnel (`ngrok http <port>` or `cloudflared tunnel`) OR points github at a **smee.io** channel and backend subscribes. Both supported via env-driven config.
- **Webhook subscription model:** one webhook per repo, ref-counted by active workspaces in that repo. When the last workspace for a repo is archived, the webhook is removed.

**Why revised:** Shared deployable service has a public URL by default. Tunnel/smee become dev-only conveniences.

**Rejected:** Polling-as-pseudo-events still rejected (defeats event-driven goal, wastes rate limit).

---

## D5 · Github auth (REVISED on 2026-05-23 after pivot)

Two concerns separated:

**(a) Github API auth — how the backend acts on github (v1):**
- Single **admin PAT** held in backend config (encrypted at rest / in secrets manager). All github API calls (read mirror, post comment, merge, etc.) use this PAT.
- All comments / reviews / merges performed by the backend appear authored by the PAT-owner github account, regardless of which app user triggered them.
- **Marked as tech debt.** Production deploy must upgrade to per-user OAuth tokens (either Github OAuth App or Github App with on-behalf-of flow) before any non-internal use, so identity propagates correctly.
- API access via PyGithub for typed endpoints, httpx for everything else. `gh` CLI is **not** used by the deployed backend (no shell environment guarantee). `gh` may be used by dev tooling / migration scripts only.

**(b) App user identity — how the backend knows who's on the other end:**
- **Github OAuth-login for identity only.** OAuth scopes minimal (e.g., `read:user`). Backend stores user's github login + user_id at first login. No write scopes needed in v1 since admin PAT does the work.
- Future upgrade path: when (a) graduates to per-user tokens, expand OAuth scopes; existing identity flow stays.

**Rejected alternatives (a):**
- Per-user `gh` token (doesn't apply to deployed service).
- User-provided PATs (UX nightmare).
- Github App / OAuth App for v1 (deferred to tech-debt repayment).

**Rejected alternatives (b):**
- Hardcoded single user (throws away multi-user data model).
- Self-registration / no github tie (can't derive PR-access authz).
- HTTP header trust (no production path).

---

## D6 · Own-PR review = self-walkthrough + optional AI-doc ingestion

The own-PR review flow is fundamentally a **manual self-walkthrough**: the author opens the workspace, defines file order, writes intros, may add private notes.

**AI integration is ingestion-only in v1.** The backend accepts a structured analysis document the user feeds in (e.g., produced by Claude Code or any agent). The backend does NOT make any agent calls itself.

**Why:** Tool must work standalone without any AI dependency. AI is opt-in enhancement. Avoids coupling the backend to a specific agent vendor.

**Future task:** Define a custom Claude Code skill whose role is to fill the analysis document in the backend's expected schema. Owned in a separate spec.

**Schema:** TBD — define a JSON or markdown-with-sections schema. Probably structured by-file with: summary, concerns, suggestions.

---

## D7 · Architecture pattern = Mirror + Outbox + Audit log

**Source of truth for github-pulled data:** Django mirror tables (PR, Comment, Review, etc.). Webhook handlers + reconciliation poll update these rows.

**Outbound mutations:** Local action → write to `Outbox` table → django-q worker drains → calls github via PyGithub or `gh` → on success, updates mirror row + marks outbox entry resolved.

**Audit log:** `sync_event` table stores every webhook ingress and every outbox push as plain JSON rows (event_type, payload, timestamp, workspace_id, direction). Used for debugging + sync timeline UI + future graduation to full event-sourced if ever needed.

**Worker:** `django-q` in-process (SQLite-backed broker) for outbox drain + reconciliation poll fallback. No Redis, no Celery.

**UI sync:** Server-Sent Events (SSE) from Django views. Stream subscribed to per-workspace channels. Simpler than `django-channels` for v1.

**DB:** SQLite single file. Single Django project. Single user.

**Why this combo:**
- Outbox solves "local action vs concurrent webhook" race + gives free retries.
- Audit log gives 80% of event-sourcing's debug value at 10% of the cost.
- SSE is enough for a local UI; websocket overhead not justified.
- `django-q` keeps infra to a single Python process.

**Rejected alternatives:**
- **Minimalist Django** (direct write-through) — fragile under partial-failure, no retry path.
- **Full event-sourced** — replay-purity discipline, schema-evolution cost, github-is-external-truth tension (see brainstorming notes).

---

## D8 · PR-lifecycle operations are first-class

The backend must support, from the local UI, all of the following github operations with full sync and idempotency:

**Comment ops**
- Post review comment (line-anchored on diff or PR-level)
- Reply to a thread
- Resolve / unresolve a thread
- Edit a comment authored by the local user
- Delete a comment authored by the local user
- React (emoji) to a comment

**PR state ops**
- Mark draft ↔ ready-for-review
- Close PR
- Reopen PR
- Merge (squash / merge / rebase)
- Convert to draft from ready

**Read-only observability**
- Github Actions / workflow runs status per commit
- Check runs per commit
- Required-status-checks state
- Mergeability state (clean / dirty / unstable / blocked)

**Why first-class:** These ARE the review experience. Without them the backend is read-only and the user must context-switch to github. The whole point is to keep the user in the local tool.

---

## D9 · Idempotency model for PR lifecycle

**Outbox row is the unit of intent and the unit of idempotency.**

Every outbox row carries:
- `id` (UUIDv7) — the intent identity
- `action_type` — e.g., `comment.post`, `pr.close`, `thread.resolve`
- `payload` — JSON args
- `status` — `pending` · `in_flight` · `succeeded` · `failed` · `conflicted`
- `attempt_count`, `last_error`
- `github_response_ref` — the github object id once succeeded
- `precondition_etag` (where applicable) — github resource ETag captured at enqueue time for optimistic concurrency

**Worker drain rules:**
1. Lock row (`status: pending → in_flight`) with `SELECT ... FOR UPDATE` (SQLite: BEGIN IMMEDIATE).
2. Before push: re-read mirror state. If a precondition fails (e.g., PR already closed for `pr.close`), mark `succeeded` with note "already in target state". Idempotent.
3. Push to github. Capture response.
4. On success: store `github_response_ref`, mark `succeeded`, update mirror, append `sync_event`.
5. On API failure: increment `attempt_count`, exponential backoff (capped), eventually `failed` after N tries.
6. On 409 / ETag mismatch: mark `conflicted`, surface to UI for resolution — never auto-overwrite.

**Inbound webhook idempotency:**
- Github webhook delivery_id is unique per delivery. Store in `sync_event.delivery_id` with UNIQUE constraint.
- Duplicate delivery → insert collision → no-op, log debug.

**At-least-once delivery, exactly-once effect** — the outbox precondition checks + mirror state make replays safe.

---

## D10 · Backend = shared deployable service, DB = source of truth

The backend is a Django application designed for shared multi-user deployment. Development runs locally; production deploys to a host with a public URL. **The DB — not github, not the local filesystem — is the source of truth for backend-owned data** (workspaces, storyline, drafts, annotations, AI-docs, outbox, audit log).

Github remains the source of truth for the github-domain primitives the backend mirrors (PR state, comments, reviews, check runs, etc.). The backend's mirror tables are a cache, kept synced via webhooks + reconciliation.

**Why:** Original "local single-user" framing was abandoned. Shared backend = cross-user transport solved by HTTP+DB.

---

## D11 · Per-user vs workspace-level state separation

| Scope | Owns | Examples |
|---|---|---|
| **Workspace-level** | One row per workspace, shared by all viewers | PullRequest mirror, Storyline, StorylineFile, AIAnalysisDoc, CheckRun/WorkflowRun mirror |
| **Per-user-within-workspace** | One row per (workspace, user) | DraftReview, DraftComment, LocalAnnotation |
| **Shared discussion on storyline** | Threaded comments under a StorylineFile intro | IntroComment (anyone with read access can post) |

**Storyline edit ownership:** **Only the PR author** can mutate Storyline + StorylineFile + AIAnalysisDoc. No maintain/admin override. Repo permission is irrelevant for storyline write — github-author identity is the only key.

**IntroComment:** Anyone with `read+` repo permission can post + reply on the author's intent comments. These are tool-local (DB only), never synced to github. Threaded via `parent_fk`. May be `resolved` (set by the PR author).

**Draft ownership:** Only the owning user can read/write their own DraftReview + DraftComments. Drafts are invisible to other users until submitted (becoming a github Review).

**Annotation visibility:** LocalAnnotation is private to the authoring user. Never visible to others, never synced to github.

---

## D12 · DB choice: SQLite for dev, Postgres for prod

Django models written to be portable. **No SQLite-specific or Postgres-specific features in ORM definitions.** Migrations runnable against either.

**Settings split:** `dev.py` uses SQLite file. `prod.py` uses Postgres via env-driven URL.

**django-q broker:** in dev, SQLite-backed (in-process). In prod, can stay SQLite-backed for now (simpler) or graduate to Redis when concurrent load justifies it.

**Why:** Fast dev loop without docker. Production-grade Postgres in prod. Same codebase.

---

## D13 · Authorization = derived from github repo permission, cached

When user U requests workspace W (which is bound to PR in repo R), backend determines U's access by:

1. Look up `UserRepoPermission(user=U, repo=R)` cache row.
2. If absent or expired (TTL e.g. 5 min): backend calls github (using admin PAT) `GET /repos/{owner}/{repo}/collaborators/{username}/permission` and stores result.
3. **v1 authorization is intentionally permissive — fine-grained gates are tech debt.**
   - Any authenticated user (logged in via OAuth-identity) can view any workspace, post comments, submit reviews, post IntroComments.
   - **Only enforced rule in v1: Storyline + StorylineFile + AIAnalysisDoc edit = PR author identity check** (`user.github_login == workspace.pr.author_login`). This rule is requested by name; everything else stays permissive until later.
   - Close / reopen / merge still go through github's own permission + branch-protection layer (the admin PAT may have broad rights, so backend should still surface a "you may not have github permission to do this" warning in UI — but doesn't pre-block).
   - **UserRepoPermission cache table is still built** so the upgrade path stays free; it's just not consulted on most routes in v1.

**Why permissive:** Focus of v1 is data model + sync correctness, not authz. Tightening later is a route-decorator change, not a model change.

**Why:** Don't model org/team hierarchy ourselves; defer to github. Cache avoids API hammering. TTL bounds staleness.

**Tech debt note:** When auth upgrades to per-user OAuth tokens (D5 followup), the permission check should use the **user's** token (not admin PAT), so users with revoked github access lose backend access immediately.

---

## D14 · Webhook subscription (DROPPED 2026-05-23 after pivot 2)

~~Per-repo webhook ref-count.~~ **Superseded.** No webhooks in v1. Github reads happen on-demand via proxy routes. See D15.

---

## D18 · State model: Self-Review → Ready-to-share → Ready-to-publish, cyclic (2026-05-23, grilling, REVISED)

Original D18 (`local_state = reviewing | sharing` on a workspace that always exists) is **superseded** by this entry following the client developer's `CONTEXT.md` update.

**Self-Review** is an author-only stage with **no workspace in the backend**. The author iterates on a local branch, visualizes their own diff, optionally uses AI assistance — none of this is persisted. Persisting Self-Review state is a non-goal.

**Workspace** is created **eagerly** the moment the author clicks "Ready to share" (or equivalent). That endpoint also initializes an empty `Storyline`:

```
POST /api/workspaces  { repo_owner, repo_name, head_ref, base_ref }
  → creates workspace UUID + empty Storyline, returns uuid
```

**Ready-to-publish** is a **computed** condition, not a stored state: `≥1 StorylineFile AND every step has non-empty intro_text`. When true, the client enables the "Open PR" (or "Push update") action.

**After publish**, the workspace remains. The author can return to Self-Review (more commits on the branch), come back to the workspace to edit the storyline, and publish again — either re-creating the github PR (if it was closed) or pushing new review activity to the existing one. **Workspace outlives PR close/merge.**

**State summary (none stored as an enum — all computed):**

| Name | Test |
|---|---|
| `self-review` | no workspace exists for `(repo, head_ref)` |
| `ready-to-share` | workspace exists; storyline has 0 files OR ≥1 file has empty intro |
| `ready-to-publish` | workspace exists; ≥1 file AND all intros non-empty; PR not yet open |
| `published` | workspace exists; `pr_number` set; PR open |
| `closed` / `merged` | workspace exists; PR closed/merged on github |

**Rejected alternative:** storing `state` as an enum on Workspace. Drift between stored value and computed condition (e.g. "all intros written but flag still says draft") is the prior failure mode that motivated computed-state in the first place.

---

## D19 · Write-through review/comment model (POC) (2026-05-23, grilling)

Stage backend **does not store** `DraftReview`, `DraftComment`, or any `Comment` entity in the POC. Comment authoring is a **client-side** concern (the client holds the pre-publish queue). When the user submits, the client calls a Stage backend endpoint that **immediately** writes through to github as native github review activity.

**Why:** matches client-dev's `CONTEXT.md` design criteria — "GitHub-compatible, no duplication" and "Review state synced through to GitHub so a non-Stage reviewer can use the PR normally". Avoids the v2 spec's `DraftComment.category` problem (the category never reached github).

**What the backend exposes:**

```
POST /api/workspaces/{uuid}/comments
  body: { kind: 'issue'|'review', path?, line?, side?, body }
  → calls github immediately, returns github response, persists nothing

POST /api/workspaces/{uuid}/review
  body: { event: 'COMMENT'|'APPROVE'|'REQUEST_CHANGES', body?, comments: [...] }
  → creates a github review with the batched comments + event, returns gh response, persists nothing
```

**Local-first sync model** (drafts persisted backend-side, with an offline queue) is a roadmap goal (`docs/ROADMAP.md`), **not** the POC.

**Supersedes:** `DraftReview` / `DraftComment` tables in v2 spec §5.6, and v2 plan tasks T19, T20, T22, T23.

**IntroComment is NOT affected.** IntroComment is tool-native (no github equivalent); remains a backend table.

---

## D17 · Workspace identity = UUID, phases = local → public (2026-05-23, grilling session)

A workspace is created in the backend **when the author starts the local-review phase** — not at PR-creation. Identity is a `uuid4` minted by the backend.

**Phases (computed from `pr_number IS NULL`):**

| Phase | `pr_number` | What exists |
|---|---|---|
| `local` | `NULL` | Storyline + intros + AI-doc + drafts all live in the backend, attached to the workspace UUID. No PR on github. |
| `public` | non-NULL | All of the above + a github PR. The "Open PR" action attaches the PR by mutating `pr_number` on the existing row. |

**Workspace shape (updated):**

```
Workspace
  id              UUID PK
  repo_owner      str
  repo_name       str
  head_ref        str            # branch being reviewed
  base_ref        str            # branch the PR will target (default repo base if not chosen)
  pr_number       int?           # NULL while local, set on Open-PR
  pr_opened_at    timestamp?
  created_by_fk   FK User
  created_at      timestamp
  archived_at     timestamp?
  last_active_at  timestamp
```

**Uniqueness:** at most one active (non-archived) workspace per `(repo_owner, repo_name, head_ref)`. Once `pr_number` is set, `(repo_owner, repo_name, pr_number)` must also be unique across all rows.

**Why revised (supersedes D1):**
- UI's "Local review" bucket lists workspaces that don't yet have a PR. Backend must serve them.
- Storyline composition is real work that must survive sessions and browser caches.
- One row across the lifecycle is simpler than a two-entity model.

**Implications for prior decisions:**
- **D1** (Workspace = PR-scoped) — superseded.
- **D15 / D16** (no mirror of github data) — still hold. Workspace stores tool-native data only; github data stays proxy-only.
- The "Open PR" orchestration is now a **state transition** on an existing workspace (`POST /api/workspaces/{uuid}/open-pr`). It does **not** create the workspace.
- `POST /api/workspaces/import` still exists for the reviewer entry point (workspace from existing PR).

**Lifecycle entry points:**

```
flow A — author starts from scratch:
  POST /api/workspaces  { repo_owner, repo_name, head_ref, base_ref? }
    → creates row, phase=local, returns uuid
  PUT /api/workspaces/{uuid}/storyline ...
  POST /api/workspaces/{uuid}/open-pr  { title, body, reviewers, labels, draft }
    → calls github create-PR; on success sets pr_number on the row; phase=public

flow B — reviewer imports existing github PR:
  POST /api/workspaces/import  { repo_owner, repo_name, pr_number }
    → creates row, phase=public, returns uuid
```

This decision is recorded as **ADR-0001** (`docs/adr/0001-workspace-identity-and-phases.md`).

---

## D16 · Pivot 3 · UI-driven scope correction (2026-05-23)

After the brainstorming session locked the middleware-only stance (D15), the user shared the UI mockup (`Stage v2 _standalone_.html`). Inspecting it surfaced a set of gaps in the prior design — none of which require reverting D15's "no github mirror" stance, but several of which need new fields, endpoints, and workflow semantics.

**User clarifications:**
- "Local review" is a **pure UI visualization step**. The author opens a branch, sees the diff (from github API), and **builds the storyline in the UI**. **Nothing is persisted in the backend** during this phase.
- The only backend persistence moment is **"Open PR"**: the UI sends `{branch info, title, body, reviewers, labels, draft, storyline}` to the backend. The backend creates the github PR AND inserts `Workspace` + `Storyline` + `StorylineFile` rows atomically.
- Branch listing, diff stats, and "external PRs without workspace" are all **github-API passthrough**. No `Repository` entity. No local git clones. No `git fetch`.
- File "viewed" state lives in **UI localStorage**. Not a backend concern.

**Consequences for the data model:**
- Workspace remains PR-scoped (D1). No "local workspace" entity introduced.
- `StorylineFile` gains a `title` field (author-defined step title, distinct from the file path).
- `AIAnalysisDoc` gains a top-level `summary` field.
- `DraftComment` gains a `category` field (`comment | blocking | suggestion | nit`).
- No new aggregates beyond what D15 already enumerated.

**Consequences for the API:**
- The `POST /api/workspaces` endpoint as previously specified (workspace creation by referencing an existing PR) is split in two:
  - `POST /api/repos/{owner}/{repo}/open-pr` — creates a github PR AND the backend workspace + storyline atomically. The author-mode entry point.
  - `POST /api/workspaces/import` — creates a backend workspace from an existing github PR (the reviewer-mode entry point or author returning to an already-open PR).
- New proxy routes:
  - `GET /api/repos/{owner}/{repo}/branches` — list branches, optionally with diff stats vs default branch and last-commit metadata.
  - `GET /api/repos/{owner}/{repo}/compare/{base}...{head}` — diff stats between two refs (used during local-review composition).
  - `GET /api/external-prs?role=author|reviewer` — list current user's github PRs not yet imported as backend workspaces.
- `GET /api/workspaces/{id}/storyline/as-markdown` — render storyline as markdown for the PR body composer's "From storyline" button.
- `GET /api/workspaces` enrichment: each row includes counts (storyline files, intro comments) plus a github-derived snapshot (PR state, reviewers, check summary, computed state). Computed state values for public workspaces: `in-review | reviewing | requested | approved` (logic in §13 of spec).
- `POST /api/workspaces/{id}/drafts/publish-all` accepts a `post_to_github` flag. v1: if `false`, drafts are deleted with no trace (no `LocalReview` entity in v1; ship the flag but treat its `false` case as "discard drafts").

**Things explicitly NOT entering the backend (despite appearing in UI):**
- Repository entity / local path registry — github API knows the user's repos.
- Branch entity — github API knows the branches.
- File viewed state — UI localStorage.
- Local-only workspaces / pre-PR persistence — storyline is client-state until "Open PR".
- Draft local annotations (D15 already dropped this).

---

## D15 · Pivot 2 · Middleware-only backend

The backend stops mirroring github. Github is the source of truth for everything that exists on github (PR state, comments, reviews, checks, workflow runs, files). Our backend stores ONLY data that github does not have:

- Storyline (file ordering + intros per file)
- IntroComment (threaded discussion on a storyline intro — tool-native, never syncs)
- AIAnalysisDoc (ingested AI-produced analysis — tool-native)
- DraftComment / DraftReview (pre-publish state; deleted after push to github)
- User / Workspace / UserRepoPermission cache (identity + authz infra)

**Backend role becomes:** HTTP proxy to github for github-domain data + native CRUD for the tool-native data above.

**What this kills:**
- D3 event-driven sync — gone, no need
- D4 webhook ingress — gone
- D7 mirror+outbox — gone
- D9 outbox-based idempotency — gone (storyline writes still use ETag, see below)
- D14 webhook subscription — gone
- All mirror tables (PullRequest, DiffFile, Review, Comment, Thread, CheckRun, WorkflowRun, GithubUser as mirror)
- SyncEvent / Outbox tables
- Reconciliation loop
- django-q in v1 (no worker needed for synchronous proxy)
- LocalAnnotation feature — dropped for v1

**Github API calls:**
- All reads pass through synchronously. **No cache in v1.** Backend may measure latency + rate limit and revisit.
- All writes pass through synchronously, return github response to caller. No outbox.
- Concurrency / idempotency rely on github's own semantics (closing closed PR → 422, fine).

**Storyline writes** keep ETag-based optimistic concurrency: `Storyline.etag` (server-generated UUID, bumped on each write) returned in GET, required on PUT as `If-Match`. Stale client gets 409.

**Comment workflow:**
- User types comment → `DraftComment` row created in DB.
- User can edit / delete draft freely (DB-only ops).
- "Publish all" → backend creates a github review (POST `/repos/.../pulls/{n}/reviews`) bundling all the user's DraftComments + DraftReview body, then DELETEs the DraftComment + DraftReview rows. Returns github review object.
- "Publish single" → backend posts the one comment directly (POST `/issues/{n}/comments` or POST `/pulls/{n}/comments`), DELETEs the DraftComment row.
- Reply to an existing github comment = direct POST, no Draft row needed (or optionally Draft if user wants to compose offline; design phase decides).

**Realtime:** No SSE in v1. UI refreshes on user action. SSE can be reintroduced for backend-owned data (storyline + IntroComment) when collaboration UX needs it.

**Why this pivot:** Earlier design over-engineered for a thin middleware role. Avoiding duplication of github state is simpler, safer (no stale mirror bugs), and a tiny fraction of the code.

**Tech debt parked:**
- No live updates for backend-owned data (storyline edits / new IntroComment) — would need SSE.
- No live updates for github-side changes during a review session — would need either polling or webhooks; user clicks refresh in v1.
- Github API rate-limit per admin PAT shared across all users. Bring a cache when this becomes a real constraint.

---

## Open questions (to resolve in design phase)

- Comment publish flow: github "review" object (batched draft → submit) vs individual `pull_request_review_comment` writes — covered in section on data model.
- Storyline auto-commit timing (on every save? on workspace close? explicit?)
- AI-doc schema shape
- Workspace archive / cleanup policy
- Conflict resolution UX surface when `conflicted` outbox row appears
- Merge action authorization gates (require confirmation, surface protected-branch rules)
- Required webhook event subscriptions: at minimum `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`, `check_run`, `check_suite`, `workflow_run`, `status`

---

> **Disclaimer:** This document captures design intent during a working session. Technical decisions should be double-checked by a qualified subject-matter expert before being implemented in production-impacting code.
