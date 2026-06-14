# Stage — Design (as built)

**Status:** Canonical · reflects the v0.1.0-poc-backend implementation
**Last updated:** 2026-05-23
**See also:** `docs/api.md` (REST contract) · `docs/data-model.md` (persistence contract) · `docs/adr/` (key decision records) · `CONTEXT.md` (glossary)

This document is the single source of truth for "how Stage works today." For the deeper background on why a given decision was made, follow the link to the matching ADR. For the full brainstorming history (multiple discarded designs, the grilling session), see `docs/history/`.

> Disclaimer: design intent. Double-check with a qualified reviewer before any production use.

---

## 1 · What Stage is

Stage augments github's PR-review surface with two things github does not provide:

1. A **Storyline** — the author's chosen narrative for walking a reviewer through their change. An ordered sequence of steps, each anchored at one file in the diff, with an introductory note from the author.
2. **IntroComments** — threaded discussion on a storyline step's intro text. Github has no equivalent surface; this lives entirely Stage-side.

All other surfaces (file diffs, PR-line comments, reviews, approvals, CI checks, PR state changes, branches, repositories) are **brokered from github through the Stage backend**. Stage does not duplicate that data; it reads on demand and writes through.

The product target is a Tauri desktop app for the client; the backend is the Django service this document describes.

## 2 · Design criteria

1. **Human-tailored review** — humans always have the last word. Stage assists; it does not auto-decide.
2. **Local-first** — the client works against local state (local git, locally-cached backend data). Network is for sync, not for the core flow. (Today the backend reads are synchronous github calls — see roadmap for the offline-cache phase.)
3. **GitHub-compatible, no duplication** — Stage stores only what GitHub and git cannot already represent (Storyline, IntroComment). Review state (comments, approvals, request-changes) is synced through to GitHub so a non-Stage reviewer can use the PR normally.

## 3 · Topology

```
   Local Client  ⇄  Stage Backend  ⇄  GitHub
       │                                 ▲
       └─── local git (read-only) ───────┘
```

Three tiers, with strict communication shape. The full rationale is in **ADR-0001**.

- The **Local Client never talks to github directly.** It has no github credentials. Its only network peer is the Stage Backend.
- All non-git data the client needs comes from one of two sources: local git operations, or the Stage Backend API (which aggregates Stage-owned data with github data brokered on the user's behalf).
- The Stage Backend owns Stage-native data (Workspace, Storyline, IntroComment); it brokers everything else from github.
- Review actions (comments, approve, request-changes) are **write-through** today (see **ADR-0003**): the client posts to the backend, which writes them as native github review activity in the same request cycle.

## 4 · Domain model summary

The Stage backend persists **six tables**. The canonical field-by-field contract is `docs/data-model.md`; this is the conceptual summary.

| Entity | Stores | Notes |
|---|---|---|
| `User` | github identity (login, user_id, display name, avatar) | Extends `AbstractUser`; password unused (device-flow auth only) |
| `Session` | Bearer token hashes for active client sessions | Token-hashed at rest; raw value returned once at issue time |
| `Workspace` | One row per body of changes (UUID id) | See **ADR-0002** for identity rationale + lifecycle |
| `Storyline` | 1:1 to Workspace; the author's narrative metadata + etag | Created at workspace creation; etag enables optimistic concurrency on edit |
| `StorylineFile` | Ordered steps within a Storyline (one file per step) | `(storyline_id, diff_file_path)` is unique |
| `IntroComment` | Threaded discussion on a StorylineFile's intro | DB-enforced depth-1 invariant (a reply cannot have replies); soft-delete + resolve fields |

What Stage **does not** persist (and why):
- PR data, file diffs, github review comments, github issue comments, github reviews, CI checks, branches, repositories — owned by github, fetched on demand.
- `DraftReview` / `DraftComment` tables — see **ADR-0003** (write-through).
- A `Comment` entity for PR-line comments — same.
- Workspace state enum — phases (ready-to-share / ready-to-publish / published / closed / merged) are *computed* on read from the Workspace row + the live github PR state. No stored enum.

**Branch-vs-PR precondition (often confused):**
- The Workspace's `head_ref` branch **must exist on github** before the Workspace is created (Ready-to-share gesture). Without it, Stage cannot point at github-side diffs or open a PR later. The branch push happens between Self-Review and Ready-to-share; the client owns that step.
- **"Publish" means PR creation, not branch push.** First Publish creates the github PR and sets `pr_number`. Subsequent Publishes push storyline edits + comments against the same PR. The branch already lives on github; publish does not push it.
- Backend does **not** verify branch existence at workspace_create time (POC trust-the-client; verification adds one github call per create). Misconfiguration surfaces at first Publish, where `create_pull` returns 422 "no commits between head and base" or similar.

## 5 · API surface

Two parallel surfaces, distinguished by URL anchor:

- **Workspace-anchored** — `/api/v1/workspaces/{uuid}/...` — requires a Stage Workspace to exist; serves Storyline + IntroComments + open-pr orchestration.
- **PR-anchored** — `/api/v1/repos/{owner}/{repo}/pulls/{number}/...` — requires only a github PR; pure passthrough to github (read or write-through).

A reviewer whose PR's author never used Stage uses only the PR-anchored surface — Stage degrades to a thin review wrapper rather than refusing service.

URL style is flat REST: collections expose `GET`+`POST` on the same path; resources expose `GET`+`PATCH` on the same path; distinct write semantics get distinct action sub-paths (`/open-pr/`, `/resolve/`, `/actions/<action>/`). See **ADR-0004** for the full rationale.

The exhaustive endpoint listing — request shapes, error codes, response examples — is `docs/api.md`. Every error response uses the envelope:

```json
{ "message": "<machine-readable slug>", "extra": { } }
```

## 6 · Backend architecture

Single Django process. Six apps total — three inherited from the boilerplate, three new for Stage:

| App | Origin | Owns |
|---|---|---|
| `apps.core` | boilerplate | `BaseModel` (UUID id + timestamps + `full_clean()` in `save()`), `ApplicationError`, DRF exception handler, `/health/` endpoint |
| `apps.users` | boilerplate, extended | `User(AbstractUser)` with github fields appended (`github_login`, `github_user_id`, `display_name`, `avatar_url`, `last_login_at`) |
| `apps.admin` | boilerplate | Unfold registrations |
| `apps.identity` | Stage | `Session` model, github device-flow client (`github_oauth.py`), session services/selectors, `BearerSessionAuthentication`, auth endpoints |
| `apps.workspaces` | Stage | `Workspace`, `Storyline`, `StorylineFile`, `IntroComment` models; all workspace-anchored services/selectors/APIs; open-pr orchestration |
| `apps.github_proxy` | Stage | `GithubGateway` (typed facade over PyGithub + httpx), PR-anchored proxy endpoints, github search |

Inside each Stage app, the boilerplate's HackSoft-style split is followed strictly:

- `services.py` — writes / state changes. Functions are kw-only typed, named `<entity>_<action>`, wrapped with `@transaction.atomic` when multi-step. Raise `ApplicationError(message, extra={}, status=N)` for domain rule violations.
- `selectors.py` — reads. Same naming + signature conventions. Returns QuerySets or computed values; never writes.
- `apis.py` — DRF `APIView` subclasses, one class per resource (collection + resource methods share a class). Thin: validate input, call a service or selector, serialize output. No business logic. URL style is flat REST (**ADR-0004**).
- `serializers/<name>.py` — one DRF `Serializer` subclass per file.
- `factories.py` — `factory-boy DjangoModelFactory` subclasses for test data.

Tests live at `backend/tests/<app>/test_*.py`, mirroring the app tree. The boilerplate's `pyproject.toml` configures `pytest`, `pytest-django`, `respx` (for mocking httpx in gateway contract tests), and `factory-boy`.

**No background worker. No webhook receiver. No mirror tables. No outbox. No cache.** Every github read happens synchronously during the request that needs it. Each item on that list is on the roadmap (`docs/ROADMAP.md`) once POC traction warrants the operational complexity.

## 7 · Authentication

Device-flow login + opaque Bearer session tokens. Implementation in `apps.identity`:

1. Client calls `POST /api/v1/auth/device/start/` — backend forwards to github, returns `{user_code, verification_uri, device_code, ...}`.
2. User opens `verification_uri` and pastes the `user_code` in a browser.
3. Client polls `POST /api/v1/auth/device/poll/` with the `device_code`. Three possible outcomes:
   - `200 {"status": "pending"}` — still waiting on user; client backs off + retries.
   - `200 {"status": "ok", "session_token": "stg_...", "user": {...}}` — github returned an access token; backend used it once to `GET /user`, upserted the matching `User` row (matched on `github_user_id`), issued a Stage session token (`stg_` + 32 url-safe random bytes), persisted only its sha256 hash. The github access token is then **discarded**.
   - `4xx` — github returned a terminal error (expired_token, access_denied, …); surface to user.
4. Subsequent requests include `Authorization: Bearer stg_...`. The DRF `BearerSessionAuthentication` class hashes the raw token, looks up the matching un-revoked session, and resolves the user. `last_used_at` is bumped on every call.
5. `POST /api/v1/auth/logout/` sets `revoked_at` on the session; future requests with that token are rejected.

`GET /api/v1/auth/me/` returns the authed user's payload.

**Client pre-auth posture**: the client makes **zero** backend HTTP calls before the user has a session token — no `/health` ping, no speculative reachability probe. Self-Review is fully local-only (libgit2 + local diff). Backend reachability is first verified by the `POST /auth/device/start/` call triggered by the "Ready to share" gesture; any network failure surfaces at that moment, not earlier.

**v1 tech debt** (see § 12): the backend uses a single admin PAT for *all* github API calls (the user's own github token is only used during the device-flow exchange and then discarded). This is fine for the POC but means rate-limit and audit footprint are shared. Per-user OAuth is on the roadmap.

## 8 · Computed states + archived workspaces

The Workspace passes through phases that are **never stored**. They are computed on every read from `(Workspace row, live github PR state)`:

```python
def workspace_state(*, workspace, gateway):
    if workspace.pr_number is None:
        return "ready-to-share" if not _storyline_complete(workspace) else "ready-to-publish"
    pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
    if pr["state"] == "closed":
        return "merged" if pr.get("merged") else "closed"
    return "published"

def _storyline_complete(workspace):
    files = list(workspace.storyline.files.all())
    return len(files) >= 1 and all(f.intro_text.strip() for f in files)
```

A Workspace is **archived** when its github PR is closed (whether merged or not). Every write endpoint in the workspace surface calls a tiny gate at its start:

```python
def workspace_is_archived(*, workspace, gateway) -> bool:
    if workspace.pr_number is None:
        return False
    return gateway.get_pr(...)["state"] == "closed"
```

An archived workspace rejects every write with `409 {"extra": {"code": "workspace_archived"}}`. Reads still work — the storyline + intro comments + review history remain available indefinitely.

Reopening the PR on github (via `POST /api/v1/workspaces/<uuid>/reopen-pr/` or directly on github) automatically restores the workspace; no Stage state change is required.

One github `GET /pulls/{n}` per workspace write is accepted POC cost. A per-route conditional ETag cache is on the roadmap.

## 9 · Authorization

The authz matrix is creator-centric. The Workspace's `created_by_id` is the only privileged identity Stage tracks. The matrix is **phase-qualified**: pre-publish (no github PR yet) is strictly creator-only — work-in-progress drafts must not leak to other Stage users. Once the workspace is published as a github PR, reads become permissive (any authed Stage user can view) until per-repo gating lands.

| Action | Local phase (no PR yet) | Published (PR open) | Archived (PR closed / merged) |
|---|---|---|---|
| Create Workspace | any authed user | n/a | n/a |
| List Workspaces (`GET /workspaces/`) | own drafts only | own + any published | own + any closed/merged |
| Read Workspace (`GET /workspaces/<uuid>/`) | creator only — **404 to others** | any authed user | any authed user |
| PATCH Workspace metadata (`PATCH /workspaces/<uuid>/`) | creator only | rejected (head_ref/base_ref frozen once PR open) | rejected (workspace archived) |
| Read Storyline (`GET /workspaces/<uuid>/storyline/`) | creator only — **404 to others** | any authed user | any authed user |
| Edit Storyline (`PUT .../storyline/`) | creator only | creator only | nobody (409 workspace_archived) |
| Post / reply IntroComment | creator only (author's prep notes alongside the storyline they're composing) | any authed user | nobody |
| Edit IntroComment | comment author only | comment author only | nobody |
| Delete IntroComment (soft) | comment author only | comment author only | nobody |
| Resolve / unresolve IntroComment thread | Workspace creator only | Workspace creator only | nobody |
| Open PR (`POST /workspaces/<uuid>/open-pr/`) | creator only | n/a (PR already open) | creator only (re-publish path) |
| Reopen PR (`POST /workspaces/<uuid>/reopen-pr/`) | n/a | n/a | creator only |
| PR-anchored writes (passthrough github comments, reviews, PR actions) | n/a | any authed user | nobody |

**Why 404 (not 403) on pre-publish reads by non-creator**: a workspace in local phase is private state that the creator may not even have published yet; returning 403 would leak existence and let a stranger enumerate Stage users' draft work by guessing UUIDs. 404 is indistinguishable from "no such workspace."

**Permissive published reads** are a POC simplification. The intended end-state is "is creator OR is github reviewer/collaborator of the PR," which requires consulting github's per-repo permission API. Parked on the roadmap (see § 14).

## 10 · Storyline + stale-step detection

The Storyline is the central Stage-owned entity. Its on-disk shape is:

- `Storyline` (1:1 with Workspace) — holds `etag` (UUID, refreshed on every write) and `updated_by`. No JSON snapshot — `StorylineFile` rows are the sole source of truth.
- `StorylineFile` — ordered list of steps. Each row points at one diff file path with an order index, an optional title, and an intro text.

The author edits via `PUT /api/v1/workspaces/<uuid>/storyline/` with an `If-Match: <etag>` header (optimistic concurrency: mismatched etag → `409 etag_mismatch`). The body is the full new list of files — backend deletes and `bulk_create`s rows inside one transaction. A new etag is minted on success.

**Stale-step detection** runs during `GET /api/v1/workspaces/<uuid>/storyline/`. When the workspace has a github PR (`pr_number IS NOT NULL`), the backend asks github for the current PR files via `gateway.list_pr_files(...)`. Any `StorylineFile.diff_file_path` not present in that list is flagged `stale=True, stale_reason="file_removed"`. While the workspace is in local phase (no PR yet), the backend punts — `stale=False` — and the client uses local git to do its own staleness pass.

Rename detection (mapping `stale_reason="file_renamed_to:..."` via github's `previous_filename` field on the PR-files response) is **deferred to v1.1**.

## 11 · Github API integration — the Gateway pattern

A single `GithubGateway` class (`apps.github_proxy.gateway`) wraps every github API endpoint Stage uses. Built on `httpx.Client` with the github auth token, content type, and `X-GitHub-Api-Version` header baked into the base client. Context-manager friendly (`with GithubGateway(token=...) as g: ...`).

Methods are 1:1 with github endpoints we need:

- Reads: `get_pr`, `list_pr_files`, `get_file_diff`, `list_issue_comments`, `list_review_comments`, `list_reviews`, `list_check_runs`, `list_workflow_runs`, `search_issues`.
- Writes: `post_issue_comment`, `post_review_comment`, `post_review`, `patch_pr`, `merge_pr`, `create_pull`, `request_reviewers`, `add_labels`, `edit_issue_comment`, `delete_issue_comment`, `edit_review_comment`, `delete_review_comment`, `react_to_comment`.

Errors are mapped to a typed hierarchy: `GithubNotFound (404)`, `GithubForbidden (403)`, `GithubConflict (409/412)`, `GithubError (any other 4xx/5xx)`. Each carries the http status code and github's raw error body for the API layer to passthrough.

The gateway is the **only** module in the codebase that talks to github. All other modules (services, APIViews) accept a gateway instance by dependency injection — which keeps unit tests pure-Python (`MagicMock` substitutes the gateway), and gateway contract tests use `respx` to mock github's HTTP shapes directly.

## 12 · Persistence + migrations

- Postgres only at runtime. Provisioned via `docker compose up postgres`; settings via the pydantic `Env` class in `config/settings/env_schemas.py`.
- Django ORM exclusively. No engine-specific column types.
- All Stage models inherit `apps.core.models.BaseModel` — gives UUID `id`, `created_at`, `updated_at`, and a `full_clean()` safety net in `save()`. Exception: `users.User` extends Django's `AbstractUser` directly (keeps Django auth fields and `BigAutoField` PK).
- `Storyline.raw_json` is `TextField` (engine-portable). Promote to `JSONField` only when a structured query becomes a need.

## 13 · Testing

Three layers, all green at v0.1.0-poc-backend (168 tests, 96% line coverage):

1. **Service / selector unit tests** — pure Python; mock the gateway with `MagicMock`. Cover authz branches, etag logic, depth-1 thread invariant, archived rejection, computed-state edge cases.
2. **API integration tests** — `APIClient` + mocked gateway; one happy + 1-2 error paths per `APIView` class.
3. **Gateway contract tests** — `respx` mocks the actual github HTTP shapes; cover status-code mapping, header forwarding (ETag, pagination), `with-as` lifetime.

No real github calls in CI. A manual real-PAT smoke is part of the release checklist (`just generate-schema`, runserver, curl through a couple of endpoints).

After every code change run the verify pipeline before declaring done (see [CLAUDE.md](../CLAUDE.md)):

```sh
just pre-commit       # ruff + format + pyrefly + biome + cargo fmt + tsc + cargo check
just verify           # pre-commit + clippy + cargo test + pytest
```

## 14 · Tech debt parked (explicit)

| Item | Why it's debt | Upgrade path |
|---|---|---|
| Single admin PAT for all github API calls | Actions appear as the PAT owner (a human); rate limit shared across all Stage users; design.md and api.md describing "on user's behalf" is misleading until migration | **Staged migration:** (2a) replace PAT with a **GitHub App installation token** — actions appear as `stage-bot[bot]`, same machine-token model but proper bot identity. ~80 lines + one-time github app creation, see `docs/ROADMAP.md`. (2b, larger) full per-user OAuth on-behalf-of — each action attributed to the actual Stage user. The existing OAuth-App device-flow scaffold supports identity today; phase 2b extends it to scope-upgrade + token storage. |
| No realtime push | Storyline edits, IntroComment posts, github changes invisible until refresh | SSE per workspace (the API shapes are stable; only transport changes) |
| No github read cache | Latency tax + rate-limit risk on enrichment endpoints | Per-route conditional ETag cache (60s) — decorator on read APIView classes |
| Permissive authz | Anyone authed can post intro comments / write-through reviews on any open workspace | Consult per-repo permission cache (not built yet — recreate when needed) |
| Write-through reviews | No offline drafts; no local-first sync | See `docs/ROADMAP.md` — the explicit phase-2 goal |
| No webhook ingress | github-side state changes invisible until client refresh | smee.io for dev, public URL for prod; webhook secret per repo |
| No file-rename detection in stale flags | Renames surface as `file_removed` instead of `file_renamed_to:...` | Use `previous_filename` from PR-files response |
| Local-phase stale heuristic punts to client | While `pr_number IS NULL`, server returns `stale=false` always | Add `compare branch vs base` call (one extra github fetch) if client local-git approach proves insufficient |
| OpenAPI schema has many "unable to guess serializer" warnings | drf-spectacular needs `@extend_schema` decorators on plain `APIView` methods | Add decorators / move to a serializer-introspectable pattern when client codegen becomes useful |

## 15 · Out of scope (deliberate)

These were proposed during brainstorming and *intentionally* not built. Each is documented because the absence is informative — a future contributor should know we considered and rejected the idea.

- **Comment / DraftReview / DraftComment backend tables** — see ADR-0003. The POC is write-through.
- **Workspace import** — there is no "import this PR into Stage" action. A Workspace is created by the author via "Ready to share". A reviewer arriving at a PR with no Workspace reviews through PR-anchored endpoints; they do not create one on the author's behalf.
- **Manual archive** — there is no manual archive action and no stored archive flag. The **Archived** state is derived strictly from the github PR state. PR-close → archived workspace; PR-reopen → restored.
- **Repo / branch listing endpoints** — the backend offers exactly one github-search endpoint (`/api/v1/github/prs/?role=author|reviewer`). All other repo/branch enumeration goes directly to github through the client's local git or is fetched as needed via PR-anchored read endpoints.
- **AI-assisted storyline generation** — proposed and explored; dropped from v1 scope. Re-evaluate post-POC.
- **Per-user github OAuth** — see § 14 tech debt.

## 16 · See also

- `docs/api.md` — REST contract (canonical, machine-followable).
- `docs/data-model.md` — persistence contract (field-by-field).
- `docs/ROADMAP.md` — phase-2 hardening goals.
- `docs/adr/` — four accepted ADRs:
  - **ADR-0001** Three-tier topology
  - **ADR-0002** Workspace identity + computed phases
  - **ADR-0003** Write-through comments (POC stance)
  - **ADR-0004** Flat-REST URL style
  - **ADR-0005** Backend architecture and styleguide baseline
- `CONTEXT.md` — glossary + design criteria.
- `CLAUDE.md` — repo-wide Claude conventions (backend section covers Django patterns + structlog).
- `docs/history/` — full brainstorming archive (v1 + v2 specs/plans, v3 plan, the 793-line decisions log). Preserved for the "why did you reject X" lineage; not part of the canonical doc tree.
