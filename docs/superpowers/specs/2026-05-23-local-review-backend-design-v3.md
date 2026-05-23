# Local-Review Backend — Design Spec v3 (consolidated)

**Date:** 2026-05-23
**Author:** ybouzonie
**Status:** Approved
**Supersedes:** v1, v2 specs in this directory (kept for history).

This spec consolidates all decisions D17–D32 from the grilling session. The **public surface** (data model + REST API) is now canonical in:

- [`docs/data-model.md`](../../data-model.md) — entity shapes, constraints, computed states, authz matrix
- [`docs/api.md`](../../api.md) — endpoint contracts, request/response shapes, error envelope

This document covers **implementation concerns** that don't belong in the contract: internal architecture, service layering, testing approach, and the tech-debt list.

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
   │  Routing layer  (DRF views + url config)                  │
   │   ├─ apps.identity                                        │
   │   │    /api/auth/device/start  /api/auth/device/poll       │
   │   │    /api/auth/me            /api/auth/logout            │
   │   │                                                       │
   │   ├─ apps.workspaces  (workspace-anchored)                 │
   │   │    /api/workspaces                /api/workspaces/{}/storyline
   │   │    /api/workspaces/{uuid}         /api/intro-comments/{}/*
   │   │    /api/workspaces/{}/open-pr     /api/workspaces/{}/reopen-pr
   │   │    /api/workspaces/lookup                              │
   │   │                                                       │
   │   └─ apps.github_proxy  (PR-anchored + github-search)      │
   │        /api/repos/{o}/{r}/pulls/{n}/*                      │
   │        /api/github/prs?role=                               │
   │                                                          │
   │  Service layer                                            │
   │   ├─ identity.github_oauth     (device flow + /user check) │
   │   ├─ identity.session_service  (mint, hash, verify, revoke)│
   │   ├─ workspaces.storyline_service                          │
   │   ├─ workspaces.intro_comment_service                      │
   │   ├─ workspaces.open_pr_service  (orchestration)           │
   │   └─ github_proxy.gateway       (PyGithub + httpx)         │
   │                                                          │
   │  Persistence: Postgres prod, SQLite dev (6 tables)         │
   └──────────────────────────────────────────────────────────┘
                            │ HTTPS · admin PAT
                            ▼
                    ┌──────────────┐
                    │  GITHUB API  │
                    └──────────────┘
```

**Three Django apps:**

| App | Owns |
|---|---|
| `apps.identity` | `User`, `Session`, auth flow, the `SessionUserAuthentication` DRF class |
| `apps.workspaces` | `Workspace`, `Storyline`, `StorylineFile`, `IntroComment`, storyline / intro-comment / open-pr endpoints |
| `apps.github_proxy` | `GithubGateway` (PyGithub + httpx façade), all PR-anchored proxy + write-through endpoints, github-search |

**No background worker. No webhook receiver. No mirror tables. No outbox.** Every github read happens synchronously during the request that needs it.

---

## 2 · Tech stack

- **Python 3.12**, `uv`-managed.
- **Django 5.x** + **Django REST Framework**.
- **PyGithub** for typed github API endpoints; **httpx** for the rest (search API, device-flow endpoints, anything PyGithub doesn't cover well).
- **pytest** + **pytest-django** + **respx** (for mocking httpx in tests).
- **Postgres** prod / **SQLite** dev.

No celery, no redis, no Django-channels.

---

## 3 · Internal service contracts

The public surface is in `docs/api.md`. Internally, each app exposes a small set of service functions; views are thin wrappers that call services and serialize.

### 3.1 `apps.identity.github_oauth`

```python
def device_start() -> dict        # returns github's device-code response
def device_poll(device_code) -> dict | None
    # None if still pending; dict with `access_token` when complete
def fetch_user(access_token) -> dict   # GET /user with that token
```

The github access_token is **used once** to fetch `/user`, then **discarded**. Admin PAT does all subsequent github API work.

### 3.2 `apps.identity.session_service`

```python
def issue(user) -> tuple[str, Session]
    # returns (raw_token, session_row). Raw token returned once; only token_hash stored.
def find(raw_token) -> User | None
    # used by SessionUserAuthentication on every request
def revoke(session) -> None
```

### 3.3 `apps.workspaces.storyline_service`

```python
def create_storyline(workspace, author) -> Storyline
    # empty storyline + new etag. Called once when workspace is created.
def read_storyline(workspace, gateway) -> tuple[dict, str]
    # returns (payload_with_stale_flags, etag). gateway is used only when pr_number is set
    # to compute staleness against the current PR head.
def write_storyline(workspace, user, *, files: list[dict], if_match: str) -> str
    # creator-only, etag-checked. Replaces all StorylineFile rows in one transaction.
    # Raises NotCreator, ETagMismatch, WorkspaceFrozen.
```

### 3.4 `apps.workspaces.intro_comment_service`

```python
def list_for_file(storyline_file, include_resolved=False) -> list[dict]
    # returns threaded shape: roots with nested replies.
def post(storyline_file, user, body, parent_id=None) -> IntroComment
    # depth-1 enforcement. Raises WorkspaceFrozen.
def edit(comment, user, body) -> IntroComment
    # owner only.
def soft_delete(comment, user) -> None
    # owner only.
def resolve(comment, creator) -> IntroComment
    # creator-only, root-only.
def unresolve(comment, creator) -> IntroComment
```

### 3.5 `apps.workspaces.open_pr_service`

```python
def open_pr(workspace, creator, *, title, body, reviewers, labels, draft) -> dict
    # creator-only. Calls github create-PR (atomic with setting pr_number).
    # Reviewer/label adds are best-effort -> warnings[].
    # Raises NotCreator, PRAlreadyOpen, GithubError.
def reopen_pr(workspace, creator) -> dict
    # creator-only. Passthrough github PATCH state:open.
```

### 3.6 `apps.github_proxy.gateway`

Thin typed façade over PyGithub + httpx. One method per github endpoint we use.

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

Errors raised: `GithubNotFound (404)`, `GithubForbidden (403)`, `GithubConflict (409/412)`, `GithubError (anything else 4xx/5xx)`. Each carries the status code + github's error body for the view layer to pass through.

---

## 4 · Computed-state semantics

These belong entirely to the request layer; no enum stored.

```python
def workspace_state(workspace, gateway) -> str:
    if workspace.pr_number is None:
        return "ready-to-share" if not _storyline_complete(workspace) else "ready-to-publish"
    pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
    if pr["state"] == "closed":
        return "merged" if pr.get("merged") else "closed"
    return "published"

def is_frozen(workspace, gateway) -> bool:
    if workspace.pr_number is None:
        return False
    pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
    return pr["state"] == "closed"  # both closed-without-merge and merged are frozen
```

`is_frozen` is checked at the start of every write endpoint inside the workspace surface. One github call per write — acceptable for the POC (D24).

`storyline_complete`:

```python
def _storyline_complete(workspace) -> bool:
    files = list(workspace.storyline.files.all()) if hasattr(workspace, "storyline") else []
    return len(files) >= 1 and all(f.intro_text.strip() for f in files)
```

---

## 5 · Stale-step detection

Computed during `GET /api/workspaces/{uuid}/storyline`:

```python
def annotate_stale(storyline_files, gateway, workspace) -> list[dict]:
    if workspace.pr_number:
        pr_files = {f["filename"]: f for f in gateway.list_pr_files(...)}
    else:
        # local phase: best-effort by listing files in the branch's compare-vs-base
        pr_files = {}  # treat all as not-stale; the local-phase staleness
                       # heuristic is roadmap (the client may use local git
                       # to flag stale steps itself in the meantime)
    out = []
    for sf in storyline_files:
        stale = sf.diff_file_path not in pr_files if pr_files else False
        out.append({
            ...serialized fields...,
            "stale": stale,
            "stale_reason": "file_removed" if stale else None,
        })
    return out
```

Rename detection (returning `"file_renamed_to:..."`) is **deferred** — github's PR-files response includes `previous_filename` for renames; that's a v1.1 optimization.

---

## 6 · Persistence + migrations

- 6 tables (see `docs/data-model.md`).
- Django ORM only; no engine-specific column types or functions.
- All migrations runnable on both Postgres and SQLite.
- `Workspace.id` is a UUID column (`models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)`).
- `Storyline.raw_json` is `TextField` for engine-portability; migrate to `JSONField` only if structured queries become a need.

---

## 7 · Testing approach

Three layers:

1. **Service-layer unit tests** — pure Python, mock `GithubGateway` with `MagicMock`. Cover authz branches, etag logic, depth-1 thread invariant, frozen-rejection.
2. **API integration tests** — `APIClient` + mocked gateway. One test per endpoint; cover happy path + 1-2 error paths.
3. **Gateway contract tests** — `respx` mocks for the actual github HTTP shapes. Covers status-code mapping, header forwarding (ETag, pagination).

No real github calls in CI. Real-PAT smoke is a manual checklist run by the developer before tagging a release.

---

## 8 · Tech debt parked (explicit)

| Item | Why it's debt | Upgrade path |
|---|---|---|
| Admin PAT for all github API calls | Actions appear as PAT owner; rate limit shared across all users | Per-user OAuth (Github App or OAuth App + on-behalf-of), reusing the existing device-flow identity scaffold |
| No realtime push | Storyline edits / new IntroComments / github changes invisible until refresh | SSE per workspace (D20 already labels endpoints with stable shape) |
| No github read cache | Latency tax + rate-limit risk on enrichment endpoints | Per-route conditional ETag cache (60s) — decorator on read endpoints |
| Permissive authz | Anyone authed can post intro comments / write-through reviews on any open workspace | Consult `UserRepoPermission` cache (currently absent — recreate when needed) |
| Write-through reviews | No offline-drafts; no local-first sync | See `docs/ROADMAP.md` (the local-first model is the explicit phase-2 goal) |
| No webhook ingress | github-side state changes (new reviewer, new comment, PR state change) invisible until client refresh | smee.io for dev, public URL for prod; webhook secret per repo |
| No file-rename detection in stale flags | Renames surface as `file_removed` instead of `file_renamed_to:...` | Use `previous_filename` from PR-files response |

---

## 9 · Open questions (resolve during implementation)

These are intentionally left for the implementing developer to confirm with current information at implementation time:

- **AI-doc parser tolerance:** spec said reject malformed; v3 dropped AI-doc entirely (D28). If reintroduced later, decide then.
- **Local-phase stale-step heuristic:** while `pr_number IS NULL`, backend has no PR diff to compare against. v1 punts (returns `stale=false`). Whether to add a "compare branch vs base" call (one extra github fetch on storyline read) is a deferred ask.
- **CSRF + cookie scope:** session is Bearer-token only (no cookies). DRF CSRF middleware is irrelevant for the API. Confirm no other surfaces (admin etc.) need CSRF in deploy config.
- **`open-pr` payload validation:** should the backend validate that the storyline references file paths that actually exist in the github compare? Default: no — open-pr trusts the client; the storyline can be edited post-publish.
- **Pagination defaults:** github paginates `branches`, `comments`, `search`. Forward `Link` headers; client follows. Confirmed.

---

## 10 · References

- **Contract docs (canonical for API + data model):** `docs/data-model.md`, `docs/api.md`.
- **Decisions log:** `docs/decisions/2026-05-23-foundational-decisions.md` (D1–D32).
- **ADRs:** `docs/adr/0001-three-tier-topology.md`, `docs/adr/0003-workspace-identity-and-phases.md`, `docs/adr/0004-write-through-comments-poc.md`.
- **Roadmap:** `docs/ROADMAP.md`.
- **Prior specs (history):** v1, v2 in this directory.
