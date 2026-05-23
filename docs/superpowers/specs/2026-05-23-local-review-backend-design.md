# Local-Review Backend · Design Spec

**Date:** 2026-05-23
**Author:** ybouzonie
**Status:** Approved (brainstorm phase complete — implementation plan next)
**Companion document:** [`docs/decisions/2026-05-23-foundational-decisions.md`](../../decisions/2026-05-23-foundational-decisions.md) — captures every decision with rationale + rejected alternatives, including two large pivots during the session.

---

## 1 · Problem statement

GitHub's native pull-request review surface is linear and lacks a way for the PR author to express **a storyline** — the order files should be reviewed in and the *intent* behind each file's changes. Reviewers consequently read code without an author-guided narrative and waste effort reconstructing the author's reasoning.

We are building a **deployable backend service** that augments the github review experience with:

1. **Author-defined storyline** — an ordered list of files, each with an optional *intro* (the author's intent for that file).
2. **Threaded discussion on intros** (`IntroComment`) — reviewers can question or react to an intro without going through github.
3. **Optional AI analysis ingestion** — the author may feed a structured analysis doc (produced by an agent like Claude Code) that reviewers see alongside the storyline.
4. **GitHub passthrough** for everything else (PR data, comments, reviews, checks, lifecycle actions) — the backend is a thin middleware. **GitHub remains the source of truth for all github-domain data; the backend never mirrors it.**

The backend exposes a REST API that a separate UI (out of scope for this spec) consumes.

---

## 2 · Goals · Non-goals

### Goals (v1)

- Workspace model bound 1:1 to a github pull request.
- Author can define + edit storyline (file order + intros).
- Anyone can post threaded `IntroComment`s on a storyline file's intro.
- Author can ingest a structured AI analysis document.
- Backend proxies all github reads + writes (PR data, comments, reviews, threads, checks, workflow runs, PR-lifecycle actions: close · reopen · toggle draft · merge).
- Multi-user simultaneous use (multiple reviewers + author on the same workspace).
- Backend runs locally in dev, deployable to a public host in production.

### Non-goals (v1)

- No mirror of github state. No `Comment` / `Review` / `CheckRun` / `WorkflowRun` rows in the DB.
- No event-driven sync, no webhooks, no `Outbox`, no `SyncEvent`, no reconciliation loop.
- No background worker (django-q / celery).
- No realtime push (SSE) to UI. Refresh on user action.
- No github read cache.
- No private per-user annotations (`LocalAnnotation` dropped).
- No per-user github tokens (single admin PAT in v1 — see §8 and §11).
- No fine-grained authz. Permissive in v1 except the one rule "only PR author can edit storyline".
- No cross-PR / stacked-PR navigation.
- No CLI (`create-pr`, `import-pr` etc.) — out of scope for the backend spec; the backend exposes routes a future CLI will call.

---

## 3 · Glossary

| Term | Meaning |
|---|---|
| **Workspace** | Backend's container for one github PR. Identity = `(repo_owner, repo_name, pr_number)`. |
| **Storyline** | The ordered list of files + per-file intros, defined by the PR author. |
| **StorylineFile** | One file entry in the storyline (path + order + intro text). |
| **IntroComment** | Threaded discussion on a storyline file's intro. Tool-native; never syncs to github. |
| **DraftComment** | A comment the user has composed but not yet pushed to github. Backend-only; deleted on publish. |
| **DraftReview** | Wrapper for a batch of `DraftComment`s plus the optional top-level review body + event (`COMMENT` / `APPROVE` / `REQUEST_CHANGES`). One per `(workspace, user)`. |
| **AIAnalysisDoc** | Author-ingested structured analysis document (markdown / json). Tool-native. |
| **AIAnalysisFile** | Per-diff-file section parsed out of an `AIAnalysisDoc`. |
| **Admin PAT** | The single github Personal Access Token configured in backend env; used for *all* github API calls in v1. (Tech debt: replace with per-user OAuth in a later spec.) |
| **Mode** | Property of a workspace: `author` (current user is the PR author) or `reviewer`. Derived from current user + github PR author. |
| **Github passthrough** | Backend route that calls github with the admin PAT and returns the response unchanged. |

---

## 4 · Architecture

### 4.1 Component layout

```
                                Users (browsers, multi-user)
                                          │
                                  HTTPS · session cookie
                                          ▼
       ╔════════════════════════════════════════════════════════════════════════╗
       ║                BACKEND  (Django · REST · single process)                ║
       ║                                                                        ║
       ║   Auth Layer                                                            ║
       ║     - github OAuth-login for app identity                               ║
       ║     - admin PAT (from env) for all github API calls                     ║
       ║     - session middleware (django default)                               ║
       ║                                                                        ║
       ║   REST Routes  ─────────────────────────────────────────────────────    ║
       ║     NATIVE (DB-backed):                                                  ║
       ║       /api/workspaces*                                                  ║
       ║       /api/workspaces/{id}/storyline*                                   ║
       ║       /api/workspaces/{id}/intro-comments*                              ║
       ║       /api/workspaces/{id}/ai-doc*                                      ║
       ║       /api/workspaces/{id}/drafts*                                      ║
       ║       /api/drafts/{id}/publish                                          ║
       ║       /api/workspaces/{id}/drafts/publish-all                           ║
       ║                                                                        ║
       ║     PROXY (passthrough to github via admin PAT):                         ║
       ║       /api/workspaces/{id}/pr                                           ║
       ║       /api/workspaces/{id}/files                                        ║
       ║       /api/workspaces/{id}/comments                                     ║
       ║       /api/workspaces/{id}/reviews                                      ║
       ║       /api/workspaces/{id}/threads                                      ║
       ║       /api/workspaces/{id}/checks                                       ║
       ║       /api/workspaces/{id}/workflow-runs                                ║
       ║       /api/workspaces/{id}/actions/*                                    ║
       ║                                                                        ║
       ║   GithubGateway (PyGithub + httpx · admin PAT)                          ║
       ║                                                                        ║
       ║   DB                                                                    ║
       ║     Postgres (prod) / SQLite (dev) · 10 tables · no mirror tables       ║
       ╚════════════════════════════════════════════════════════════════════════╝
                                          │ HTTPS · admin PAT
                                          ▼
                                   ┌──────────────┐
                                   │  GITHUB API  │
                                   └──────────────┘
```

### 4.2 Design rule (single sentence)

> **The DB stores only data that does not exist on github.**

Everything backend-owned is tool-native (storyline, intros, AI-doc, identity, pre-publish drafts). Everything else is read+write passthrough to github.

### 4.3 Why this shape

- Eliminates entire categories of bug: stale mirror, out-of-order events, dropped webhooks, conflict between mirror and source.
- Backend has zero infrastructure overhead beyond Django + DB (no broker, no worker, no tunnel).
- Github becomes the single source of truth; admin PAT carries all authority; the team's existing github permissions / branch protection / CODEOWNERS continue to apply unchanged.

### 4.4 Tradeoffs accepted

- **No realtime feel.** Other users' edits to storyline, new `IntroComment`s, and any github-side change since last load require an explicit refresh in the UI. Acceptable for v1; SSE is the upgrade path.
- **Every UI render touches github.** Latency = client + backend + github. May be slow on remote backend. No cache in v1; measure first.
- **Shared admin-PAT rate limit.** 5000 req/h across all users + workspaces. Measure before optimizing.

---

## 5 · Data model

10 tables. Postgres + SQLite compatible (no engine-specific features).

### 5.1 Identity

```
User
  id              PK
  github_login    str UNIQUE
  github_user_id  int                # github's numeric id
  display_name    str?
  avatar_url      str?
  created_at      timestamp
  last_login_at   timestamp

UserRepoPermission                  # cache scaffold; written but not enforced in v1
  id                  PK
  user_fk             FK User
  repo_owner          str
  repo_name           str
  level               enum  none | read | triage | write | maintain | admin
  fetched_at          timestamp
  expires_at          timestamp
  UNIQUE (user_fk, repo_owner, repo_name)
```

### 5.2 Workspace

```
Workspace
  id                  PK
  repo_owner          str
  repo_name           str
  pr_number           int
  created_by_user_fk  FK User
  created_at          timestamp
  archived_at         timestamp?
  last_active_at      timestamp
  UNIQUE (repo_owner, repo_name, pr_number)
```

One workspace per github PR. `mode` (author vs reviewer) is not stored — it is computed per request from `current_user.github_login == github_pr.author_login`.

### 5.3 Storyline

```
Storyline
  workspace_fk        PK + FK Workspace
  raw_json            text        # full storyline doc (canonical form)
  etag                uuid        # bumped on every write
  updated_at          timestamp
  updated_by_user_fk  FK User

StorylineFile
  id                  PK
  storyline_fk        FK Storyline
  diff_file_path      str
  order_index         int
  intro_text          text?
  UNIQUE (storyline_fk, diff_file_path)
```

`Storyline.raw_json` is the canonical document. `StorylineFile` rows are a flat projection of the same data, **updated atomically with `raw_json` inside a single DB transaction on every write**. Read endpoints serve from `StorylineFile` for cheap ordered access; `raw_json` is the audit form + makes future schema migration easier. If projection ever diverges from `raw_json` (should never happen given the transaction), `raw_json` wins and a rebuild job rewrites the projection.

### 5.4 Intro discussion (tool-native, threaded, never synced)

```
IntroComment
  id                      PK
  storyline_file_fk       FK StorylineFile
  user_fk                 FK User
  parent_fk               FK IntroComment?    # null = top-level, else reply
  body                    text
  created_at              timestamp
  updated_at              timestamp
  deleted_at              timestamp?          # soft-delete (preserves thread)
  resolved_by_user_fk     FK User?            # set by PR author only
  resolved_at             timestamp?
```

### 5.5 AI analysis (author-ingested)

```
AIAnalysisDoc
  id                    PK
  workspace_fk          FK Workspace UNIQUE     # at most one ingested doc per workspace
  raw_content           text
  ingested_at           timestamp
  ingested_by_user_fk   FK User
  source_label          str?                    # free-text e.g. "claude-code-skill v1"

AIAnalysisFile
  id                  PK
  ai_doc_fk           FK AIAnalysisDoc
  diff_file_path      str
  sections_json       json
  UNIQUE (ai_doc_fk, diff_file_path)
```

The schema accepted by `AIAnalysisDoc.raw_content` is defined in a separate spec (the Claude Code skill spec). The backend parses top-level structure and stores per-file blocks in `AIAnalysisFile` for efficient lookup.

**Path-vs-diff drift:** the AI doc may reference paths that no longer exist in the current diff (e.g., the author force-pushed after ingesting). The backend stores all `AIAnalysisFile` rows regardless; the UI filters out / flags entries whose path is not in the current PR diff at render time. Re-ingestion replaces the entire doc.

### 5.6 Per-user pre-publish drafts

```
DraftReview                                     # one row per (workspace, user)
  id                  PK                        # integer auto PK for ORM friendliness
  workspace_fk        FK Workspace
  user_fk             FK User
  body                text?
  event               enum  COMMENT | APPROVE | REQUEST_CHANGES
  created_at          timestamp
  updated_at          timestamp
  UNIQUE (workspace_fk, user_fk)                # enforces singleton

DraftComment
  id                          PK
  workspace_fk                FK Workspace
  user_fk                     FK User
  draft_review_fk             FK DraftReview?      # null if comment is "publish single",
                                                   # set if part of batch (attached to user's review draft)
  kind                        enum  issue | review
  diff_file_path              str?                  # review-kind only
  position                    int?                  # review-kind only (legacy diff position)
  line                        int?                  # review-kind only (line in file)
  side                        enum  LEFT | RIGHT?   # review-kind only
  body                        text
  parent_comment_github_id    str?                  # if reply to existing github comment
  created_at                  timestamp
  updated_at                  timestamp
```

`DraftReview` uses a normal integer PK with a `UNIQUE (workspace_fk, user_fk)` constraint rather than a composite PK, for ORM compatibility (Django's composite-PK support is recent and still rough).

**Lifecycle:** create → edit / delete freely → publish (single or batch) → on github-success, **delete the row(s)**. The DB never holds a published comment.

---

## 6 · API surface

All routes require an authenticated session (OAuth-login). Routes return JSON. Errors use HTTP status codes + a `{ "error": { "code", "message" } }` body.

### 6.1 Native routes (DB-backed)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/workspaces` | `{ repo_owner, repo_name, pr_number }` | Creates workspace. Calls github to verify PR exists. Returns 201 + workspace. |
| GET | `/api/workspaces` | — | Lists workspaces for the current user (created or recently active). |
| GET | `/api/workspaces/{id}` | — | Workspace metadata + computed `mode` + storyline summary. |
| DELETE | `/api/workspaces/{id}` | — | Archive (soft). Sets `archived_at`. |
| GET | `/api/workspaces/{id}/storyline` | — | Returns `{ raw_json, files: [...], etag }`. ETag also in `ETag` header. |
| PUT | `/api/workspaces/{id}/storyline` | `{ files: [...] }` + `If-Match: <etag>` | **Author-only.** Replaces storyline. 412 if missing `If-Match`, 409 on ETag mismatch. Bumps `etag`. |
| GET | `/api/workspaces/{id}/intro-comments?file_id={sf_id}` | — | Lists comments on one storyline file (threaded). |
| POST | `/api/workspaces/{id}/intro-comments` | `{ storyline_file_id, parent_id?, body }` | Anyone with session can post. |
| PATCH | `/api/intro-comments/{id}` | `{ body }` | Author of the comment only. |
| DELETE | `/api/intro-comments/{id}` | — | Soft-delete. Author of the comment only. |
| POST | `/api/intro-comments/{id}/resolve` | — | **PR author only.** Sets `resolved_*`. |
| POST | `/api/intro-comments/{id}/unresolve` | — | PR author only. Clears `resolved_*`. |
| GET | `/api/workspaces/{id}/ai-doc` | — | Returns raw + parsed sections. 404 if not ingested. |
| POST | `/api/workspaces/{id}/ai-doc` | `{ raw_content, source_label? }` | **Author-only.** Replaces any prior doc. Parser splits into `AIAnalysisFile`. |
| DELETE | `/api/workspaces/{id}/ai-doc` | — | Author-only. |
| GET | `/api/workspaces/{id}/drafts` | — | The current user's drafts in this workspace. |
| GET | `/api/workspaces/{id}/draft-review` | — | The current user's `DraftReview` (or 404). |
| PUT | `/api/workspaces/{id}/draft-review` | `{ body?, event }` | Upsert. |
| POST | `/api/workspaces/{id}/drafts` | `{ kind, diff_file_path?, position?, line?, side?, body, parent_comment_github_id?, attach_to_review_draft?: bool }` | Creates draft. If `attach_to_review_draft=true`, the new `DraftComment` is linked to the current user's `DraftReview` (auto-created if missing) so it ships in the next `publish-all`. Default `false` — comment is standalone, publishable individually. |
| PATCH | `/api/drafts/{id}` | partial | Edit own draft. |
| DELETE | `/api/drafts/{id}` | — | Discard own draft. |
| POST | `/api/drafts/{id}/publish` | — | Push single comment to github, delete row, return github response. |
| POST | `/api/workspaces/{id}/drafts/publish-all` | — | Bundle `DraftReview` + all user's `DraftComment`s as one github review submission. On success, delete all draft rows. |

### 6.2 Proxy routes (github passthrough)

| Method | Path | What it calls |
|---|---|---|
| GET | `/api/workspaces/{id}/pr` | `GET /repos/{o}/{r}/pulls/{n}` |
| GET | `/api/workspaces/{id}/files` | `GET /repos/{o}/{r}/pulls/{n}/files` |
| GET | `/api/workspaces/{id}/files/content?path=&ref=` | `GET /repos/{o}/{r}/contents/{path}?ref={ref}` |
| GET | `/api/workspaces/{id}/comments` | combined: review comments + issue comments |
| GET | `/api/workspaces/{id}/reviews` | `GET .../pulls/{n}/reviews` |
| GET | `/api/workspaces/{id}/threads` | GraphQL: PR review threads with `isResolved` |
| GET | `/api/workspaces/{id}/checks?ref={sha}` | `GET .../commits/{sha}/check-runs` |
| GET | `/api/workspaces/{id}/workflow-runs?head_sha={sha}` | `GET .../actions/runs?head_sha={sha}` |
| PATCH | `/api/workspaces/{id}/comments/{gid}` | `PATCH .../comments/{gid}` — edit a published comment |
| DELETE | `/api/workspaces/{id}/comments/{gid}` | `DELETE .../comments/{gid}` |
| POST | `/api/workspaces/{id}/comments/{gid}/reactions` | `POST .../comments/{gid}/reactions` |
| POST | `/api/workspaces/{id}/threads/{gid}/resolve` | GraphQL `resolveReviewThread` |
| POST | `/api/workspaces/{id}/threads/{gid}/unresolve` | GraphQL `unresolveReviewThread` |
| POST | `/api/workspaces/{id}/actions/close` | `PATCH .../pulls/{n} { state: closed }` |
| POST | `/api/workspaces/{id}/actions/reopen` | `PATCH .../pulls/{n} { state: open }` |
| POST | `/api/workspaces/{id}/actions/toggle-draft` | `PATCH .../pulls/{n} { draft: bool }` |
| POST | `/api/workspaces/{id}/actions/merge` | `PUT .../pulls/{n}/merge { method }` |

Proxy routes: backend forwards status codes from github 1:1 (with body translated to our envelope). Backend does no caching in v1.

### 6.3 Auth routes

| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/login` | Redirects to github OAuth. |
| GET | `/api/auth/callback` | OAuth callback. Creates / updates `User`. Sets session. |
| POST | `/api/auth/logout` | Clears session. |
| GET | `/api/auth/me` | Returns the current `User` or 401. |

---

## 7 · Request flows

### 7.1 Create workspace (author or reviewer)

1. Client `POST /api/workspaces { repo_owner, repo_name, pr_number }`.
2. Backend calls github `GET /repos/{o}/{r}/pulls/{n}` (admin PAT) to verify the PR exists.
3. Insert `Workspace`. Reject 409 if `(o, r, n)` already exists.
4. If `current_user.github_login == pr.user.login` (author mode), seed empty `Storyline` row + `StorylineFile` rows generated from `pulls/{n}/files` (paths only — backend does not store patches).
5. Return 201 + workspace metadata.

### 7.2 Load workspace for reviewing

1. Client `GET /api/workspaces/{id}` — metadata + computed mode + storyline summary.
2. Client `GET /api/workspaces/{id}/storyline` — full storyline doc with ETag.
3. Client `GET /api/workspaces/{id}/pr` — proxy PR object.
4. Client `GET /api/workspaces/{id}/files` — proxy diff files.
5. Client `GET /api/workspaces/{id}/comments` — proxy comments.
6. Client `GET /api/workspaces/{id}/checks?ref={head_sha}` — proxy check runs.
7. Client `GET /api/workspaces/{id}/intro-comments?file_id=...` per file as needed.
8. Client `GET /api/workspaces/{id}/drafts` + `/draft-review` — the user's pending drafts.

UI composes the storyline view + github data + per-user drafts.

### 7.3 Post a line comment (single, immediate)

1. Client `POST /api/workspaces/{id}/drafts { kind: 'review', path, line, side, body }`.
   - Insert `DraftComment` row.
2. Client `POST /api/drafts/{draft_id}/publish`.
   - Backend re-reads `DraftComment` (must belong to current user).
   - Backend `POST /repos/{o}/{r}/pulls/{n}/comments` with payload via PyGithub.
   - On 2xx: delete the `DraftComment` row, return github response.
   - On 4xx/5xx: keep the row, propagate status to client.

### 7.4 Post a batch review

1. Client populates `DraftReview` (`PUT /api/workspaces/{id}/draft-review`) + N `DraftComment`s with `draft_review_fk` set.
2. Client `POST /api/workspaces/{id}/drafts/publish-all`.
3. Backend reads the user's `DraftReview` + linked `DraftComment`s.
4. Backend `POST /repos/{o}/{r}/pulls/{n}/reviews` with `body`, `event`, and `comments` array.
5. On 2xx: delete all draft rows, return github review object.
6. On 4xx/5xx: keep rows, surface error.

### 7.5 Edit storyline (author only)

1. Client `GET /api/workspaces/{id}/storyline` — reads `raw_json` + `etag`.
2. Client `PUT /api/workspaces/{id}/storyline` with `If-Match: <etag>` and new doc.
3. Backend:
   - Look up workspace + PR author from github (admin PAT).
   - Reject 403 if `current_user.github_login != pr.user.login`.
   - Reject 412 if no `If-Match` header.
   - Reject 409 if header etag != stored etag.
   - Inside DB transaction: update `Storyline.raw_json` + replace `StorylineFile` rows + bump `etag` (new uuid) + `updated_at`.
   - Return 200 + new `etag` (header + body).

### 7.6 Resolve an intro comment thread (PR author only)

1. Client `POST /api/intro-comments/{id}/resolve`.
2. Backend resolves: find storyline → workspace → PR author check.
3. If author: set `resolved_by_user_fk` + `resolved_at`. Return 200.
4. Else: 403.

### 7.7 Close / reopen / merge a PR

1. Client `POST /api/workspaces/{id}/actions/close`.
2. Backend `PATCH /repos/{o}/{r}/pulls/{n} { state: 'closed' }` via PyGithub (admin PAT).
3. Forward github response unchanged (status + body translated to our envelope).
4. If github rejects (e.g. branch-protection on merge), the 422 + reason propagates to client.

---

## 8 · Auth model

### 8.1 App identity — github OAuth-login

- Routes `/api/auth/login` and `/api/auth/callback` implement standard github OAuth.
- Required scope: `read:user` only (no `repo` scope — admin PAT does that).
- On callback: upsert `User` keyed by `github_user_id` (immutable) + `github_login` (may change but we update). Set session cookie.

### 8.2 GitHub API auth — single admin PAT (v1)

- One PAT in `settings.GITHUB_ADMIN_PAT` (env var). Encrypted at rest in production secrets manager.
- All `GithubGateway` calls use this PAT.
- **All github-side mutations (comments, reviews, merges, etc.) will be attributed to the PAT's owner on github**, regardless of which app user triggered them.
- This is acceptable only for internal / dev use. Production requires upgrading to per-user OAuth (see §11 tech debt).

### 8.3 Authorization rules (v1, intentionally permissive)

| Operation | Rule |
|---|---|
| Any read | Authenticated session. |
| `POST /api/workspaces` | Authenticated. |
| `POST /intro-comments` / `PATCH` own / `DELETE` own | Authenticated. |
| `POST /intro-comments/{id}/resolve` | `current_user.github_login == pr.author_login`. |
| `PUT /storyline` | `current_user.github_login == pr.author_login`. |
| `POST /ai-doc` / `DELETE /ai-doc` | `current_user.github_login == pr.author_login`. |
| Proxy reads | Authenticated. (Github will 404 if PAT lacks access — surface as-is.) |
| Proxy writes (close / reopen / merge / etc.) | Authenticated. (Github branch-protection will reject if not allowed — surface as-is.) |

The `UserRepoPermission` cache table is written when an OAuth login fetches the user's repo permission for any workspace they touch, but routes do not consult it in v1.

---

## 9 · Persistence + migrations

- Postgres in prod. SQLite file in dev (`dev.py` settings).
- Django ORM only. No engine-specific column types or functions.
- All migrations runnable on both engines.
- `Storyline.raw_json` and `AIAnalysisDoc.raw_content` use `TextField` (compatible with both engines). If structured queries are needed later, migrate to `JSONField` (Postgres `jsonb`; SQLite has JSON1 extension).
- UUID PKs not required — Django default integer PKs are fine. `Storyline.etag` is a Python UUID stored as a 36-char string.

---

## 10 · Testing approach (v1)

Three test layers, no special infra:

1. **Unit tests** — service-layer functions (storyline upsert, draft publish path, etag check). Use Django's test DB (SQLite in-memory).
2. **API tests** — Django `APIClient` tests per route, with the `GithubGateway` mocked (no real github calls in tests).
3. **Contract tests** for `GithubGateway` — small set of tests against a recorded fixture (e.g., `vcr.py` cassettes) of real github responses. Refresh cassettes intentionally; never in CI.

Out of scope for v1 testing: end-to-end with a real github account, load testing, fuzzing.

---

## 11 · Tech debt parked (explicitly accepted)

The following are *known* limitations introduced by deliberate v1 simplifications. Each has a rough upgrade path:

| Item | Why it's debt | Upgrade path |
|---|---|---|
| Admin PAT for all github calls | All actions appear authored by PAT owner; rate limit shared. | Per-user OAuth (github OAuth App or github App + on-behalf-of). Re-use existing OAuth-login flow, expand scopes, store encrypted `oauth_access_token` on `User`. |
| No realtime push | Storyline edits / new IntroComments / github changes invisible until refresh. | SSE endpoint per workspace; emit on backend-owned writes; later add github webhook ingress for github-side changes (smee.io for dev, public URL for prod). |
| No github read cache | Latency tax + rate-limit risk. | Per-route conditional ETag cache (60s TTL or smarter). Existing handlers wrap with a cache decorator; zero data-model change. |
| Permissive authz | UI must self-hide actions the user can't perform; backend won't pre-block beyond storyline-edit identity check. | Consult existing `UserRepoPermission` cache + route decorators for `read+` / `write+` / PR-author tiers. |
| No mirror = no offline mode | Backend useless without live github. | Mirror tables behind a feature flag (resurrect the design from `2026-05-23-foundational-decisions.md` D7). |

---

## 12 · Open questions (resolve during implementation)

- **Workspace creation by reviewer mode** — should an `import-pr` flow seed `StorylineFile` rows from current diff so reviewer sees the file list immediately even if author hasn't created a storyline yet? Or only show "storyline not defined" until author touches it? Default: don't auto-seed — show "no storyline yet" until author edits.
- **Storyline auto-rebase on diff changes** — when PR head changes (force-push, new commits), some `StorylineFile.diff_file_path` entries may no longer exist in the new diff. Default: keep the rows, surface "stale" badge in UI. Don't auto-delete (would lose intros).
- **AIAnalysisDoc schema** — defined in a separate spec (Claude Code skill spec). Backend should reject malformed docs with a clear error rather than store partial.
- **Pagination on proxy routes** — github paginates comments / files / checks. v1 may either (a) auto-follow `Link: next` and return the full list, or (b) forward pagination to client. Default: (b) — propagate `Link` headers, let client follow.
- **CSRF + cookie scope** — Django CSRF on all state-changing routes. SameSite=Lax on session cookie. Required for production-grade deploy.

---

## 13 · References

- **Decision log:** [`docs/decisions/2026-05-23-foundational-decisions.md`](../../decisions/2026-05-23-foundational-decisions.md) — 15 numbered decisions D1–D15 with rationale and rejected alternatives.
- **Brainstorm transcripts:** session HTML companion artifacts in `.superpowers/brainstorm/<session>/content/`.

---

## 14 · Disclaimer

This document captures design intent during a working session. Technical, security, and architectural decisions should be double-checked by a qualified subject-matter expert before being implemented in production-impacting code.
