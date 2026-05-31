# Storyline Composition v1 — Design

**Status:** Draft for review
**Date:** 2026-05-30
**Branch:** `feat/create-storyline` (forked from `feat/create-workspace-wiring`; merges separately, after that branch)
**Author flow only.** Reviewer walkthrough is a later slice.

> Disclaimer: design intent derived from a repo scan. Wiring claims and library choices to be re-confirmed by a qualified reviewer at build time.

---

## 1. Summary

Let a Workspace author build the **Storyline** for their branch *before any PR exists*: see the branch's changed files (from local git), **curate** which ones become **steps**, **order** them, and write a **markdown intro** per step. Persist to the existing backend storyline endpoints.

The reviewer-facing walkthrough ("read the storyline step by step") is the motivation but **out of scope for v1** — it is a separate screen on the PR-anchored read path.

## 2. Current state (what already exists)

- **Backend storyline persistence is fully built** (`backend/apps/workspaces/`):
  - Models `Storyline` (1:1 Workspace) + `StorylineFile` (`diff_file_path`, `order_index`, `title`, `intro_text`) — `models.py:35-58`.
  - `workspace_create` already creates the empty `Storyline` row, and is wired client→backend end-to-end.
  - `GET /api/v1/workspaces/{id}/storyline/` → `{etag, head_sha, files:[{id, diff_file_path, order_index, title, intro_text, stale, stale_reason}]}`, `ETag` header, **creator-only pre-publish (404 to others)**.
  - `PUT /api/v1/workspaces/{id}/storyline/` with `If-Match: <etag>`, body `{files:[{diff_file_path, order_index, title?, intro_text?}]}`, full delete + `bulk_create`, mints new etag. Creator-only; `409 etag_mismatch`; `412` when `If-Match` missing; `409 workspace_frozen` when PR closed.
- **Pre-PR file listing is deliberately NOT on the backend** — the backend file list needs a PR. Pre-PR, discovering changed files is the **client's job via local git** (matches the topology + ADRs).
- **Client gap**: no storyline composition UI, no client SDK calls for storyline GET/PUT, no local-git "changed files" command. (`workspace_create` is the only workspace write wired client-side.)

**Net: v1 is client-only. Backend changes: zero.**

## 3. Scope

**In (v1):**
- Local-git changed-file discovery for a branch vs its base.
- Curate subset → order → markdown intro per step.
- Persist via existing storyline GET/PUT (etag-guarded).
- Entry from the post-"Ready to share" create flow and from a pre-PR workspace row.

**Out (deliberate, documented so the absence is intentional):**
- Reviewer walkthrough screen (next slice).
- Per-file **diff rendering** during composition (next slice — see §10).
- **Line-range references** (future dedicated feature — see §10).
- Drag-and-drop reordering (later; `@dnd-kit` pre-selected in `client/STACK.md`).
- AI "draft intro from diff".
- Per-step **title** editing (model field kept, left empty in v1).
- "Show un-curated files to reviewers at the end" — a reviewer-render decision, deferred with the reviewer screen.

## 4. Locked decisions

| # | Decision | Why |
|---|---|---|
| D1 | Unit is a **"step"** (not "chapter") | Already canonical in `CONTEXT.md` glossary, `docs/design.md`, the UI prototype; zero rename churn. |
| D2 | **Curate a subset** of changed files into steps | Author chooses what's worth a step; un-curated files are simply not steps (not persisted). |
| D3 | Intros are **markdown, rendered** | "Nice rendering" — lists, emphasis, etc. Lib `react-markdown` + `remark-gfm` (AST + custom renderers → forward-compatible with line-refs). |
| D4 | **Up/down** reorder in v1; drag-drop later | Basic but sufficient. |
| D5 | Branch off `feat/create-workspace-wiring`, merge separately | Need workspace creation to test end-to-end; keep that branch's work untouched. |

## 5. Design

### 5.1 Screen — `client/src/screens/storyline/Storyline.tsx`

Two zones; a third (per-file diff) slots into MAIN's lower region next slice with no rework.

```
┌ Storyline · feat/foo ──────────────────────────────────────┐
│  LEFT                        │  MAIN (selected step)        │
│  Changed files (pool)        │  services.py   M  +40 −2     │
│   M api/users.py +40 [+ add] │  ┌ intro (markdown) ──────┐  │
│   A models.py    +12 [+ add] │  │ - did X because…       │  │
│  ───────────────────         │  └────────────────────────┘  │
│  Storyline                   │  ┌ preview ───────────────┐  │
│  1 ▲▼ services.py  ● ×       │  │ • did X because…       │  │
│  2 ▲▼ apis.py      ○ ×       │  └────────────────────────┘  │
│  3 ▲▼ urls.py      ○ ×       │  (per-file diff → next slice)│
│  2/3 steps have intros  ·  [Save storyline]                 │
└──────────────────────────────────────────────────────────────┘
```

- **Pool** (LEFT top): changed files not yet steps. Each row: status chip (A/M/D), path, `+/−`, `[+ add]` → appends as a step.
- **Storyline** (LEFT bottom): ordered steps. Each row: order #, path, intro-status dot (● has intro / ○ empty), `▲▼` reorder, `×` remove (→ back to pool). Clicking a row selects it.
- **MAIN**: selected step's path header (+ status + `+/−`), a markdown **textarea** editor, and a **live rendered preview** beneath it.
- **Footer**: "N of M steps have intros" + **Save storyline**.

### 5.2 Data flow (all client-side, pre-PR)

```
open screen for workspace W:
  files   = git_diff_files(W.base_ref, W.head_ref)     ← NEW local-git command
  saved   = storyline_get(W.id)                         ← existing backend GET (etag captured)
  reconcile by path:
     included = saved.files whose path ∈ files  → keep order_index + intro_text
     pool     = files not present in saved.files
     orphan   = saved.files whose path ∉ files  → surfaced as "file no longer changed", author removes
edit … →
  storyline_update(W.id, etag, [{diff_file_path, order_index, intro_text} …])  ← existing backend PUT (If-Match)
  on success: adopt new etag. on 409 etag_mismatch: warn-only — keep the author's
  in-memory edits, surface the error (never auto-reload; that would clobber the
  edits that lost the race). Note: this conflict path is effectively unreachable
  in v1's single-author pre-publish flow (one writer, one client) — the machinery
  is kept as forward-compat for the post-publish multi-writer future.
```

- `base_ref`/`head_ref` come from the Workspace. `git2` diffs by ref name (merge-base, three-dot), no checkout needed — same resolution `git::diff_stats` already does.
- **Composition is against the committed local branch diff** (merge-base tree → head *commit* tree): uncommitted working-tree changes are deliberately invisible (reviewing those is the earlier Self-Review phase — by *Ready to share* the branch is committed, see `CONTEXT.md`). The local diff may also drift from the eventual PR diff (local base behind origin, head not yet pushed); that drift is reconciled post-publish by the backend's **stale** detection against the real PR head, never silently.
- Pre-PR the backend's stale flags are always false (needs a PR), so the **client reconciles** saved-vs-current locally.
- **Fail-loud (CLAUDE.md):** orphaned steps are *surfaced for the author to remove*, never silently dropped. A failed git/SDK call renders the error verbatim in a red banner; no partial/best-effort state.

### 5.3 Completeness

Mirrors `CONTEXT.md` *Ready to publish*: storyline has ≥1 step **and** every step has a non-empty intro. The footer counter reflects this; v1 does **not** block saving an incomplete (draft) storyline.

## 6. Components to build — client only

1. **Rust / local git** — `git_diff_files(base_ref, head_ref) -> Vec<ChangedFile{ path, status, added, removed }>`
   - `client/src-tauri/src/git.rs`: reuse `diff_stats`' ref-resolution + `diff_tree_to_tree` (`git.rs:120`), iterate `diff.deltas()` (status + `+/−` per file) instead of `.stats()`. Serde-rename to camelCase (pattern: `BranchInfo`). Fail-loud on error (name the path).
   - `commands.rs`: `#[tauri::command] git_diff_files(state, base_ref, head_ref)` (copy active-repo-lock boilerplate from `git_diff_stats`).
   - `lib.rs`: register in `generate_handler![]`.
2. **Rust SDK + commands** — `storyline_get`, `storyline_update`
   - `client/src-tauri/src/api/workspaces.rs`: two `impl Client` methods (`GET`/`PUT` `api/v1/workspaces/{id}/storyline/`, bearer, JSON, `map_error`). `storyline_update` sends `If-Match` and reads back the `ETag`.
   - `commands.rs`: two `#[tauri::command]` async fns (`require_token()` → `state.api…`). Register in `lib.rs`.
   - Types in `client/src-tauri/src/api/types.rs`: `StorylineDto { etag, head_sha, files: Vec<StorylineFileDto> }`, `StorylineFileDto { id, diff_file_path, order_index, title, intro_text, stale, stale_reason }`.
3. **tauri.ts wrappers** — `gitDiffFiles`, `storylineGet`, `storylineUpdate` (+ TS types) mirroring existing `invoke<T>('snake_case', {camelArgs})`.
4. **Webview screen** — `client/src/screens/storyline/Storyline.tsx`; add a `'storyline'` variant + render branch to the `App.tsx` view switch (`App.tsx:8`); thread a navigation callback.
5. **Entry points** — after "Ready to share" create (currently `NewWorkspaceModal` in `Workspaces.tsx:1371`) navigate to the storyline screen for the new workspace; also clicking a Draft / Ready-to-publish workspace row opens it.
6. **New webview dep** — `react-markdown` + `remark-gfm`. Confirm current API via Context7 before coding. Safe-by-default (no raw HTML).

## 7. Backend

**No change.** GET/PUT storyline, etag, creator-only pre-publish authz already match this flow. (Pre-existing doc/house-style gaps noted by the scan — e.g. `etag_mismatch` raised as `message` instead of `extra.code`, missing `intro_comment_count` on the GET payload — are **not** touched by v1; migrate opportunistically only if a file is edited for another reason.)

### 7.1 HARD GATE — `storyline_replace` is destructive (full delete + recreate)

`storyline_replace` (`backend/apps/workspaces/services.py`) does `StorylineFile.objects.filter(storyline=s).delete()` then `bulk_create(...)` — **every save deletes every step row and recreates it with a fresh UUID**. Because `IntroComment.storyline_file` is `on_delete=CASCADE` (`models.py:62-63`), any storyline save **cascade-deletes all IntroComments on all steps** — not just the edited step. This contradicts `CONTEXT.md`, which frames **IntroComment** as a durable backend-native entity (github has no equivalent surface).

**Not reachable in v1**: this composition screen only opens for **pre-publish** workspaces (Ready-to-share bucket + post-create), where no IntroComments exist (storyline is creator-private pre-publish). So v1 is safe to ship.

**Gate**: before *any* slice exposes storyline editing for a **published** workspace (a designed flow — `CONTEXT.md`: "the workspace is reusable across publish cycles"), `storyline_replace` **must** change from delete-all + recreate to **upsert by `(storyline, diff_file_path)`** (the existing unique key, `models.py:56`): update existing rows in place (preserving `id` + their IntroComments), insert new ones, delete only the rows whose path was removed. This preserves StorylineFile identity and IntroComment durability. Until that lands, post-publish storyline editing is forbidden. **Tracked: [#20](https://github.com/Bise-Dev/stage/issues/20).** (ADR to be written when the upsert is designed — full-replace simplicity vs identity/discussion preservation is a real trade-off.)

**Related breadcrumb (per-step `title`):** v1's write path drops `title` — `StorylineFileWrite` omits it, `Client::storyline_update` maps only `diff_file_path`/`order_index`/`intro_text`, and the full-replace defaults `title=""`. Harmless now (title is unused in v1, spec §3), but when per-step titles become editable the write struct, the SDK body builder, **and** the upsert above must all thread `title`, or it stays silently wiped.

## 8. Error handling (fail-loud)

- Local git failure (`git_diff_files`) → Rust returns `AppError`; screen renders `e.message` in a red banner; no empty-list fallback.
- SDK failure (`storyline_get/update`) → backend `{message, extra}` surfaced verbatim; `409 etag_mismatch` → warn-only, keep edits, do not auto-reload or overwrite. (Known wart: the backend raises `etag_mismatch`/`workspace_frozen` as a bare code in `message` — §7 — so this banner can show a raw token until that base-branch gap is fixed. Both 409 paths are unreachable in the v1 pre-publish flow regardless.)
- Orphaned steps (saved path no longer in the diff) → surfaced as a removable "stale" row, never auto-dropped.

## 9. Testing

- **Rust**: unit test `git::diff_files` against a temp repo (added/modified/deleted files, base vs head). SDK methods via `wiremock` (pattern: `api/workspaces.rs` tests) — GET shape, PUT `If-Match` header, etag round-trip, error mapping.
- **Webview**: reconciliation logic (included/pool/orphan partition) as a pure function with unit tests; component smoke if a harness exists.
- `just pre-commit` (biome + tsc + cargo fmt/check) green; `just client::test` / `clippy` for the Rust additions.

## 10. Future-proofing (kept in mind, NOT built)

- **Per-file diff view (next slice):** add `git_file_diff(base, head, path)` reusing the same `git2 Diff`; render hunks in MAIN's lower region. Layout already reserves the space.
- **Line-range references (future):** a step references exact lines; hovering highlights them in the diff.
  - Steps are already **file-anchored** (`diff_file_path`) → line-refs are sub-file, purely **additive** (a future `line_anchors` field or a small annotations sub-entity on `StorylineFile`); clean migration, no model conflict.
  - `react-markdown`'s **AST + custom renderers** lets us add an inline ref token whose hover highlights diff lines — without swapping the renderer. (This is why D3 picks it over `marked`→HTML.)

## 11. Risks / open items

- **Spec location**: written to `docs/superpowers/specs/` (skill default). Move under the repo's `docs/` tree if preferred.
- **`base_ref` correctness**: assumes the Workspace's `base_ref`/`head_ref` resolve locally (branch exists in the local repo). If `head_ref` isn't fetched locally, `git_diff_files` fails loud — acceptable for v1 (author is on their own branch).
- **Markdown lib version**: confirm `react-markdown`/`remark-gfm` current API + any sanitization guidance via Context7 at build.
