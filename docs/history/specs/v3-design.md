# Local-Review Backend — Design Spec v3 (consolidated, boilerplate-aligned)

**Date:** 2026-05-23
**Author:** ybouzonie
**Status:** Approved
**Supersedes:** v1, v2 specs in this directory (kept for history).

This spec consolidates all decisions D17–D32 from the grilling session. The **public surface** (data model + REST API) is now canonical in:

- [`docs/data-model.md`](../../data-model.md) — entity shapes, constraints, computed states, authz matrix
- [`docs/api.md`](../../api.md) — endpoint contracts, request/response shapes, error envelope

This document covers **implementation concerns** that don't belong in the contract: internal architecture, service layering, testing approach, and the tech-debt list.

The boilerplate at `backend/` already provides the project skeleton (Django + DRF + structlog + drf-spectacular + Postgres + pytest + factory-boy + ruff + pyrefly). All implementation patterns below follow the HackSoft Django-styleguide baseline encoded in `backend/CONTEXT.md` + `backend/CLAUDE.md` + `backend/docs/adr/0001-architecture-and-styleguide-baseline.md`.

> Disclaimer: design intent. Double-check with a qualified reviewer before production use.

---

## 1 · Architecture (single Django process)

```
   Clients
     │ HTTPS · Bearer token
     ▼
   ┌──────────────────────────────────────────────────────────┐
   │                BACKEND  (Django · single process)         │
   │                                                          │
   │  Routing layer  (one APIView per HTTP operation)          │
   │   ├─ apps.identity                                        │
   │   │    /api/v1/auth/device/start  /device/poll            │
   │   │    /api/v1/auth/me            /logout                 │
   │   │                                                       │
   │   ├─ apps.workspaces  (workspace-anchored)                 │
   │   │    /api/v1/workspaces                                  │
   │   │    /api/v1/workspaces/{uuid}                           │
   │   │    /api/v1/workspaces/lookup                           │
   │   │    /api/v1/workspaces/{}/storyline                     │
   │   │    /api/v1/workspaces/{}/storyline/files/{id}          │
   │   │    /api/v1/workspaces/{}/storyline/files/{id}/intro-comments
   │   │    /api/v1/intro-comments/{id}                         │
   │   │    /api/v1/intro-comments/{id}/(resolve|unresolve)     │
   │   │    /api/v1/workspaces/{}/open-pr                       │
   │   │    /api/v1/workspaces/{}/reopen-pr                     │
   │   │                                                       │
   │   └─ apps.github_proxy  (PR-anchored + github search)      │
   │        /api/v1/repos/{o}/{r}/pulls/{n}/*                   │
   │        /api/v1/github/prs?role=                            │
   │                                                          │
   │  Domain layer (per-app split)                             │
   │   ├─ services.py    (writes / state changes; kw-only typed)│
   │   ├─ selectors.py   (reads; never write)                   │
   │   ├─ models.py      (BaseModel-inheriting)                 │
   │   └─ factories.py   (factory-boy DjangoModelFactory)       │
   │                                                          │
   │  Cross-cutting                                            │
   │   ├─ apps.core      (BaseModel, ApplicationError, handler) │
   │   └─ apps.users     (User(AbstractUser) — extended)        │
   │                                                          │
   │  Persistence: Postgres only (Django ORM via psycopg)       │
   └──────────────────────────────────────────────────────────┘
                            │ HTTPS · admin PAT
                            ▼
                    ┌──────────────┐
                    │  GITHUB API  │
                    └──────────────┘
```

**App responsibilities:**

| App | Origin | Owns |
|---|---|---|
| `apps.core` | boilerplate | `BaseModel`, `ApplicationError`, DRF exception handler, `/health/` endpoint |
| `apps.users` | boilerplate, **extended** | `User(AbstractUser)` w/ added `github_login`, `github_user_id`, `display_name`, `avatar_url`, `last_login_at` |
| `apps.admin` | boilerplate, **extended** | `ModelAdmin` registrations for Stage entities (Unfold) |
| `apps.identity` | **new** | `Session` (token), device-flow `github_oauth` module, `BearerSessionAuthentication` DRF class, auth endpoints |
| `apps.workspaces` | **new** | `Workspace`, `Storyline`, `StorylineFile`, `IntroComment`, all workspace-anchored endpoints + `open-pr` orchestration |
| `apps.github_proxy` | **new** | `GithubGateway` (PyGithub + httpx façade), PR-anchored proxy endpoints, github search |

**Removed from boilerplate before implementation:** `apps.items/` (reference impl), `backend/TODO.md` (obsolete).

**No background worker. No webhook receiver. No mirror tables. No outbox.** Every github read happens synchronously during the request that needs it.

---

## 2 · Tech stack

Inherits boilerplate stack:

- **Python 3.13**, `uv`-managed.
- **Django 5.2** + **Django REST Framework** 3.15+.
- **drf-spectacular** for OpenAPI; **django-unfold** for admin.
- **structlog** for all logging (key/value events; never f-strings — see `backend/CLAUDE.md` §Logging).
- **psycopg 3** + **Postgres only** (dev via `docker compose up postgres`).
- **pydantic-settings** for env vars (`config/settings/env_schemas.py`).
- **pytest** + **pytest-django** + **factory-boy** for tests.
- **ruff** + **pyrefly** + **pre-commit** for verification.

Added for Stage:

- **PyGithub** (typed github API endpoints).
- **httpx** (device-flow endpoints + search + anything PyGithub doesn't expose cleanly).
- **respx** dev-dep (mocks httpx in gateway contract tests).

No celery, no redis, no Django-channels.

---

## 3 · Internal service contracts

Per the styleguide: **writes** in `services.py`, **reads** in `selectors.py`, both with kw-only typed signatures. All raise `ApplicationError(message, extra={}, status=<int>)` for domain rule violations — the custom DRF handler converts to the uniform `{"message": ..., "extra": ...}` envelope.

### 3.1 `apps.identity.github_oauth`

A thin IO module — not a service (no DB writes, talks to external IDP). Lives at `apps/identity/github_oauth.py`.

```python
def device_start() -> dict        # returns github's device-code response
def device_poll(*, device_code: str) -> dict | None
    # None if still pending; dict with `access_token` when complete
    # Raises ApplicationError(status=400) on terminal error
def fetch_user(*, access_token: str) -> dict   # GET /user with that token
```

The github access_token is **used once** to fetch `/user`, then **discarded**. Admin PAT does all subsequent github API work.

### 3.2 `apps.identity.services` / `apps.identity.selectors`

```python
# services.py
def session_issue(*, user: User) -> tuple[str, Session]
    # returns (raw_token, session_row). Raw token returned once; only token_hash stored.

def session_revoke(*, session: Session) -> None

# selectors.py
def session_find_user(*, raw_token: str) -> User | None
    # used by BearerSessionAuthentication on every request; touches last_used_at
```

### 3.3 `apps.workspaces.services` / `apps.workspaces.selectors`

```python
# services.py — writes
def workspace_create(*, creator: User, repo_owner: str, repo_name: str,
                     head_ref: str, base_ref: str) -> Workspace
def workspace_update_local_phase(*, workspace: Workspace,
                                 head_ref: str | None = None,
                                 base_ref: str | None = None) -> Workspace
    # Raises ApplicationError("workspace_frozen", status=409) if pr_number set

def storyline_create(*, workspace: Workspace, author: User) -> Storyline
def storyline_replace(*, workspace: Workspace, user: User,
                      files: list[dict], if_match: str, gateway: GithubGateway) -> str
    # creator-only, etag-checked. Replaces all StorylineFile rows in one transaction.
    # Raises ApplicationError with codes: not_creator (403), etag_mismatch (409),
    # workspace_frozen (409).

def intro_comment_create(*, storyline_file: StorylineFile, user: User,
                         body: str, parent: IntroComment | None = None,
                         gateway: GithubGateway) -> IntroComment
def intro_comment_update(*, comment: IntroComment, user: User, body: str) -> IntroComment
def intro_comment_soft_delete(*, comment: IntroComment, user: User) -> None
def intro_comment_resolve(*, comment: IntroComment, creator: User) -> IntroComment
def intro_comment_unresolve(*, comment: IntroComment, creator: User) -> IntroComment

def pull_request_open(*, workspace: Workspace, creator: User, title: str, body: str,
                      reviewers: list[str], labels: list[str], draft: bool,
                      gateway: GithubGateway) -> dict
def pull_request_reopen(*, workspace: Workspace, creator: User,
                        gateway: GithubGateway) -> dict

# selectors.py — reads
def workspace_list(*, user: User | None = None) -> QuerySet[Workspace]
def workspace_get(*, workspace_id: uuid.UUID) -> Workspace
def workspace_lookup(*, repo_owner: str, repo_name: str, pr_number: int) -> Workspace | None
def storyline_read(*, workspace: Workspace, gateway: GithubGateway) -> tuple[dict, str]
    # returns (payload_with_stale_flags, etag). Gateway used only when pr_number is set.
def storyline_file_read(*, workspace: Workspace, file_id: int,
                        gateway: GithubGateway) -> dict
def intro_comment_thread(*, storyline_file: StorylineFile,
                         include_resolved: bool = False) -> list[dict]
    # threaded shape: roots with nested replies.
```

### 3.4 `apps.github_proxy.gateway`

A thin typed façade over PyGithub + httpx. Not a service (it's an external-IO adapter). Lives at `apps/github_proxy/gateway.py`. One method per github endpoint we use.

```python
get_pr(o, r, n) -> dict
list_pr_files(o, r, n) -> list[dict]
get_file_diff(o, r, n, path) -> dict   # filters list_pr_files
list_issue_comments(o, r, n) -> list[dict]
list_review_comments(o, r, n) -> list[dict]
list_reviews(o, r, n) -> list[dict]
list_check_runs(o, r, head_sha) -> dict
list_workflow_runs(o, r, head_sha) -> dict
post_issue_comment(o, r, n, body) -> dict
post_review_comment(o, r, n, *, body, path, line, side, commit_id|in_reply_to) -> dict
post_review(o, r, n, *, body, event, comments) -> dict
patch_pr(o, r, n, **fields) -> dict
merge_pr(o, r, n, *, method) -> dict
create_pull(o, r, *, title, body, base, head, draft) -> dict
request_reviewers(o, r, n, *, reviewers) -> dict
add_labels(o, r, n, *, labels) -> list[dict]
edit_issue_comment(o, r, comment_id, body) -> dict
delete_issue_comment(o, r, comment_id) -> None
edit_review_comment(o, r, comment_id, body) -> dict
delete_review_comment(o, r, comment_id) -> None
react_to_comment(o, r, kind, comment_id, content) -> dict
search_issues(query) -> dict
```

Errors raised: `GithubNotFound (404)`, `GithubForbidden (403)`, `GithubConflict (409/412)`, `GithubError (any other 4xx/5xx)`. Each carries `status_code` + github's error body. The API layer translates these to `ApplicationError` so the uniform envelope applies; the alternative — letting them surface — works too because the DRF handler can be extended to recognize the gateway hierarchy. The plan uses the **translation** approach (one place, services.py) for consistency.

### 3.5 API layer (`apis.py`)

One `APIView` subclass per HTTP operation, named `<Entity><Action>Api`. Each view:
1. Validates input (input serializer in `apps/<app>/serializers/<name>.py`).
2. Calls a single service or selector.
3. Serializes via output serializer; returns `Response(..., status=...)`.

No business logic in views. No ViewSets, no generic mixins (per styleguide).

---

## 4 · Computed-state semantics

These belong entirely to the request layer; **no enum stored**.

```python
# apps/workspaces/selectors.py — pure helpers, used by apis.py to enrich payloads
def workspace_state(*, workspace: Workspace, gateway: GithubGateway) -> str:
    if workspace.pr_number is None:
        return "ready-to-share" if not _storyline_complete(workspace) else "ready-to-publish"
    pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
    if pr["state"] == "closed":
        return "merged" if pr.get("merged") else "closed"
    return "published"


def workspace_is_frozen(*, workspace: Workspace, gateway: GithubGateway) -> bool:
    if workspace.pr_number is None:
        return False
    pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
    return pr["state"] == "closed"  # both closed-without-merge and merged are frozen


def _storyline_complete(workspace: Workspace) -> bool:
    files = list(workspace.storyline.files.all()) if hasattr(workspace, "storyline") else []
    return len(files) >= 1 and all(f.intro_text.strip() for f in files)
```

`workspace_is_frozen` is checked at the start of every write inside the workspace surface. One github call per write — acceptable for the POC (D24).

---

## 5 · Stale-step detection

Computed during `GET /api/v1/workspaces/{uuid}/storyline`:

```python
def _annotate_stale(storyline_files, gateway, workspace) -> list[dict]:
    if workspace.pr_number:
        pr_files = {f["filename"]: f for f in gateway.list_pr_files(...)}
    else:
        # local phase: punt — client uses local git to flag stale steps itself.
        pr_files = {}
    out = []
    for sf in storyline_files:
        stale = bool(pr_files) and sf.diff_file_path not in pr_files
        out.append({
            ...,  # serialized fields
            "stale": stale,
            "stale_reason": "file_removed" if stale else None,
        })
    return out
```

Rename detection (`"file_renamed_to:..."`) is **deferred**. github's PR-files response includes `previous_filename` for renames — v1.1 optimization.

---

## 6 · Persistence + migrations

- 6 tables (see `docs/data-model.md`): `users_user` (extended), `identity_session`, `workspace`, `storyline`, `storyline_file`, `intro_comment`.
- All Stage models inherit `apps.core.models.BaseModel` → UUID `id` + `created_at` + `updated_at` + `full_clean()` in `save()`. The one exception: `users.User` inherits `AbstractUser` directly (per `backend/CONTEXT.md`) — keeps Django auth fields (`username`, `password`, `date_joined`, `last_login`, `BigAutoField` PK). We will leave password unset (device flow + Bearer; never `set_password`).
- `Workspace.id` already a UUID via `BaseModel` — no manual override needed.
- `Storyline.raw_json` is `TextField` for portability; revisit `JSONField` if structured queries become a need.
- Django ORM only; no engine-specific column types or functions. Postgres-only at runtime per boilerplate.

---

## 7 · Testing approach

Boilerplate convention: tests live at the **root** `tests/<app>/test_*.py` mirroring `apps/<app>/`. Factory-boy factories live in `apps/<app>/factories.py` (so they're importable by non-test code too).

Three layers:

1. **Service / selector unit tests** — pure Python, mock `GithubGateway` with `MagicMock`. Cover authz branches, etag logic, depth-1 thread invariant, frozen rejection. Live in `tests/workspaces/test_services.py`, `tests/workspaces/test_selectors.py`, etc.
2. **API integration tests** — `APIClient` + mocked gateway, one test per `<Entity><Action>Api`. Cover happy path + 1-2 error paths. Live in `tests/<app>/test_apis.py`.
3. **Gateway contract tests** — `respx` mocks for the actual github HTTP shapes. Covers status-code mapping, header forwarding (ETag, pagination). Live in `tests/github_proxy/test_gateway.py`.

No real github calls in CI. Real-PAT smoke is a manual checklist run by the developer before tagging a release.

After every code change run the boilerplate verify pipeline before declaring done:

```sh
uv run pre-commit run --all-files   # ruff check + format
just typecheck                       # pyrefly
just test                            # pytest
```

---

## 8 · Tech debt parked (explicit)

| Item | Why it's debt | Upgrade path |
|---|---|---|
| Admin PAT for all github API calls | Actions appear as PAT owner; rate limit shared across all users | Per-user OAuth (Github App or OAuth App + on-behalf-of), reusing existing device-flow identity scaffold |
| No realtime push | Storyline edits / new IntroComments / github changes invisible until refresh | SSE per workspace (D20 already labels endpoints with stable shape) |
| No github read cache | Latency tax + rate-limit risk on enrichment endpoints | Per-route conditional ETag cache (60s) — decorator on read APIView classes |
| Permissive authz | Anyone authed can post intro comments / write-through reviews on any open workspace | Consult `UserRepoPermission` cache (currently absent — recreate when needed) |
| Write-through reviews | No offline-drafts; no local-first sync | See `docs/ROADMAP.md` (the local-first model is the explicit phase-2 goal) |
| No webhook ingress | github-side state changes invisible until client refresh | smee.io for dev, public URL for prod; webhook secret per repo |
| No file-rename detection in stale flags | Renames surface as `file_removed` instead of `file_renamed_to:...` | Use `previous_filename` from PR-files response |
| Local-phase stale heuristic punts to client | While `pr_number IS NULL`, server returns `stale=false` always | Add `compare branch vs base` call (one extra github fetch on storyline read) if client local-git approach proves insufficient |

---

## 9 · Open questions (resolve during implementation)

These are intentionally left for the implementing developer to confirm with current information at implementation time:

- **CSRF + cookie scope:** session is Bearer-token only (no cookies). DRF CSRF middleware not added by boilerplate. Confirm no other surfaces (admin etc.) need CSRF in deploy config.
- **`open-pr` payload validation:** should the backend validate that the storyline references file paths that actually exist in the github compare? Default: no — open-pr trusts the client; the storyline can be edited post-publish.
- **Pagination defaults:** github paginates `branches`, `comments`, `search`. Forward `Link` headers; client follows.
- **`User.username` mapping:** with no password flow, what populates `username`? Default plan: `username = github_login` (and update if the github user renames). Keeps Django admin functional. Confirm no collision with non-github admin users created via `createsuperuser` (treat that as out-of-band).

---

## 10 · References

- **Contract docs (canonical for API + data model):** `docs/data-model.md`, `docs/api.md`.
- **Decisions log:** `docs/decisions/2026-05-23-foundational-decisions.md` (D1–D32).
- **ADRs:** `docs/adr/0001-three-tier-topology.md`, `docs/adr/0003-workspace-identity-and-phases.md`, `docs/adr/0004-write-through-comments-poc.md`.
- **Boilerplate ADR (style baseline):** `backend/docs/adr/0001-architecture-and-styleguide-baseline.md`.
- **Boilerplate conventions:** `backend/CONTEXT.md`, `backend/CLAUDE.md`.
- **Roadmap:** `docs/ROADMAP.md`.
- **Prior specs (history):** v1, v2 in this directory.
