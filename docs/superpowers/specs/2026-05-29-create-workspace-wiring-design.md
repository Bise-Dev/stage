# Create-Workspace Wiring — Design

**Date:** 2026-05-29
**Status:** Approved (brainstorming → ready for implementation plan)
**Scope:** One vertical slice — make the "New workspace" gesture actually create a `Workspace` and show it in the overview. UI → Tauri command → Rust SDK → backend → list refresh.

## Problem

Clicking **New workspace** does nothing. `Workspaces.tsx:438` onClick is `() => console.info('workspaces_new_stub', 'toolbar')`. The Django backend already exposes the full create flow; the client has no path to call it.

- **Backend create flow exists** (no new logic): `POST /api/v1/workspaces/` → `WorkspaceListApi.post` (`backend/apps/workspaces/apis.py:51`) → `workspace_create(...)` (`backend/apps/workspaces/services.py:84`). Pure DB insert: creates a `Workspace` row + an empty `Storyline`. No GitHub call at create time. Inputs: `repo_owner, repo_name, head_ref, base_ref` (default `"main"`), optional `title`. Raises `ApplicationError(status=409)` if `(repo_owner, repo_name, head_ref)` already has a workspace (`uniq_workspace_repo_head`). Returns the full workspace shape via `WorkspaceOutputSerializer`.
- **Domain meaning** (CONTEXT.md, ADR-0002): a Workspace is the author's **"Ready to share"** gesture on a branch they've been self-reviewing — created eagerly, just a DB record. `Publish` (separate, later) opens the PR. There is no "import PR" path; reviewers never create.
- **Client gap** (verified): no `workspace_create` in `tauri.ts`, no command in `commands.rs`, no Rust SDK method. The button is a no-op stub.

## The catch — overview cache coherence

`RepoOverviewApi` caches the overview per `(user, repo)` for 30s (`backend/apps/workspaces/apis.py:64-73`, key `f"overview:{request.user.pk}:{owner}/{repo}"`, `cache.set(..., timeout=30)`). Without invalidation, creating a workspace and reloading the overview returns the **stale cached list within the 30s window — the new workspace is missing** and the feature visibly appears to do nothing. Cache invalidation on create is therefore part of this slice, not optional.

## Decisions

- **Entry points: both.** Toolbar **New workspace** button (pick any eligible branch) *and* a per-branch **Ready to share** button on Self-Review rows (branch prefilled). Both open the same modal and call the same flow.
- **After create: minimal.** Close modal, re-run the overview load, new workspace appears in the **Ready to share** bucket. No workspace-detail / storyline-composition screen is built in this slice. (Storyline composition is the documented next direction — keep the wiring forward-compatible toward it, but out of scope here.)
- **A1 — backend invalidates the overview cache** on create (chosen over client-side optimistic row synthesis, which would duplicate the backend's computed row shape and risk drift).
- **B1 — Rust SDK returns raw `serde_json::Value`** (mirrors `api/overview.rs` and the thin-proxy convention). The webview ignores the body and re-runs `loadOverview`.

## Assumptions

- **No GitHub branch pre-check at create.** Create is DB-only; matches backend trust-the-client (`design.md §4`). A branch not yet pushed to GitHub is allowed; the precondition surfaces later at Publish as a GitHub 422.
- **`title` is a real captured field.** `Workspace.title` exists (`models.py:12`, migration `0005_workspace_title`) and `workspace_create` accepts it (`services.py:91`).
- **Single active repo.** `repo_owner`/`repo_name` come from `ghRepo` (derived from the git remote slug). No repo picker in the modal. When the active repo has no GitHub remote (`ghRepo === null`), creation is disabled.

## Design

### 1. Backend — cache invalidation (only server change)

`backend/apps/workspaces/apis.py`, `WorkspaceListApi.post`: after `workspace_create`, delete the overview cache key for that user + repo so the next overview GET recomputes.

```python
def post(self, request: Request) -> Response:
    serializer = WorkspaceCreateInputSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    ws = workspace_create(creator=cast(User, request.user), **serializer.validated_data)
    cache.delete(
        f"overview:{request.user.pk}:"
        f"{serializer.validated_data['repo_owner']}/{serializer.validated_data['repo_name']}"
    )
    return Response(WorkspaceOutputSerializer(ws).data, status=status.HTTP_201_CREATED)
```

`cache` is already imported (`apis.py:4`). The key format must match `RepoOverviewApi.get` exactly. `workspace_create` itself is unchanged.

### 2. Rust SDK — `client/src-tauri/src/api/workspaces.rs` (new)

```rust
impl Client {
    pub async fn workspace_create(
        &self, token: &str,
        repo_owner: &str, repo_name: &str,
        head_ref: &str, base_ref: &str, title: &str,
    ) -> Result<serde_json::Value, Error> {
        let url = self.base_url.join("api/v1/workspaces/").unwrap();
        let body = serde_json::json!({
            "repo_owner": repo_owner, "repo_name": repo_name,
            "head_ref": head_ref, "base_ref": base_ref, "title": title,
        });
        let resp = self.http.post(url).bearer_auth(token).json(&body).send().await?;
        let status = resp.status();
        if !status.is_success() { return Err(Self::map_error(resp).await); }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }
}
```

Register `mod workspaces;` in `client/src-tauri/src/api/mod.rs`. Error handling identical to `overview.rs` (`map_error` turns the backend `{message, extra}` envelope into `Error::Unexpected`; the 409 message flows through verbatim).

### 3. Tauri command — `commands.rs` + `lib.rs`

```rust
#[tauri::command]
pub async fn workspace_create(
    state: tauri::State<'_, AppState>,
    repo_owner: String, repo_name: String,
    head_ref: String, base_ref: String, title: String,
) -> Result<serde_json::Value, AppError> {
    let token = state.require_token()?;
    let ws = state.api
        .workspace_create(&token, &repo_owner, &repo_name, &head_ref, &base_ref, &title)
        .await?;
    Ok(ws)
}
```

Register `commands::workspace_create` in the `lib.rs` `invoke_handler!`. Mirrors `repo_overview`. The backend `{message}` flows out as `AppError::Backend(...)` (via `From<api::Error>`), which serializes to a string the webview reads.

### 4. TS wrapper — `tauri.ts`

```ts
export type WorkspaceCreateInput = {
  repoOwner: string; repoName: string;
  headRef: string; baseRef: string; title: string;
};
export const workspaceCreate = (input: WorkspaceCreateInput) =>
  invoke<unknown>('workspace_create', input);
```

(Return ignored by the UI; typed `unknown` to signal "don't read the body" per B1.)

### 5. UI — `Workspaces.tsx`

**`NewWorkspaceModal`** (new component, same file or a sibling):
- Props: `branches` (the `selfReviewBranches` set — local branches without a workspace), `defaultBranch`, `ghRepo {owner, repo}`, `prefillBranch?`, `onClose`, `onCreated`.
- Fields: **Branch** picker (`<select>` over eligible branches; prefilled when launched from a row), **Base** input (default `defaultBranch ?? 'main'`), **Title** input (optional).
- Submit → `workspaceCreate({ repoOwner, repoName, headRef, baseRef, title })`. On success: `onCreated()` (parent re-runs `loadOverview(ghRepo.owner, ghRepo.repo)`) then close. On error: render the backend message in a **red banner inside the modal** (e.g. 409 "Workspace already exists for that repo + head_ref"); never swallow. Disable Create while in flight.

**Toolbar button** (`Workspaces.tsx:438`): open the modal with no branch preselected. `disabled` when `ghRepo === null`.

**Per-branch button** on `BranchRowCompact`: a **Ready to share** action that opens the same modal with that branch prefilled. (Distinct from the existing **Self-Review** stub button, which stays as-is — Self-Review is the pre-workspace, client-only step.)

State lives in the `Workspaces` component: `modalOpen`, `modalPrefillBranch`. `onCreated` calls the existing `loadOverview`.

### Error handling (CLAUDE.md fail-loud)

- Backend: `workspace_create` already raises `ApplicationError`; the cache `delete` runs only after a successful create (inside the same handler, before the 201).
- Rust → TS: backend `{message, extra}` surfaces verbatim through `map_error` → `AppError::Backend`.
- UI: the modal renders the message in a red banner; no default-on-error, no silent close.

## Testing

- **Backend (pytest):** `WorkspaceListApi.post` deletes the overview cache key — create then GET overview reflects the new workspace immediately (no 30s stale window). Duplicate `(repo_owner, repo_name, head_ref)` still returns 409.
- **Rust (`wiremock`, mirror `github.rs` tests):** `workspace_create` sends the JSON body + bearer header, maps a 201 body, and maps a 409 `{message}` to `Error::Unexpected` carrying the message.
- **Manual (`just` run app):** New workspace (toolbar) → pick branch → Create → row appears in Ready to share in the same interaction. Per-branch Ready to share → modal opens with branch prefilled → Create → branch row moves from Self-Review to Ready to share. Duplicate create → red banner with the 409 message.

## Out of scope (future)

- Workspace-detail / storyline-composition screen and routing to it after create. This is the documented next direction; this slice deliberately stops at the overview refresh.
- GitHub branch-existence validation at create time.
- Repo picker / multi-repo creation.

## Verify pipeline

`just pre-commit` (ruff + pyrefly + biome + cargo fmt + tsc + cargo check); `just verify` for the full pass (clippy + cargo test + pytest) given backend + Rust changes.
