# Stage — Backend API (v1 contract)

REST contract between the Stage Backend and the Local Client. This document is the **interface contract** — the client implements against it; the backend serves it. Both sides agree to this surface.

For the data shapes referenced below, see `docs/data-model.md`. For the rationale behind every choice, see `docs/design.md` (current architecture) and `docs/adr/` (key decision records). Full brainstorming history is preserved verbatim under `docs/history/`.

---

## Conventions

### Base + content type
- Base URL: `https://<stage-backend>` (deploy-specific). All endpoints prefixed with `/api/v1/`.
- Requests: `Content-Type: application/json`.
- Responses: `Content-Type: application/json` unless noted.

### Authentication
Every endpoint except the auth ones below requires:

```
Authorization: Bearer <stage_session_token>
```

The token is obtained via the github device flow (see `POST /api/v1/auth/device/*` below) and stored by the Client (recommended: OS keychain). The Client **never** sends a github credential to anyone except the github device-flow endpoints (and even those go through the backend).

### Error envelope
Every non-2xx response uses this shape:

```json
{
  "message": "Human-readable explanation",
  "extra": {}
}
```

`message` is a machine-readable slug string (also human-readable). `extra` carries additional context (field errors, passthrough details, etc.) and may be an empty object.

Common `message` values:

| `message` | When |
|---|---|
| `unauthenticated` | missing / invalid / revoked Bearer token (401) |
| `forbidden` | authenticated, but action requires creator privilege (403) |
| `not_found` | resource doesn't exist (404) |
| `workspace_frozen` | write attempted on a workspace whose PR is closed or merged (409) |
| `etag_mismatch` | storyline PUT `If-Match` does not match current `etag` (409) |
| `pr_already_open` | open-pr called on a workspace whose PR is already open (409) |
| `validation_error` | malformed request body (400) |
| `github_error` | github returned an error; passthrough status preserved (4xx/5xx) |

### Surface split
The API has two surfaces:

- **Workspace-anchored** — `/api/v1/workspaces/{uuid}/...` — requires a Workspace; serves storyline + intro comments.
- **PR-anchored** — `/api/v1/repos/{owner}/{repo}/pulls/{number}/...` — requires only a github PR; pure passthrough to github (read or write-through).

A reviewer whose PR's author did not use Stage uses only the PR-anchored surface — Stage degrades to a thin review wrapper.

### URL encoding
- `{owner}`, `{repo}`, `{number}`, `{uuid}`, `{file_id}` are path parameters. `{path}` (file path with slashes) is **URL-encoded** by the client.

### Pagination
Github-paginated responses (branches, comments, etc.) are returned **as-is** with github's `Link` header forwarded. Client follows `Link: <next>`.

---

# Endpoint reference

## Authentication

### `POST /api/v1/auth/device/start/`
Initiate the github device flow.

**Request:** empty body.

**Response 200:**
```json
{
  "device_code": "abc123...",
  "user_code": "ABCD-1234",
  "verification_uri": "https://github.com/login/device",
  "interval": 5,
  "expires_in": 900
}
```

The Client shows `user_code` + `verification_uri` to the user and tells them to enter the code on any browser. Then polls.

### `POST /api/v1/auth/device/poll/`
Poll until github confirms the user entered the code.

**Request:**
```json
{ "device_code": "abc123..." }
```

**Response 200 (still pending):**
```json
{ "status": "pending" }
```

**Response 200 (success):**
```json
{
  "status": "ok",
  "session_token": "stg_eyJhbG...opaque",
  "user": {
    "id": 42,
    "github_login": "octocat",
    "github_user_id": 583231,
    "display_name": "The Octocat",
    "avatar_url": "https://avatars.example/o"
  }
}
```

The Client stores `session_token` securely; backend never re-issues it.

### `GET /api/v1/auth/me/`
Returns the current user. 401 if Bearer token is invalid or revoked.

**Response 200:**
```json
{
  "id": 42,
  "github_login": "octocat",
  "github_user_id": 583231,
  "display_name": "The Octocat",
  "avatar_url": "..."
}
```

### `POST /api/v1/auth/logout/`
Revokes the current session.

**Response 204** (no body).

---

## Workspaces (workspace-anchored)

### `POST /api/v1/workspaces/`
Create a new workspace. The author calls this when transitioning from Self-Review to Ready-to-share. An empty `Storyline` row is created together with the workspace.

**Request:**
```json
{
  "repo_owner": "acme",
  "repo_name": "payments",
  "head_ref": "feat/checkout-v2",
  "base_ref": "main"
}
```

`base_ref` is optional; defaults to the github repo's default branch.

**Response 201:**
```json
{
  "id": "5e8a4f...uuid",
  "repo_owner": "acme",
  "repo_name": "payments",
  "head_ref": "feat/checkout-v2",
  "base_ref": "main",
  "pr_number": null,
  "pr_opened_at": null,
  "created_by": { "id": 42, "github_login": "octocat" },
  "created_at": "2026-05-23T10:00:00Z",
  "last_active_at": "2026-05-23T10:00:00Z"
}
```

**Errors:** `409` if `(repo_owner, repo_name, head_ref)` already has a non-archived workspace.

### `GET /api/v1/workspaces/`
List workspaces the calling user can access. Optional filter `?repo_owner=&repo_name=`.

**Response 200:**
```json
[
  { ...workspace shape from POST 201..., "pr_number": 482, "pr_opened_at": "2026-05-23T11:00:00Z" },
  { ...workspace shape... }
]
```

For each entry, the Client computes the lifecycle state (`ready-to-share` / `ready-to-publish` / `published` / `closed` / `merged`) from the fields + a github PR fetch if needed.

### `GET /api/v1/workspaces/lookup/?repo_owner=&repo_name=&pr_number=`
Bridge from a github PR to a Stage workspace. Used by the reviewer's Client to ask "is there a Stage workspace for this PR?"

**Response 200:**
```json
{ "workspace_id": "5e8a4f...uuid", "created_by": { "id": 42, "github_login": "octocat" } }
```

**Response 404:** no workspace exists for that PR. The Client falls back to the PR-anchored surface for plain github review.

### `GET /api/v1/workspaces/{uuid}/`
Workspace metadata.

**Response 200:** same shape as the POST response.

### `PATCH /api/v1/workspaces/{uuid}/`
Update workspace metadata. **Only `head_ref` and `base_ref` are mutable**, and only while `pr_number IS NULL` (local phase). Once the PR is open, `head_ref` is synced from github.

**Request:**
```json
{ "head_ref": "feat/checkout-v3" }
```

**Response 200:** updated workspace.

**Errors:** `409` if changing `head_ref` to a value already used by another workspace; `409 workspace_frozen` if the PR is open or closed.

---

## Storyline

### `GET /api/v1/workspaces/{uuid}/storyline/`
Get the storyline (list shape, for the sidebar).

**Response 200:**
```json
{
  "etag": "uuid-string",
  "head_sha": "deadbeef...",
  "files": [
    {
      "id": "c3d4e5f6-...uuid",
      "diff_file_path": "src/checkout/PaymentStep.tsx",
      "order_index": 0,
      "title": "Payment step entry point",
      "intro_text": "Introduces tokenization...",
      "stale": false,
      "stale_reason": null,
      "intro_comment_count": 3,
      "intro_comment_unresolved": 1
    }
  ]
}
```

**Header:** `ETag: <etag value>` (same as in body).

`stale` is true when the path no longer matches any file in the current PR head's diff (e.g., file removed/renamed). `stale_reason` is one of: `"file_removed"`, `"file_renamed_to:<new_path>"`, or `"unknown"`.

`head_sha` is the current PR head SHA (or the latest commit on `head_ref` if no PR open). Useful for the Client to know when to refetch.

### `PUT /api/v1/workspaces/{uuid}/storyline/`
Replace the storyline. **Creator-only.** Requires `If-Match`.

**Request headers:** `If-Match: <etag>`

**Request body:**
```json
{
  "files": [
    {
      "diff_file_path": "src/checkout/PaymentStep.tsx",
      "order_index": 0,
      "title": "Payment step entry point",
      "intro_text": "Introduces tokenization..."
    },
    ...
  ]
}
```

The full list replaces the previous one (delete + bulk-insert in one transaction). Empty `files: []` is valid (clears the storyline).

**Response 200:** new storyline payload (same shape as GET), with the new `etag`.

**Errors:** `403 forbidden` (not creator); `409 etag_mismatch`; `409 workspace_frozen`; `412 precondition_required` (missing `If-Match`).

### `GET /api/v1/workspaces/{uuid}/storyline/files/{file_id}/`
Single step metadata (used when the reviewer focuses a step). `{file_id}` is a UUID.

**Response 200:**
```json
{
  "id": "c3d4e5f6-...uuid",
  "diff_file_path": "src/checkout/PaymentStep.tsx",
  "order_index": 0,
  "title": "Payment step entry point",
  "intro_text": "Introduces tokenization...",
  "stale": false,
  "stale_reason": null
}
```

The diff content + github comments for that file are fetched separately via the PR-anchored endpoints below.

---

## Intro comments

### `GET /api/v1/workspaces/{uuid}/storyline/files/{file_id}/intro-comments/?include_resolved=false`
List intro comments on a step. Single-level threading (each comment is either a root or a reply to a root).

**Response 200:**
```json
[
  {
    "id": "9a1b2c3d-...uuid",
    "parent_id": null,
    "user": { "id": 88, "github_login": "mira" },
    "body": "Why tokenize here vs in the store?",
    "created_at": "...",
    "updated_at": "...",
    "deleted_at": null,
    "resolved_at": null,
    "resolved_by": null,
    "replies": [
      {
        "id": "9a1b2c3e-...uuid",
        "parent_id": "9a1b2c3d-...uuid",
        "user": { "id": 42, "github_login": "octocat" },
        "body": "PCI scope reasons.",
        "created_at": "...",
        "updated_at": "...",
        "deleted_at": null
      }
    ]
  }
]
```

Resolved-root threads are excluded by default; pass `include_resolved=true` to include them.

### `POST /api/v1/workspaces/{uuid}/storyline/files/{file_id}/intro-comments/`
Post a new intro comment (root or reply).

**Request:**
```json
{ "body": "Why tokenize here?", "parent_id": null }
```

`parent_id` optional; if set, must reference a root (a comment with `parent_id: null`).

**Response 201:** the created comment (single-comment shape, with empty `replies`).

**Errors:** `403` if `parent_id` would create depth > 1; `409 workspace_frozen`.

### `PATCH /api/v1/intro-comments/{id}/`
Edit the body. Only the comment author. `{id}` is a UUID.

**Request:**
```json
{ "body": "Edited body" }
```

**Response 200:** updated comment.

**Errors:** `403`; `409 workspace_frozen`.

### `POST /api/v1/intro-comments/{id}/delete/`
Soft-delete. Only the comment author. Thread structure preserved (`deleted_at` set).

**Response 204.**

**Errors:** `403`; `409 workspace_frozen`.

### `POST /api/v1/intro-comments/{id}/resolve/`
Mark a root thread as resolved. **Creator-only.** Only roots (`parent_id IS NULL`) can be resolved.

**Response 200:** updated comment with `resolved_at` / `resolved_by` set.

**Errors:** `403`; `409 workspace_frozen`; `400 validation_error` if comment is not a root.

### `POST /api/v1/intro-comments/{id}/unresolve/`
Inverse of `/resolve/`. **Creator-only.**

**Response 200:** updated comment with `resolved_at` / `resolved_by` cleared.

---

## Publish lifecycle

### `POST /api/v1/workspaces/{uuid}/open-pr/`
First publish: open a github PR for this workspace. **Creator-only.** Calls github to create the PR atomically with setting `pr_number`. Reviewer / label assignment is best-effort; failures are returned as warnings, not blockers.

**Request:**
```json
{
  "title": "Replace legacy checkout with multi-step flow",
  "body": "## Summary\n...",
  "reviewers": ["mira", "jon-singh"],
  "labels": ["checkout"],
  "draft": false
}
```

`reviewers` is a list of github logins (and/or team slugs). `labels` is a list of label names. All optional except `title`.

**Response 201:**
```json
{
  "workspace": { ...updated workspace shape with pr_number set... },
  "pr": { "html_url": "https://github.com/acme/payments/pull/482", "number": 482 },
  "warnings": [
    { "code": "reviewer_failed", "reviewers": ["unknown"], "message": "..." }
  ]
}
```

`warnings` is `[]` on a fully clean call.

**Errors:**
- `403 forbidden` (not creator)
- `409 pr_already_open` (the workspace already has an open PR)
- `github_error` with passthrough status (e.g. 422 if github rejects)

If `github_error` occurs at PR creation, **nothing is persisted** (the workspace `pr_number` is not set).

### `POST /api/v1/workspaces/{uuid}/reopen-pr/`
Thin pass-through that calls github `PATCH /pulls/{n} { state: "open" }` on the workspace's `pr_number`. **Creator-only.**

**Response 200:** the github PR object.

**Errors:** `403`; `github_error` with passthrough status (e.g., 422 if the PR is merged or otherwise unreopenable).

If github refuses to reopen (typically because the PR was merged), the Client may then `POST /api/v1/workspaces/{uuid}/open-pr/` again with the same workspace — that creates a fresh github PR and **overwrites** `pr_number` on the workspace. The old PR number is no longer referenced.

---

# PR-anchored (no workspace required)

These endpoints take `(owner, repo, number)` directly. They proxy or write-through to github with the backend's admin PAT. They are usable whether or not a Stage workspace exists for the PR.

### `GET /api/v1/repos/{owner}/{repo}/pulls/{number}/`
Github PR object. Returned as-is from github.

### `GET /api/v1/repos/{owner}/{repo}/pulls/{number}/files/`
Github PR file list (each file's status, +/-, patch summary).

### `GET /api/v1/repos/{owner}/{repo}/pulls/{number}/files/{path}/diff/`
The diff patch for one file. (Backend filters github's `/pulls/{n}/files` response to that path.)

`path` is the file path, URL-encoded by the client.

### `GET /api/v1/repos/{owner}/{repo}/pulls/{number}/files/{path}/comments/`
Github review comments anchored to that file path.

### `GET /api/v1/repos/{owner}/{repo}/pulls/{number}/comments/`
Combined response: github review comments (line-anchored) + github issue comments (PR-level).

```json
{
  "issue_comments": [ ...github issue-comment shape... ],
  "review_comments": [ ...github review-comment shape... ]
}
```

### `GET /api/v1/repos/{owner}/{repo}/pulls/{number}/reviews/`
List github review objects on the PR.

### `GET /api/v1/repos/{owner}/{repo}/pulls/{number}/checks/`
Combined check runs + workflow runs for the PR's head SHA.

```json
{
  "check_runs": [ ...github check-runs shape... ],
  "workflow_runs": [ ...github actions runs shape... ]
}
```

### `POST /api/v1/repos/{owner}/{repo}/pulls/{number}/comments/create/`
Write-through: post a comment to github. Two kinds:

**Issue comment (PR-level):**
```json
{ "kind": "issue", "body": "Looks good overall." }
```

**Line comment (review):**
```json
{
  "kind": "review",
  "diff_file_path": "src/checkout/PaymentStep.tsx",
  "line": 12,
  "side": "RIGHT",
  "body": "Should we add a timeout here?"
}
```

The backend looks up the PR's current head SHA and uses it. For replies to existing review comments, add `"parent_comment_github_id": <id>`.

**Response 201:** the github comment object as returned by github.

**Errors:** `github_error` passthrough (e.g., 422 if the file path / line no longer exists).

### `POST /api/v1/repos/{owner}/{repo}/pulls/{number}/review/create/`
Write-through: submit a github Review with a batch of line comments and an event.

**Request:**
```json
{
  "body": "Overall thoughts...",
  "event": "REQUEST_CHANGES",
  "comments": [
    { "path": "src/checkout/PaymentStep.tsx", "line": 12, "side": "RIGHT", "body": "Add a timeout." },
    { "path": "src/state.ts", "line": 28, "side": "RIGHT", "body": "Naming nit." }
  ]
}
```

`event ∈ {"COMMENT", "APPROVE", "REQUEST_CHANGES"}`.

**Response 200:** the github review object.

### `POST /api/v1/repos/{owner}/{repo}/pulls/{number}/actions/close/`
`PATCH /pulls/{n} { state: "closed" }`. Returns the updated github PR.

### `POST /api/v1/repos/{owner}/{repo}/pulls/{number}/actions/reopen/`
`PATCH /pulls/{n} { state: "open" }`. Returns the updated github PR.

(For workspaces, prefer `POST /api/v1/workspaces/{uuid}/reopen-pr/` so the action is logged against the workspace.)

### `POST /api/v1/repos/{owner}/{repo}/pulls/{number}/actions/toggle-draft/`
Flips the github PR's `draft` flag. Backend reads current state then PATCHes the opposite.

### `POST /api/v1/repos/{owner}/{repo}/pulls/{number}/actions/merge/`
**Request:**
```json
{ "method": "squash" }
```

`method ∈ {"merge", "squash", "rebase"}`.

**Response 200:** github's merge response.

**Errors:** `github_error` passthrough (e.g., 405 if branch protection blocks merge).

---

# Github search

### `GET /api/v1/github/prs/?role=author|reviewer`
List the calling user's open github PRs for which **no Stage workspace exists**. Used by the Client to populate the "Open PRs not in Stage" buckets.

**Response 200:**
```json
{
  "items": [
    {
      "number": 483,
      "title": "Rewrite README onboarding section",
      "repo_owner": "acme",
      "repo_name": "payments",
      "html_url": "https://github.com/acme/payments/pull/483",
      "head_ref": "docs/readme-rewrite",
      "base_ref": "main",
      "author_login": "octocat",
      "updated_at": "2026-05-23T07:00:00Z"
    }
  ],
  "count": 1
}
```

Backend calls github's search API (`q=is:pr is:open author:{login}` or `q=is:pr is:open review-requested:{login}`) and cross-filters against the `Workspace` table.

---

# Quick state-machine reference for the Client

The Client renders the workspaces screen by combining:

| Backend call | Used for |
|---|---|
| `GET /api/v1/workspaces/` | "Local review" + "Public review" buckets |
| `GET /api/v1/github/prs/?role=author` | "Open PRs (authored by you, not in Stage)" bucket |
| `GET /api/v1/github/prs/?role=reviewer` | "Open PRs (awaiting your review, not in Stage)" bucket |
| local git (no backend call) | "Branches without a workspace" bucket |

For each workspace row, the Client also calls `GET /api/v1/repos/.../pulls/{n}/` (if `pr_number` is set) to compute `published / requested / approved / merged / closed`. Cache this client-side for the duration of the screen render.

---

# What's intentionally NOT in the API

- No `/import` endpoint — a reviewer encountering a PR with no workspace just uses the PR-anchored surface; they do **not** create a workspace on behalf of someone else.
- No `/api/workspaces/{uuid}/archive` — workspaces persist; mutability follows github PR state.
- No `/branches`, `/compare`, `/repositories` — client uses local git for these.
- No `/ai-doc` — AI assistance is client-side; its output goes into `StorylineFile.intro_text` via the storyline PUT.
- No realtime push (SSE / websocket) — the Client refreshes on user action. Realtime is roadmap.
- No webhook endpoints — github is not configured to call back into Stage in v1.
- No `Draft` endpoints — write-through review/comment model; the Client holds pre-publish drafts in its own state.
