# Local-Review Backend v1 — Design Spec (v2, after UI inspection)

**Date:** 2026-05-23
**Author:** ybouzonie
**Status:** Approved (supersedes v1 spec)
**Supersedes:** [`2026-05-23-local-review-backend-design.md`](2026-05-23-local-review-backend-design.md) — kept for history.
**Decisions log:** [`docs/decisions/2026-05-23-foundational-decisions.md`](../../decisions/2026-05-23-foundational-decisions.md) — D1–D16.

This document is the **canonical implementation reference**. The v1 spec is preserved as a working artifact.

---

## 1 · Problem statement

GitHub's native pull-request review surface is linear and lacks a way for the author to express **a storyline** — the order files should be reviewed in and the *intent* behind each file's changes.

We are building a **deployable Django backend** that augments the github review experience with:

1. **Author-defined storyline** — ordered steps, each anchored to a diff file, with an optional **step title** + an **intro** (the author's intent for that step).
2. **Threaded discussion on intros** (`IntroComment`) — reviewers can question or react to an intro without going through github.
3. **Optional AI analysis ingestion** — author may feed a structured analysis doc that reviewers see alongside the storyline (per-file sections + a top-level summary).
4. **Pre-publish drafts** — comments composed in the UI before pushing to github, with a category (`comment | blocking | suggestion | nit`).
5. **GitHub passthrough** for everything else (PR data, branches, comments, reviews, checks, lifecycle actions). **Github remains the source of truth for all github-domain data; the backend never mirrors it.**

The UI consumes this backend. Repository / branch / file-viewed state lives **outside** the backend (UI localStorage or github API). The backend's job is to persist what is **tool-native** (storyline + intros + AI-doc + pre-publish drafts) and proxy everything else.

---

## 2 · Goals · Non-goals

### Goals (v1)

- **Workspace** = PR-scoped (1 row per github PR). Two creation entry points:
  - **Author mode:** `POST /api/repos/{owner}/{repo}/open-pr` — creates github PR AND backend workspace + storyline atomically. Used when the UI's "Open PR…" CTA fires from the local-review screen.
  - **Reviewer / import mode:** `POST /api/workspaces/import` — creates a workspace from an existing github PR (no storyline seeded by author; the PR author can add one later).
- Author edits storyline (step ordering, per-step title, per-step intro). Storyline write uses ETag concurrency.
- Threaded `IntroComment`s on storyline steps. Author can resolve threads.
- Author ingests AI analysis doc (markdown with `## Summary` + `## File: <path>` sections). Backend parses + stores summary + per-file sections.
- Per-user pre-publish drafts (`DraftReview` + `DraftComment`). `DraftComment.category` ∈ {`comment | blocking | suggestion | nit`}.
- Publish single draft or batch. Batch publish accepts `post_to_github` flag (v1: false ⇒ drafts deleted, no record kept).
- Github proxy: PR · files · file content · comments · reviews · threads · check runs · workflow runs · **branch listing** · **compare (diff stats)** · **external PRs without workspace**.
- Github lifecycle proxy: close · reopen · toggle-draft · merge · edit/delete published comments · react · resolve/unresolve thread.
- Workspaces list endpoint enriches each row with derived counts + a github-derived snapshot + computed state.

### Non-goals (v1)

- No mirror of any github-domain entity. No `Comment` / `Review` / `CheckRun` / etc. rows.
- No `Repository` / `Branch` / `Commit` entities. Github API answers those.
- No local git clones, no `git fetch`, no `git diff` shelling out.
- No persistence of pre-PR / local-review state in the backend. Storyline composition happens client-side; only "Open PR" persists it.
- No "file viewed" state. UI localStorage handles it.
- No event-driven sync, no webhooks, no `Outbox`, no `SyncEvent`, no reconciliation, no background worker, no SSE in v1.
- No github read cache in v1.
- No private per-user annotations (dropped in D15).
- No `LocalReview` entity (the `post_to_github=false` toggle just discards drafts in v1).
- No per-user github tokens (single admin PAT — see §8 and §11 tech debt).
- No fine-grained authz beyond "storyline edit = PR author" identity check.

---

## 3 · Glossary

| Term | Meaning |
|---|---|
| **Workspace** | Backend's container for one github PR. Identity = `(repo_owner, repo_name, pr_number)`. |
| **Local review** | UI-only phase. Author visualizes the diff (from github API) and composes a storyline in client state. **Nothing is persisted in the backend** during this phase. |
| **Open PR** | The act of converting an in-progress local review into a github PR + backend workspace + persisted storyline, in one atomic call. |
| **Storyline** | Ordered list of steps, each anchored to a file in the PR's diff, plus optional per-step title + intro. |
| **StorylineFile** | One step entry (path + order + title + intro). |
| **IntroComment** | Threaded discussion on a storyline step's intro. Tool-native; never syncs to github. |
| **DraftComment** | A comment the user has composed but not yet pushed to github. Backend-only; deleted on publish. Has a `category` (comment / blocking / suggestion / nit). |
| **DraftReview** | Wrapper for a batch of `DraftComment`s plus the optional top-level review body + event (`COMMENT` / `APPROVE` / `REQUEST_CHANGES`). One per `(workspace, user)`. |
| **AIAnalysisDoc** | Author-ingested structured analysis document. Parsed into `summary` + per-file sections. |
| **Admin PAT** | The single github Personal Access Token configured in backend env; used for *all* github API calls in v1. |
| **Computed state** | Workspace state derived from github data + current user. Values: `in-review | reviewing | requested | approved`. See §13. |
| **External PR** | A github PR that has no backend workspace yet. Listed for "Authored by you / Open PRs" + "Awaiting your review / Open PRs" buckets. |

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
       ║     ORCHESTRATION (DB + github):                                         ║
       ║       /api/repos/{o}/{r}/open-pr      (open PR + create workspace +     ║
       ║                                        persist storyline atomically)    ║
       ║       /api/workspaces/import          (workspace from existing github PR)║
       ║                                                                        ║
       ║     PROXY (passthrough to github via admin PAT):                         ║
       ║       /api/repos/{o}/{r}/branches                                       ║
       ║       /api/repos/{o}/{r}/compare/{base}...{head}                        ║
       ║       /api/external-prs?role=author|reviewer                            ║
       ║       /api/workspaces/{id}/pr                                           ║
       ║       /api/workspaces/{id}/files                                        ║
       ║       /api/workspaces/{id}/files/content                                ║
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

> **The DB stores only data that does not exist on github AND is not ephemeral UI state.**

Backend-owned (forever): identity, workspace (PR pointer), storyline, intros, AI-doc.
Backend-owned (transient): pre-publish drafts.
Github-owned: PR, files, comments, reviews, threads, checks, workflows, branches, repos.
UI-owned (localStorage): file viewed state, in-progress local-review storyline before "Open PR".

---

## 5 · Data model

10 tables. Postgres + SQLite compatible.

### 5.1 Identity (unchanged from v1)

```
User
  id              PK
  github_login    str UNIQUE
  github_user_id  int UNIQUE
  display_name    str?
  avatar_url      str?
  created_at      timestamp
  last_login_at   timestamp?

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

### 5.2 Workspace (unchanged from v1)

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

`mode` is computed per request: `author` if `current_user.github_login == pr.user.login`, else `reviewer`.

### 5.3 Storyline (UPDATED — added `title`)

```
Storyline
  workspace_fk        PK + FK Workspace
  raw_json            text                  # canonical document
  etag                uuid                  # bumped on every write
  updated_at          timestamp
  updated_by_user_fk  FK User

StorylineFile
  id                  PK
  storyline_fk        FK Storyline
  diff_file_path      str
  order_index         int
  title               str?                  # NEW: author-defined step title (distinct from filename)
  intro_text          text?
  UNIQUE (storyline_fk, diff_file_path)
```

`raw_json` is the canonical document; `StorylineFile` rows are a flat projection updated atomically with `raw_json` in a single DB transaction.

**Partial storyline is allowed.** Files in the PR diff but absent from `StorylineFile` are rendered by the UI in alphabetical order **after** the ordered steps. The backend does not enforce that all diff files appear in the storyline.

### 5.4 IntroComment (unchanged from v1)

```
IntroComment
  id                      PK
  storyline_file_fk       FK StorylineFile
  user_fk                 FK User
  parent_fk               FK IntroComment?
  body                    text
  created_at              timestamp
  updated_at              timestamp
  deleted_at              timestamp?
  resolved_by_user_fk     FK User?
  resolved_at             timestamp?
```

### 5.5 AI analysis (UPDATED — added `summary`)

```
AIAnalysisDoc
  id                    PK
  workspace_fk          FK Workspace UNIQUE
  raw_content           text
  summary               text                # NEW: top-level summary parsed from "## Summary" section
  ingested_at           timestamp
  ingested_by_user_fk   FK User
  source_label          str?

AIAnalysisFile
  id                  PK
  ai_doc_fk           FK AIAnalysisDoc
  diff_file_path      str
  sections_json       json
  UNIQUE (ai_doc_fk, diff_file_path)
```

### 5.6 Drafts (UPDATED — added `category`)

```
DraftReview
  id                  PK
  workspace_fk        FK Workspace
  user_fk             FK User
  body                text?
  event               enum  COMMENT | APPROVE | REQUEST_CHANGES
  created_at          timestamp
  updated_at          timestamp
  UNIQUE (workspace_fk, user_fk)

DraftComment
  id                          PK
  workspace_fk                FK Workspace
  user_fk                     FK User
  draft_review_fk             FK DraftReview?
  kind                        enum  issue | review
  category                    enum  comment | blocking | suggestion | nit   # NEW
  diff_file_path              str?
  position                    int?
  line                        int?
  side                        enum  LEFT | RIGHT?
  body                        text
  parent_comment_github_id    str?
  created_at                  timestamp
  updated_at                  timestamp
```

`category` is a tool-native UI-only signal. It is **not** sent to github when publishing (github comments have no category). UI uses it for grouping and visual treatment in the publish review summary.

---

## 6 · API surface

All routes require an authenticated session. JSON in/out. Errors use HTTP status + `{ "error": { "code", "message" } }` body.

### 6.1 Native routes (DB-backed)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/workspaces` | List workspaces for current user, **enriched** (counts + computed state + reviewers + check summary). See §6.4 enrichment. |
| GET | `/api/workspaces/{id}` | Workspace metadata + computed mode + storyline summary. |
| DELETE | `/api/workspaces/{id}` | Archive (soft). |
| POST | `/api/workspaces/import` | Body: `{repo_owner, repo_name, pr_number}`. Creates workspace from an existing github PR. No storyline seeded (author may add later). |
| GET | `/api/workspaces/{id}/storyline` | Returns `{raw_json, files: [...], etag}` + `ETag` header. |
| PUT | `/api/workspaces/{id}/storyline` | **Author-only.** Body: `{files: [...]}`. Requires `If-Match: <etag>`. Returns 200 + new `etag`. 412 / 409 on missing / stale `If-Match`. |
| GET | `/api/workspaces/{id}/storyline/as-markdown` | Renders the storyline (steps with titles + intros) as a markdown block suitable for the PR body composer's "From storyline" button. |
| GET | `/api/workspaces/{id}/intro-comments?file_id={sf_id}` | Lists intro comments for a storyline file. |
| POST | `/api/workspaces/{id}/intro-comments` | `{storyline_file_id, parent_id?, body}`. |
| PATCH | `/api/intro-comments/{id}` | Owner only. `{body}`. |
| DELETE | `/api/intro-comments/{id}` | Owner only. Soft-delete. |
| POST | `/api/intro-comments/{id}/resolve` | **PR-author only.** |
| POST | `/api/intro-comments/{id}/unresolve` | PR-author only. |
| GET | `/api/workspaces/{id}/ai-doc` | Returns `{raw_content, summary, files: [...], source_label?, ingested_at}` or 404. |
| POST | `/api/workspaces/{id}/ai-doc` | **PR-author only.** `{raw_content, source_label?}`. Replaces any prior doc. |
| DELETE | `/api/workspaces/{id}/ai-doc` | PR-author only. |
| GET | `/api/workspaces/{id}/drafts` | Current user's drafts in this workspace. |
| POST | `/api/workspaces/{id}/drafts` | `{kind, category?, diff_file_path?, position?, line?, side?, body, parent_comment_github_id?, attach_to_review_draft?: bool}`. |
| PATCH | `/api/drafts/{id}` | Owner only. Any draft field can be edited; `category` included. |
| DELETE | `/api/drafts/{id}` | Owner only. |
| GET | `/api/workspaces/{id}/draft-review` | Current user's `DraftReview` or 404. |
| PUT | `/api/workspaces/{id}/draft-review` | Upsert. `{body?, event}`. |
| POST | `/api/drafts/{id}/publish` | Push single comment to github, delete row, return github response. |
| POST | `/api/workspaces/{id}/drafts/publish-all` | Body: `{post_to_github?: bool}` (default `true`). If `true`: create a github review with all drafts; delete drafts on success. If `false`: just delete all drafts (v1; no record persisted). |

### 6.2 Orchestration routes (DB + github)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/repos/{owner}/{repo}/open-pr` | Body: `{base, head, title, body, reviewers: [], labels: [], draft: bool, storyline: {files: [{diff_file_path, order_index, title?, intro_text?}, ...]}}`. **Atomic:** (1) call github to create PR; (2) call github to request reviewers + apply labels (best-effort: PR is created even if reviewer/label add fails — those are returned as warnings in the response); (3) insert `Workspace` + `Storyline` + `StorylineFile` rows. Returns 201 + workspace metadata. |

### 6.3 Proxy routes (passthrough)

| Method | Path | What it calls |
|---|---|---|
| GET | `/api/repos/{owner}/{repo}/branches` | `GET /repos/{o}/{r}/branches` + per-branch enrichment: compare vs default branch for ahead/behind/added/removed + last commit author. **Pagination forwarded.** |
| GET | `/api/repos/{owner}/{repo}/compare/{base}...{head}` | `GET /repos/{o}/{r}/compare/{base}...{head}` — diff stats + file list between two refs. |
| GET | `/api/external-prs?role=author\|reviewer` | Github search via `GET /search/issues?q=is:pr+author:{user}+...` (for `role=author`) or `q=is:pr+review-requested:{user}+...` (for `role=reviewer`); filter out PRs that already have a backend workspace. |
| GET | `/api/workspaces/{id}/pr` | `GET /repos/{o}/{r}/pulls/{n}` |
| GET | `/api/workspaces/{id}/files` | `GET /repos/{o}/{r}/pulls/{n}/files` |
| GET | `/api/workspaces/{id}/files/content?path=&ref=` | `GET /repos/{o}/{r}/contents/{path}?ref={ref}` |
| GET | `/api/workspaces/{id}/comments` | combined: issue + review comments |
| GET | `/api/workspaces/{id}/reviews` | `GET .../pulls/{n}/reviews` |
| GET | `/api/workspaces/{id}/threads` | GraphQL: PR review threads with `isResolved` |
| GET | `/api/workspaces/{id}/checks?ref={sha}` | `GET .../commits/{sha}/check-runs` |
| GET | `/api/workspaces/{id}/workflow-runs?head_sha={sha}` | `GET .../actions/runs?head_sha={sha}` |
| PATCH | `/api/workspaces/{id}/comments/{gid}` | edit a published comment (kind via query/body param) |
| DELETE | `/api/workspaces/{id}/comments/{gid}` | delete a published comment |
| POST | `/api/workspaces/{id}/comments/{gid}/reactions` | react to a comment |
| POST | `/api/workspaces/{id}/threads/{gid}/resolve` | GraphQL `resolveReviewThread` |
| POST | `/api/workspaces/{id}/threads/{gid}/unresolve` | GraphQL `unresolveReviewThread` |
| POST | `/api/workspaces/{id}/actions/close` | `PATCH .../pulls/{n} {state: closed}` |
| POST | `/api/workspaces/{id}/actions/reopen` | `PATCH .../pulls/{n} {state: open}` |
| POST | `/api/workspaces/{id}/actions/toggle-draft` | `PATCH .../pulls/{n} {draft: <flipped>}` |
| POST | `/api/workspaces/{id}/actions/merge` | `PUT .../pulls/{n}/merge {method}` |

### 6.4 Workspace list enrichment

`GET /api/workspaces` returns each workspace with an enriched envelope:

```json
{
  "id": 42,
  "repo_owner": "acme",
  "repo_name": "payments",
  "pr_number": 482,
  "created_at": "...",
  "last_active_at": "...",
  "archived_at": null,
  "mode": "author",
  "counts": {
    "storyline_files": 7,
    "intro_comments_total": 3,
    "intro_comments_unresolved": 2,
    "drafts_mine": 4
  },
  "pr_snapshot": {
    "title": "Replace legacy checkout...",
    "state": "open",
    "draft": false,
    "head_sha": "deadbeef...",
    "base_ref": "main",
    "head_ref": "feat/checkout-v2",
    "additions": 412,
    "deletions": 87,
    "changed_files": 11,
    "author_login": "alice",
    "reviewers": [{"login": "mira", "state": "REQUESTED"}, ...],
    "checks": {"pass": 8, "fail": 0, "pending": 1, "total": 9}
  },
  "computed_state": "in-review"
}
```

Implementation note: the enrichment endpoint **must batch** github calls per page of workspaces (e.g., one `GET /search/issues?q=is:pr+repo:o/r+pr:N1,N2,N3` request, then targeted check-run fetches per head_sha). N+1 patterns are forbidden.

### 6.5 Auth routes (unchanged from v1)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/login` | Redirects to github OAuth. |
| GET | `/api/auth/callback` | OAuth callback. Creates / updates `User`. |
| POST | `/api/auth/logout` | Clears session. |
| GET | `/api/auth/me` | Returns the current `User` or 401. |

---

## 7 · Request flows

### 7.1 Open PR (author's primary entry point)

UI's "Open PR" CTA on the local-review screen sends a single request with the in-progress storyline plus PR metadata.

1. Client `POST /api/repos/{owner}/{repo}/open-pr` with `{base, head, title, body, reviewers, labels, draft, storyline}`.
2. Backend validates payload (e.g., storyline file paths exist in the head vs base diff — best-effort warn, not block).
3. Backend calls github `POST /repos/{o}/{r}/pulls` with `{base, head, title, body, draft}`. Captures `pr_number`.
4. Backend calls github `POST .../pulls/{n}/requested_reviewers` with `{reviewers}` and `POST .../issues/{n}/labels` with `{labels}`. Failures here are recorded as warnings; do **not** roll back the PR.
5. Backend (single DB transaction):
   - Insert `Workspace`.
   - Insert `Storyline` with new `etag`.
   - Insert `StorylineFile` rows from `storyline.files`.
6. Respond 201 with workspace metadata + `warnings: [...]`.

If step 3 fails (PR creation rejected by github): nothing persisted; return github status + message.

### 7.2 Import PR (reviewer / re-attach to existing PR)

1. Client `POST /api/workspaces/import { repo_owner, repo_name, pr_number }`.
2. Backend verifies the PR exists (admin PAT `GET /repos/.../pulls/{n}`).
3. Backend inserts `Workspace`. No storyline seeded.
4. Returns 201.

### 7.3 Load workspace for reviewing (unchanged from v1)

Sequence of GETs against the workspace's native + proxy routes. UI composes the storyline view + github data + per-user drafts.

### 7.4 Compose and publish drafts (UPDATED for `category` + `post_to_github`)

- `POST /api/workspaces/{id}/drafts` accepts `category`. v1 default `comment`.
- `POST /api/workspaces/{id}/drafts/publish-all` body: `{post_to_github?: bool}` (default `true`).
  - `true`: backend creates github review with `body, event, comments[]`. **`category` is NOT sent to github.** On success, delete all draft rows.
  - `false` (v1): just delete all draft rows; respond `{discarded: true}` with no persistence.

### 7.5 Edit storyline (unchanged from v1 — ETag flow)

### 7.6 Resolve intro thread (unchanged from v1)

### 7.7 PR-lifecycle actions (unchanged from v1)

---

## 8 · Auth model (unchanged from v1)

OAuth-login for app identity (`read:user` scope). Admin PAT for all github API calls. Permissive authz in v1 except `storyline edit`, `ai-doc ingest`, `intro-comment resolve` — all gated by `current_user.github_login == workspace.pr.author_login`.

---

## 9 · Persistence + migrations (unchanged)

Postgres prod, SQLite dev. No engine-specific features.

---

## 10 · Testing approach (unchanged)

Unit + API (mocked gateway) + contract (recorded fixtures).

---

## 11 · Tech debt parked

| Item | Why it's debt | Upgrade path |
|---|---|---|
| Admin PAT for all github calls | Actions appear as PAT owner; rate limit shared | Per-user OAuth (App or OAuth App) |
| No realtime push | Storyline / intro comment changes invisible until UI refresh | SSE per workspace |
| No github read cache | Latency + rate-limit risk on enriched list + per-render proxy calls | Conditional ETag cache decorator on proxy routes |
| Permissive authz | UI must hide ops the user can't do | Consult `UserRepoPermission` in route decorators |
| `post_to_github=false` discards drafts silently | UI value lost on Cancel; no audit trail | Add `LocalReview` entity to record local-submitted reviews |
| External PR list filters in Python | If user has 1000s of PRs, slow | Cache `Workspace.pr_number` index per repo |

---

## 12 · Open questions (resolve during implementation)

- **Storyline path drift:** If PR head changes (force-push) and a storyline-referenced file path no longer exists, UI should flag stale. Backend's role: serve storyline as-is; do not auto-delete entries. (Same as v1 spec.)
- **AI-doc parser tolerance:** Doc without `## Summary` or with no `## File:` headers → reject 400, or ingest with empty summary / no files? Default: ingest with `summary=""` and zero `AIAnalysisFile` rows.
- **`open-pr` reviewer/label failures:** include a `warnings: []` array in the 201 response with structured codes (`reviewer_failed`, `label_failed`). UI surfaces them as toasts.
- **Pagination on proxy routes:** `branches`, `external-prs`, `comments`, etc. — forward github's `Link: next` header to the client. Client follows.

---

## 13 · Computed workspace state

For the enriched workspace list, backend computes a single `computed_state` string from the PR snapshot + current-user role:

```
def compute_state(pr, user_login, reviewers):
    if pr.state == "closed" and pr.merged: return "merged"
    if pr.state == "closed":               return "closed"
    if pr.draft:                            return "draft"          # public-phase draft on github
    # public review:
    has_changes_requested_review = any(r.state == "CHANGES_REQUESTED" for r in reviews_latest_per_user)
    if has_changes_requested_review: return "requested"
    has_approval = any(r.state == "APPROVED" for r in reviews_latest_per_user)
    if has_approval and not has_changes_requested_review: return "approved"
    # user_login is a reviewer who hasn't acted yet
    user_is_pending_reviewer = any(r.login == user_login and r.state == "REQUESTED" for r in reviewers)
    if user_is_pending_reviewer: return "reviewing"
    return "in-review"
```

(In `apps/workspaces/computed_state.py`; pure function; tested against fixture inputs.)

---

## 14 · References

- **Decision log:** `docs/decisions/2026-05-23-foundational-decisions.md` (D1–D16).
- **UI mockup:** `~/Desktop/Stage v2 _standalone_.html` (bundled React app — design canvas + 5 screens).
- **Prior spec (superseded):** `2026-05-23-local-review-backend-design.md`.

---

## 15 · Disclaimer

This document captures design intent during a working session. Technical, security, and architectural decisions should be double-checked by a qualified subject-matter expert before being implemented in production-impacting code.
