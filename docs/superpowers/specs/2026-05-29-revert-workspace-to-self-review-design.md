# Revert Workspace to Self-Review — Design

**Date:** 2026-05-29
**Status:** Approved (brainstorming → ready for implementation plan)
**Scope:** Let the creator of a **pre-publish** workspace discard it ("Back to Self-Review"). Deletes the Stage workspace record (cascading its storyline) so the underlying git branch returns to the Self-Review bucket. UI → Tauri command → Rust SDK → backend. Builds directly on the create-workspace wiring (same branch `feat/create-workspace-wiring`).

## Problem

After creating a workspace ("Ready to share"), there is no way to undo it. A user who created a workspace by mistake, or changed their mind before publishing, is stuck — the workspace persists forever (data-model.md:207 explicitly defers this: *"'Stale local workspace' cleanup … persists forever in v1; cleanup heuristics deferred."*). There is no delete endpoint or service today (`WorkspaceDetailApi` has only GET + PATCH; `services.py` has no delete).

## Domain framing (why this is allowed)

- **"No archive concept"** (CONTEXT.md:60, design.md:257) concerns the *post-PR* lifecycle — a published workspace outlives its PR and its mutability follows GitHub's PR state. It does **not** forbid a creator deleting a *pre-publish* draft that never reached GitHub.
- Pre-publish workspaces are **strictly creator-only private state** (design.md:165, 183). The creator may freely discard their own unpublished draft.
- `workspace_update_local_phase` already rejects edits once `pr_number` is set (409) — the precedent for "pre-publish-only" gating.
- The git branch is **local and Stage-owned-by-nothing**: Stage never created or touches it. Deleting the workspace record leaves the branch intact, so it reappears in the Self-Review bucket (which is "local branches with no workspace").

## Decisions

- **Pre-publish only.** Revert applies to workspaces with `pr_number IS NULL`. A published ("in review") workspace is bound to a live GitHub PR — reject with 409. Un-publishing (closing the PR) is explicitly out of scope.
- **Gesture: "Back to Self-Review"** — an inline button on the creator's own Ready-to-share rows. Frames the action as moving a phase back, matching the product vocabulary (avoid "archive").
- **Confirm dialog** before deleting (B1: a small in-app modal, not `window.confirm`). The draft's storyline/title are lost; the dialog names the branch that is kept.
- **Hard delete** (A: `DELETE /api/v1/workspaces/<id>/`). Cascades `Storyline → StorylineFile → IntroComment`. No soft-delete (consistent with data-model.md:98 "no `archived_at`, no soft-delete"); the confirm dialog is the safety net.
- **Creator-only** (403 to others); **404** to a non-creator on a pre-publish workspace (preserve privacy, same rule as GET).
- **Cache-key helper extraction.** The overview cache key is now built in three places — extract `_overview_cache_key(user_pk, owner, repo)` and route `RepoOverviewApi.get`, `WorkspaceListApi.post`, and the new delete through it.

## Design

### 1. Backend service — `backend/apps/workspaces/services.py`

Add `workspace_delete`:

```python
@transaction.atomic
def workspace_delete(*, workspace: Workspace, user: User) -> None:
    if user.pk != workspace.created_by_id:
        raise ApplicationError("creator_only", status=403)
    if workspace.pr_number is not None:
        raise ApplicationError(
            "Can't discard a published workspace; close its PR on GitHub instead",
            extra={"workspace_id": str(workspace.id), "pr_number": workspace.pr_number},
            status=409,
        )
    workspace.delete()
```

`workspace.delete()` cascades to `Storyline` (OneToOne CASCADE), `StorylineFile` (FK CASCADE), `IntroComment` (FK CASCADE). No GitHub call. The git branch is untouched.

### 2. Backend API + cache helper — `backend/apps/workspaces/apis.py`

Add a module-level helper and route all three sites through it:

```python
def _overview_cache_key(user_pk: int, owner: str, repo: str) -> str:
    return f"overview:{user_pk}:{owner}/{repo}"
```

- `RepoOverviewApi.get`: replace the inline `cache_key = f"overview:..."` with `_overview_cache_key(request.user.pk, owner, repo)`.
- `WorkspaceListApi.post`: replace its inline `cache.delete(f"overview:...")` (added by the create slice) with `cache.delete(_overview_cache_key(request.user.pk, serializer.validated_data["repo_owner"], serializer.validated_data["repo_name"]))`.
- `WorkspaceDetailApi.delete`:

```python
    def delete(self, request: Request, workspace_id: uuid.UUID) -> Response:
        ws = self._get_workspace(workspace_id)
        # Preserve pre-publish privacy: a non-creator must not learn the
        # workspace exists (same rule as GET).
        if ws.pr_number is None and request.user.pk != ws.created_by_id:
            raise ApplicationError("Not found", status=404)
        workspace_delete(workspace=ws, user=cast(User, request.user))
        cache.delete(_overview_cache_key(request.user.pk, ws.repo_owner, ws.repo_name))
        return Response(status=status.HTTP_204_NO_CONTENT)
```

Import `workspace_delete` from `services`. `_get_workspace` (already on the class) raises 404 if the id is unknown.

Authz outcomes:
- Creator, pre-publish → 204 (deleted).
- Creator, published → 409 (service guard).
- Non-creator, pre-publish → 404 (API guard, privacy).
- Non-creator, published → 403 (service guard; existence is already public for published).
- Unknown id → 404.

### 3. Rust SDK — `client/src-tauri/src/api/workspaces.rs`

Add to the existing `impl Client`:

```rust
    /// Delete a pre-publish Stage workspace. DELETE /api/v1/workspaces/{id}/.
    /// Returns () — the backend replies 204 with no body.
    pub async fn workspace_delete(&self, token: &str, workspace_id: &str) -> Result<(), Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/workspaces/{workspace_id}/"))
            .unwrap();
        let resp = self.http.delete(url).bearer_auth(token).send().await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        Ok(())
    }
```

(No `resp.json()` — a 204 has no body. Differs from `workspace_create` deliberately.) Add wiremock tests: `workspace_delete_ok` (204 → `Ok(())`), `workspace_delete_published_409` (409 `{message}` → `Error::Unexpected` with status 409 + message contains "published").

### 4. Tauri command + `lib.rs`

```rust
#[tauri::command]
pub async fn workspace_delete(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<(), AppError> {
    let token = state.require_token()?;
    state.api.workspace_delete(&token, &workspace_id).await?;
    Ok(())
}
```

Register `commands::workspace_delete,` in the `lib.rs` `invoke_handler!` (after `commands::workspace_create,`).

### 5. TS wrapper — `client/src/tauri.ts`

In the Workspaces section:

```ts
export const workspaceDelete = (workspaceId: string) =>
  invoke<void>('workspace_delete', { workspaceId });
```

(camelCase `workspaceId` → snake_case `workspace_id`, same convention as `gitDiffStats`.)

### 6. UI — `client/src/screens/workspaces/Workspaces.tsx`

- **`WorkspaceRowCompact`** gains optional `onBackToSelfReview?: (w: OverviewWorkspaceRow) => void`. When provided, render an inline **↩ Back to Self-Review** button (className `btn`, an undo/back icon). Render nothing extra when absent.
- Pass the callback **only** for the `yoursReadyToShare` bucket (pre-publish + authored by me):
  `onBackToSelfReview={ghRepo ? (w) => setRevertTarget(w) : undefined}`. The `yoursInReview` and `reviewInReview` mappings pass nothing.
- Component state: `const [revertTarget, setRevertTarget] = useState<OverviewWorkspaceRow | null>(null);`
- **`ConfirmDialog`** (new small modal component, same overlay/card styling as `NewWorkspaceModal`):
  - Props: `title`, `body`, `confirmLabel`, `onConfirm` (async), `onClose`.
  - Internal `submitting` + `error` state. Confirm button calls `onConfirm`; on rejection sets a red banner with the backend message (fail loud); on success the parent closes it.
  - Rendered when `revertTarget` is set: title "Discard this workspace?", body "The storyline and title are removed. The branch `<revertTarget.head_ref>` is kept and returns to Self-Review.", confirmLabel "Discard". `onConfirm` = `async () => { await workspaceDelete(revertTarget.id); loadOverview(ghRepo.owner, ghRepo.repo); }`; `onClose` = `() => setRevertTarget(null)`. On confirm success the dialog calls `onClose` after `onConfirm` resolves.

Refresh behaviour: after delete, `loadOverview` repopulates `rows`; the deleted workspace's `head_ref` leaves `workspaceHeadRefs`, so its branch reappears in `selfReviewBranches` (Self-Review). The row leaves Ready-to-share. No client-side row synthesis.

### Error handling (CLAUDE.md fail-loud)

- Backend: `workspace_delete` raises `ApplicationError` (403/409); the API guard raises 404; the cache delete runs only after a successful delete.
- Rust → TS: backend `{message}` surfaces via `map_error` → `AppError::Backend` (string) → invoke rejection.
- UI: the confirm dialog renders the message in a red banner and stays open; it never closes or refreshes on error.

## Testing

- **Backend (pytest, `tests/workspaces/test_workspace_apis.py`):**
  - Creator deletes pre-publish workspace → 204; `Workspace.objects.filter(pk=...).exists()` is False; its `Storyline` is gone (cascade).
  - Delete invalidates the overview cache: prime overview (1 ws) → DELETE → overview reflects it gone immediately.
  - Creator deletes published workspace (`pr_number` set) → 409.
  - Non-creator deletes someone's pre-publish workspace → 404.
  - Non-creator deletes someone's published workspace → 403.
  - Unknown id → 404.
  - `_overview_cache_key` is used by create + overview + delete (the create-invalidation test from the prior slice still passes).
- **Rust (`wiremock`, `api/workspaces.rs`):** `workspace_delete_ok` (204 → Ok), `workspace_delete_published_409` (409 → `Error::Unexpected`, message contains "published"). Sends DELETE + bearer header.
- **UI:** `bun run typecheck` + `bun run lint`; manual — Back to Self-Review on a Ready-to-share row → confirm → row returns to Self-Review; published rows have no button; cancel leaves it; a forced error shows the banner.

## Out of scope

- Un-publishing (closing a GitHub PR to revert a published workspace).
- Soft-delete / recovery / trash.
- Bulk discard, stale-workspace auto-cleanup heuristics (data-model.md:207).
- Deleting the local git branch.

## Verify pipeline

`just pre-commit`; `just verify` for the full pass (clippy + cargo test + pytest) given backend + Rust changes.
