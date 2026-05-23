# Stage — Data Model

Backend persistence layer for the POC. Postgres in production; SQLite in development. All migrations are engine-portable.

This is what the Stage backend stores. Everything else (PR data, file diffs, github comments, github reviews, branches, repositories) is **not** persisted — it is read on demand from github via the backend's proxy endpoints.

For full rationale on every decision below, see `docs/decisions/2026-05-23-foundational-decisions.md`.

---

## At a glance

Six tables.

```
   User
    ├──< Session                       (auth bearer tokens)
    └──< Workspace                     (one per body of changes; UUID id)
              │
              └──< Storyline           (1:1; author's review narrative)
                        │
                        └──< StorylineFile   (≥0; one row per file in the storyline)
                                  │
                                  └──< IntroComment   (≥0; threaded discussion, depth ≤ 1)
```

Notes on cardinality:
- `Workspace → Storyline` is 1:1 (storyline row created together with the workspace; may have zero `StorylineFile` rows while empty).
- `StorylineFile → IntroComment` is 1:N; comments are single-level threaded (`parent_fk` may reference a `parent_fk IS NULL` row only).

---

## Tables

### `User`

A person who has authenticated to Stage with their github identity.

| Field | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `github_login` | string, unique | github username (e.g. `octocat`) |
| `github_user_id` | bigint, unique | github numeric user id (stable across renames) |
| `display_name` | string, optional | from github `/user` `name` field |
| `avatar_url` | string, optional | |
| `created_at` | timestamp | first login |
| `last_login_at` | timestamp, optional | most recent successful `device/poll` exchange |

`github_user_id` is the unique-on-account-renames anchor; `github_login` is the human-readable label and may change.

---

### `Session`

A long-lived Bearer token issued to a Client after a successful github device-flow login.

| Field | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `user_fk` | FK `User` | |
| `token_hash` | string | SHA-256 of the opaque Bearer token; raw token never stored |
| `created_at` | timestamp | |
| `last_used_at` | timestamp | bumped on every successful auth |
| `revoked_at` | timestamp, optional | set by `/logout` |

The token itself is returned **once** at `device/poll` success and never re-rendered. The Client must store it (recommended: OS keychain, per `client/STACK.md`).

No refresh tokens in v1. Sessions are revoked by the user, never expire automatically.

---

### `Workspace`

A Stage-owned container for one body of changes under review. Identified by a backend-minted UUID. Survives the github PR's close/merge.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | `uuid4` |
| `repo_owner` | string | github org or user, e.g. `acme` |
| `repo_name` | string | github repo name, e.g. `payments` |
| `head_ref` | string | branch the workspace covers (mutable — see below) |
| `base_ref` | string | branch the PR will target (default: repo default branch) |
| `pr_number` | integer, optional | non-null once the workspace has been "published" |
| `pr_opened_at` | timestamp, optional | first time `pr_number` was set |
| `created_by_fk` | FK `User` | the **only** privileged-identity reference; sole gate for author-only actions |
| `created_at` | timestamp | |
| `last_active_at` | timestamp | touched on any write to the workspace or its children |

**`head_ref` mutability:**
- While `pr_number IS NULL` (local phase): user-supplied at creation, updateable via `PATCH /api/workspaces/{uuid}`.
- While `pr_number IS NOT NULL` (public phase): synced from `pr.head.ref` on each storyline read (github is the source of truth; the workspace silently follows branch renames).

**Uniqueness constraints:**
- `(repo_owner, repo_name, head_ref)` is UNIQUE.
- `(repo_owner, repo_name, pr_number)` is UNIQUE when `pr_number IS NOT NULL` (partial unique index).

**No `archived_at` field, no soft-delete.** Workspaces persist; their mutability is purely a function of github PR state (see `docs/adr/0004` and decisions D23 / D32).

---

### `Storyline`

The author's chosen narrative for how a reviewer should walk through the change. Exactly one per `Workspace`.

| Field | Type | Notes |
|---|---|---|
| `workspace_fk` | FK `Workspace`, PK | one-to-one; deletion cascades |
| `raw_json` | text | canonical JSON document (the authoritative payload) |
| `etag` | string (36) | UUID; bumped on every write; required `If-Match` for PUT |
| `updated_at` | timestamp | |
| `updated_by_fk` | FK `User` | last writer (always the workspace creator in v1) |

`StorylineFile` rows are a projection of `raw_json` maintained atomically inside the same DB transaction; reads can be served from either, writes touch both.

---

### `StorylineFile`

One step in the storyline. Anchors to exactly one file path in the github diff.

| Field | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `storyline_fk` | FK `Storyline` | |
| `diff_file_path` | string (1024) | path as it appears in github's PR-files response |
| `order_index` | integer | author-defined position in the storyline; 0-based |
| `title` | string, optional (255) | author-defined step title (distinct from filename) |
| `intro_text` | text, optional | the author's intent for this step (markdown) |

**Constraints:**
- `(storyline_fk, diff_file_path)` UNIQUE.
- `(storyline_fk, order_index)` not strictly unique; ordering is what storyline-PUT writes.

**v1 scope:** exactly one step per file. No hunk-level anchoring, no multi-file steps (see decision D21).

**Stale detection** is computed live on storyline read by comparing each `diff_file_path` against the current PR head's file list (see API `GET /storyline`). Not stored.

---

### `IntroComment`

Tool-native, threaded discussion attached to a `StorylineFile`. Never syncs to github.

| Field | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `storyline_file_fk` | FK `StorylineFile` | |
| `user_fk` | FK `User` | comment author |
| `parent_fk` | FK `IntroComment`, optional | null = root; if set, parent must have `parent_fk IS NULL` (depth ≤ 1) |
| `body` | text | markdown |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |
| `deleted_at` | timestamp, optional | soft-delete (preserves thread structure for siblings/replies) |
| `resolved_by_fk` | FK `User`, optional | root rows only; the workspace creator is the only writer |
| `resolved_at` | timestamp, optional | set together with `resolved_by_fk` |

**DB invariant:** `parent_fk IS NULL OR (resolved_by_fk IS NULL AND resolved_at IS NULL)`. Only root comments can be resolved.

---

## Computed state model

Workspace lifecycle states are **all computed**, never stored. The Client renders them by inspecting workspace fields + github PR state.

| State | Test |
|---|---|
| `self-review` | no workspace exists for `(repo, head_ref)` for the current user — the user is still iterating before deciding to share |
| `ready-to-share` | workspace exists; storyline has 0 files OR ≥1 file has empty `intro_text` |
| `ready-to-publish` | workspace exists; ≥1 file AND every `intro_text` non-empty; `pr_number IS NULL` or referenced PR is closed/merged |
| `published` | workspace exists; `pr_number` set; referenced PR is open |
| `closed` / `merged` | workspace exists; referenced PR is closed (without merge) or merged |

**Frozen** is the state where every write endpoint returns `409 workspace_frozen`. A workspace is frozen iff its referenced PR is closed or merged. Computed live from github on every write request (no cache in v1).

---

## Authorization model (v1, intentionally permissive)

The **only** stored privileged identity is `Workspace.created_by_fk`. Any rule expressed as "creator only" tests `current_user.id == workspace.created_by_fk`. Github's PR author identity is **not** consulted for backend authz; the invariant is that the github PR author equals the workspace creator (by construction, since only the creator can call Open-PR).

| Action | Pre-PR (local) | Open-PR (published) | Frozen (closed / merged) |
|---|---|---|---|
| Read workspace + storyline | creator only | any authenticated user | any authenticated user |
| Edit storyline | creator | creator | nobody |
| Post / reply IntroComment | n/a (not visible) | any authenticated user | nobody |
| Resolve IntroComment thread (root only) | n/a | creator | nobody |
| Post github comment (write-through) | n/a | any authenticated user | nobody |
| Submit github review (write-through) | n/a | any authenticated user | nobody |
| `POST /open-pr` | creator | n/a (PR already open) | creator (re-publish path) |
| `POST /reopen-pr` | n/a | n/a | creator |

"Any authenticated user" = logged in to Stage; no github-repo-permission check in v1. Tightening (e.g., restrict to repo collaborators) is roadmap.

---

## What is intentionally NOT in the model

- **No `Repository` / `Branch` / `Commit` entities** — github knows these. Repo and branch selection is client-side via local git (per `client/STACK.md`).
- **No `Comment` / `DraftComment` / `Review` / `DraftReview` tables** — review actions are write-through (POC); see `docs/adr/0004`. The Client holds pre-publish drafts in its own state.
- **No `AIAnalysisDoc`** — AI assistance is a client-side concern; its output flows into `StorylineFile.intro_text` via the normal storyline PUT.
- **No `UserRepoPermission`** — permissive authz in v1; not consulted.
- **No `archived_at` / soft-archive flag** — workspaces persist; mutability follows github PR state strictly.
- **No mirror of github primitives** (`PullRequest`, `Review`, `CheckRun`, etc.) — fetched on demand via proxy endpoints.
- **No file-viewed state** — UI ephemeral, owned by the Client.
- **No event log / outbox / webhook subscriptions** — no realtime sync in v1.

---

## Edge cases deferred

- Branch deleted and re-created with the same name: treated as opaque; per-file stale-step flagging surfaces the divergence to the author.
- Force-push that shifts head SHA dramatically: same — staleness surfaces per file.
- Merged PR + author wants to keep iterating: backend rejects writes (`409 workspace_frozen`). Path forward is `POST /reopen-pr` (if github allows) or `POST /open-pr` again on the workspace (overwrites `pr_number`).
- "Stale local workspace" cleanup (author abandoned but never archived): persists forever in v1; cleanup heuristics deferred.
