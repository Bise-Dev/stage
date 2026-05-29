# Revert Workspace to Self-Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the creator of a pre-publish workspace discard it ("Back to Self-Review") — deletes the Stage workspace record (cascading its storyline) so the git branch returns to the Self-Review bucket.

**Architecture:** New `DELETE /api/v1/workspaces/<id>/` backed by a `workspace_delete` service (creator-only, pre-publish-only, cascades storyline; rejects published with 409). A shared `_overview_cache_key` helper de-duplicates the overview cache key now used by three call sites and is busted on delete. Client gains a Rust SDK method → Tauri command → TS wrapper → an inline "Back to Self-Review" button on the creator's Ready-to-share rows, gated behind a confirm dialog. Builds on the create-workspace slice (same branch `feat/create-workspace-wiring`).

**Tech Stack:** Django + DRF + pytest; Rust + reqwest + wiremock + Tauri; React 19 + TypeScript + Biome. Build/test via `just`; client uses `bun`, never `npm`.

**Spec:** `docs/superpowers/specs/2026-05-29-revert-workspace-to-self-review-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `backend/apps/workspaces/apis.py` | Modify | Add `_overview_cache_key` helper; route `RepoOverviewApi.get` + `WorkspaceListApi.post` through it; add `WorkspaceDetailApi.delete`. |
| `backend/apps/workspaces/services.py` | Modify (append) | `workspace_delete` service. |
| `backend/tests/workspaces/test_workspace_apis.py` | Modify (append) | 6 delete tests. |
| `client/src-tauri/src/api/workspaces.rs` | Modify | `Client::workspace_delete` + 2 wiremock tests. |
| `client/src-tauri/src/commands.rs` | Modify (append) | `workspace_delete` command. |
| `client/src-tauri/src/lib.rs` | Modify | Register the command. |
| `client/src/tauri.ts` | Modify (append) | `workspaceDelete` wrapper. |
| `client/src/screens/workspaces/Workspaces.tsx` | Modify | `WorkspaceRowCompact` button + `ConfirmDialog` + revert state/wiring. |

---

## Task 1: Backend — extract `_overview_cache_key` helper (refactor)

**Why:** the overview cache key is currently built inline in two places and Task 2 adds a third. Extract one helper so they cannot drift. Pure refactor — no behaviour change; existing tests must stay green.

**Files:**
- Modify: `backend/apps/workspaces/apis.py` (lines 46-81 region)

- [ ] **Step 1: Add the helper above `WorkspaceListApi`**

In `backend/apps/workspaces/apis.py`, insert this module-level function immediately before `class WorkspaceListApi(APIView):` (currently line 46):

```python
def _overview_cache_key(user_pk: int, owner: str, repo: str) -> str:
    """Cache key for RepoOverviewApi, shared with the create/delete handlers
    that must bust it. Single source of truth so the three sites can't drift."""
    return f"overview:{user_pk}:{owner}/{repo}"
```

- [ ] **Step 2: Route `WorkspaceListApi.post` through the helper**

Replace the `cache.delete(...)` block in `WorkspaceListApi.post` (currently lines 55-61):

```python
        # The overview is cached per (user, repo) for 30s (see RepoOverviewApi).
        # Bust it so the new workspace shows up immediately.
        cache.delete(
            _overview_cache_key(
                request.user.pk,
                serializer.validated_data["repo_owner"],
                serializer.validated_data["repo_name"],
            )
        )
```

- [ ] **Step 3: Route `RepoOverviewApi.get` through the helper**

In `RepoOverviewApi.get`, replace line 72:

```python
        cache_key = _overview_cache_key(request.user.pk, owner, repo)
```

- [ ] **Step 4: Run the existing tests to confirm no behaviour change**

Run: `cd backend && uv run pytest tests/workspaces/test_workspace_apis.py tests/workspaces/test_repo_overview_api.py -v`
Expected: PASS — all existing tests green (including `test_workspace_create_invalidates_overview_cache`, which exercises the key path).

- [ ] **Step 5: Commit**

```bash
git add backend/apps/workspaces/apis.py
git commit -m "$(cat <<'EOF'
refactor(workspaces): extract _overview_cache_key helper

The overview cache key was built inline in RepoOverviewApi.get and
WorkspaceListApi.post; a third site (delete) is about to need it.
One helper so the key format cannot drift.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Backend — `workspace_delete` service + `DELETE` endpoint

**Files:**
- Modify: `backend/apps/workspaces/services.py` (append after `workspace_update_local_phase`)
- Modify: `backend/apps/workspaces/apis.py` (`WorkspaceDetailApi`, add `delete`; add import)
- Test: `backend/tests/workspaces/test_workspace_apis.py` (append)

- [ ] **Step 1: Write the failing tests**

In `backend/tests/workspaces/test_workspace_apis.py`, extend the models import (currently `from apps.workspaces.models import Workspace`) to:

```python
from apps.workspaces.models import Storyline, Workspace
```

Then append these six tests at the end of the file. (They reuse the `authed_client` fixture, `WorkspaceFactory`, `UserFactory`, and the `_gw_empty()` helper + `cache`/`patch` imports already added by the create slice.)

```python
@pytest.mark.django_db
def test_workspace_delete_pre_publish_204(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    Storyline.objects.create(workspace=ws, etag="e", updated_by=user)
    resp = client.delete(f"/api/v1/workspaces/{ws.id}/")
    assert resp.status_code == 204, resp.content
    assert not Workspace.objects.filter(pk=ws.id).exists()
    # Cascade: the storyline goes with it.
    assert not Storyline.objects.filter(workspace_id=ws.id).exists()


@pytest.mark.django_db
def test_workspace_delete_invalidates_overview_cache(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    cache.clear()
    with patch("apps.workspaces.apis.make_user_gateway", return_value=_gw_empty()):
        primed = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
        assert primed.status_code == 200, primed.content
        assert any(r["kind"] == "workspace" and r["id"] == str(ws.id) for r in primed.json())

        deleted = client.delete(f"/api/v1/workspaces/{ws.id}/")
        assert deleted.status_code == 204, deleted.content

        after = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
    assert after.status_code == 200, after.content
    assert all(r.get("id") != str(ws.id) for r in after.json())


@pytest.mark.django_db
def test_workspace_delete_published_409(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=42))
    resp = client.delete(f"/api/v1/workspaces/{ws.id}/")
    assert resp.status_code == 409, resp.content
    assert Workspace.objects.filter(pk=ws.id).exists()


@pytest.mark.django_db
def test_workspace_delete_non_creator_pre_publish_404(authed_client) -> None:
    client_b, _user_b = authed_client
    user_a = cast(User, UserFactory())
    ws_a = cast(Workspace, WorkspaceFactory(created_by=user_a, pr_number=None))
    resp = client_b.delete(f"/api/v1/workspaces/{ws_a.id}/")
    assert resp.status_code == 404, resp.content
    assert Workspace.objects.filter(pk=ws_a.id).exists()


@pytest.mark.django_db
def test_workspace_delete_non_creator_published_403(authed_client) -> None:
    client_b, _user_b = authed_client
    user_a = cast(User, UserFactory())
    ws_a = cast(Workspace, WorkspaceFactory(created_by=user_a, pr_number=11))
    resp = client_b.delete(f"/api/v1/workspaces/{ws_a.id}/")
    assert resp.status_code == 403, resp.content
    assert Workspace.objects.filter(pk=ws_a.id).exists()


@pytest.mark.django_db
def test_workspace_delete_unknown_404(authed_client) -> None:
    client, _ = authed_client
    resp = client.delete(f"/api/v1/workspaces/{uuid.uuid4()}/")
    assert resp.status_code == 404, resp.content
```

Add `import uuid` at the top of the test file if not already present (check the existing imports first — add it only if missing).

- [ ] **Step 2: Run tests to verify they FAIL**

Run: `cd backend && uv run pytest tests/workspaces/test_workspace_apis.py -k workspace_delete -v`
Expected: FAIL — `WorkspaceDetailApi` has no `delete`, so DELETE returns 405 Method Not Allowed (assertions on 204/409/404/403 fail).

- [ ] **Step 3: Add the `workspace_delete` service**

Append to `backend/apps/workspaces/services.py`:

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

(`transaction`, `ApplicationError`, `Workspace`, `User` are already imported in `services.py`.)

- [ ] **Step 4: Add the `delete` method to `WorkspaceDetailApi`**

In `backend/apps/workspaces/apis.py`, add `workspace_delete` to the services import block (the `from apps.workspaces.services import (...)` list):

```python
    workspace_create,
    workspace_delete,
    workspace_update_local_phase,
)
```

Then add this method to `WorkspaceDetailApi` (after `patch`):

```python
    def delete(self, request: Request, workspace_id: uuid.UUID) -> Response:
        ws = self._get_workspace(workspace_id)
        # Preserve pre-publish privacy: a non-creator must not learn the
        # workspace exists (same 404 rule as GET).
        if ws.pr_number is None and request.user.pk != ws.created_by_id:
            raise ApplicationError("Not found", status=404)
        workspace_delete(workspace=ws, user=cast(User, request.user))
        cache.delete(_overview_cache_key(request.user.pk, ws.repo_owner, ws.repo_name))
        return Response(status=status.HTTP_204_NO_CONTENT)
```

- [ ] **Step 5: Run tests to verify they PASS**

Run: `cd backend && uv run pytest tests/workspaces/test_workspace_apis.py -v`
Expected: PASS — the six new delete tests plus all existing tests green.

- [ ] **Step 6: Commit**

```bash
git add backend/apps/workspaces/apis.py backend/apps/workspaces/services.py backend/tests/workspaces/test_workspace_apis.py
git commit -m "$(cat <<'EOF'
feat(workspaces): DELETE workspace (pre-publish revert to Self-Review)

workspace_delete: creator-only, rejects published workspaces (409),
cascades the storyline. WorkspaceDetailApi.delete returns 204, 404s to
non-creators of pre-publish workspaces (privacy), and busts the overview
cache via the shared key helper.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rust SDK — `Client::workspace_delete`

**Files:**
- Modify: `client/src-tauri/src/api/workspaces.rs` (add a method to the existing `impl Client`; add 2 tests to the existing `mod tests`)

- [ ] **Step 1: Add the method**

In `client/src-tauri/src/api/workspaces.rs`, add this method inside the existing `impl Client { ... }` block, directly after `workspace_create`:

```rust
    /// Delete a pre-publish Stage workspace. DELETE /api/v1/workspaces/{id}/.
    /// Returns () — the backend replies 204 with no body, so nothing is parsed.
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

- [ ] **Step 2: Add the wiremock tests**

In the same file's `#[cfg(test)] mod tests { ... }` block, add these two tests (the `use` lines `body_partial_json, header_exists, method, path` and the wiremock/Client/Error imports are already present from the create tests):

```rust
    #[tokio::test]
    async fn workspace_delete_ok() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/api/v1/workspaces/11111111-1111-1111-1111-111111111111/"))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        client
            .workspace_delete("stg_abc", "11111111-1111-1111-1111-111111111111")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn workspace_delete_published_409() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/api/v1/workspaces/22222222-2222-2222-2222-222222222222/"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "message": "Can't discard a published workspace; close its PR on GitHub instead",
                "extra": { "pr_number": 42 }
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client
            .workspace_delete("stg_abc", "22222222-2222-2222-2222-222222222222")
            .await
            .unwrap_err();
        match err {
            Error::Unexpected { status, message, .. } => {
                assert_eq!(status.as_u16(), 409);
                assert!(message.contains("published"), "message was: {message}");
            }
            other => panic!("expected Unexpected 409, got {other:?}"),
        }
    }
```

(If the `body_partial_json` import becomes unused after adding these — it is still used by `workspace_create_ok` — leave it. Do not remove imports the create tests rely on.)

- [ ] **Step 3: Run the tests**

Run: `cd client/src-tauri && cargo test workspace_delete`
Expected: PASS — `workspace_delete_ok` and `workspace_delete_published_409` green. (As in the create slice, a 409 with a non-"validation_error"/"github_error" message maps to `Error::Unexpected`; if the actual variant differs, read `client/src-tauri/src/api/client.rs::map_error` and match the real one — report any change.)

- [ ] **Step 4: Format + lint**

Run: `cd client/src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add client/src-tauri/src/api/workspaces.rs
git commit -m "$(cat <<'EOF'
feat(client): add workspace_delete to the backend SDK

DELETE /api/v1/workspaces/{id}/ returning () (204, no body). Wiremock
tests for the 204 happy path and the 409 published-rejection.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Tauri command — `workspace_delete`

**Files:**
- Modify: `client/src-tauri/src/commands.rs` (append, mirror `workspace_create`)
- Modify: `client/src-tauri/src/lib.rs` (`invoke_handler!`)

No unit test (thin passthrough, consistent with the other commands). Verified by `cargo check` + clippy.

- [ ] **Step 1: Add the command**

Append to `client/src-tauri/src/commands.rs`:

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

- [ ] **Step 2: Register it**

In `client/src-tauri/src/lib.rs`, add `commands::workspace_delete,` to the `tauri::generate_handler!` list, right after `commands::workspace_create,`:

```rust
            commands::workspace_create,
            commands::workspace_delete,
            commands::git_fetch,
```

- [ ] **Step 3: Verify compile + lint**

Run: `cd client/src-tauri && cargo check --all-targets && cargo clippy --all-targets -- -D warnings && cargo fmt`
Expected: clean, no warnings.

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/commands.rs client/src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(client): expose workspace_delete Tauri command

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: TS wrapper — `workspaceDelete`

**Files:**
- Modify: `client/src/tauri.ts` (append to the Workspaces section)

- [ ] **Step 1: Add the wrapper**

In `client/src/tauri.ts`, under the existing `// --- Workspaces ---` section (after `workspaceCreate`), add:

```ts
export const workspaceDelete = (workspaceId: string) =>
  invoke<void>('workspace_delete', { workspaceId });
```

- [ ] **Step 2: Verify types + lint**

Run: `cd client && bun run typecheck && bun run lint`
Expected: PASS — tsc clean, Biome clean. If a post-edit hook flips quotes, run `bun run format` and re-run; keep the public shape identical.

- [ ] **Step 3: Commit**

```bash
git add client/src/tauri.ts
git commit -m "$(cat <<'EOF'
feat(client): add workspaceDelete invoke wrapper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: UI — "Back to Self-Review" button + confirm dialog

**Files:**
- Modify: `client/src/screens/workspaces/Workspaces.tsx`

No JS test runner — verified by `tsc` + Biome + manual. Five edits: import; revert state; pass callback to the `yoursReadyToShare` rows; add the button to `WorkspaceRowCompact`; add the `ConfirmDialog` component + its render block.

- [ ] **Step 1: Import the wrapper**

In the import block from `'../../tauri'`, add `workspaceDelete` next to `workspaceCreate`:

```ts
  workspaceCreate,
  workspaceDelete,
} from '../../tauri';
```

- [ ] **Step 2: Add revert state in the `Workspaces` component**

Next to the `newWsOpen`/`newWsBranch` state (added by the create slice), add:

```ts
  const [revertTarget, setRevertTarget] = useState<OverviewWorkspaceRow | null>(null);
```

(`OverviewWorkspaceRow` is already imported.)

- [ ] **Step 3: Pass the callback to the Ready-to-share rows ONLY**

Find the `yoursReadyToShare` map (it renders `<WorkspaceRowCompact key={w.id} w={w} stats={wsStats(w)} />` inside the "Ready to share" `Bucket`). Replace that element with:

```tsx
                        <WorkspaceRowCompact
                          key={w.id}
                          w={w}
                          stats={wsStats(w)}
                          onBackToSelfReview={ghRepo ? (ws) => setRevertTarget(ws) : undefined}
                        />
```

Do NOT change the `yoursInReview` or `reviewInReview` maps — those rows must not get the button (published / not-mine).

- [ ] **Step 4: Add the button to `WorkspaceRowCompact`**

Replace the whole `WorkspaceRowCompact` function with the version below (adds the optional `onBackToSelfReview` prop and renders the button at the end of the row; everything else is unchanged):

```tsx
function WorkspaceRowCompact({
  w,
  stats,
  reviewing,
  onBackToSelfReview,
}: {
  w: OverviewWorkspaceRow;
  stats: { added: number | null; removed: number | null };
  reviewing?: boolean;
  onBackToSelfReview?: (w: OverviewWorkspaceRow) => void;
}) {
  const st = STATES[w.state];
  return (
    <div style={rowShell()}>
      {reviewing && <Avatar name={w.created_by.github_login} size="sm" />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: '0 1 auto',
            }}
          >
            {w.title || w.head_ref}
          </span>
          {w.pr_number !== null && (
            <span className="badge" style={{ background: 'rgba(0,0,0,0.06)', flex: '0 0 auto' }}>
              #{w.pr_number}
            </span>
          )}
          <span className={`badge ${st.cls}`} style={{ flex: '0 0 auto' }}>
            {st.label}
          </span>
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--gray-500)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            overflow: 'hidden',
          }}
        >
          <span
            className="mono"
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '40%',
            }}
          >
            {w.head_ref}
          </span>
          <DiffStat added={stats.added} removed={stats.removed} />
          {w.storyline_count > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="doc-stack" size={9} color="var(--gray-500)" /> {w.storyline_count}
            </span>
          )}
          {w.comment_count !== null && w.comment_count > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="comment-fill" size={9} color="var(--gray-400)" /> {w.comment_count}
            </span>
          )}
        </div>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--gray-500)', flex: '0 0 auto' }}>
        {relativeTime(w.last_active_at)}
      </div>
      {onBackToSelfReview && (
        <button
          type="button"
          className="btn"
          onClick={() => onBackToSelfReview(w)}
          title="Discard this workspace and return the branch to Self-Review"
          style={{ flex: '0 0 auto' }}
        >
          <Icon name="chevron-left" size={10} color="var(--gray-700)" /> Back to Self-Review
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Add the `ConfirmDialog` component + render block**

Append `ConfirmDialog` at the end of `Workspaces.tsx` (after `NewWorkspaceModal`):

```tsx
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      // Fail loud (CLAUDE.md): surface the backend message; never close on error.
      console.warn('confirm_action_failed', e);
      const msg =
        typeof e === 'object' && e !== null && 'message' in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: POC overlay modal; a styled div with role="dialog" matches the existing NewWorkspaceModal/RepoMenu pattern rather than a native <dialog>.
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 380,
          background: '#fff',
          borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--sh-pop)',
          padding: 18,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--gray-900)', marginBottom: 8 }}>
          {title}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--gray-700)', lineHeight: 1.5, marginBottom: 14 }}>
          {body}
        </div>
        {error && (
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--red-d)',
              background: 'rgba(255,59,48,0.08)',
              border: '1px solid rgba(255,59,48,0.20)',
              borderRadius: 'var(--r-sm)',
              padding: '6px 10px',
              marginBottom: 8,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={confirm}
            disabled={submitting}
            style={{ opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Then render it inside the `Workspaces` return, right after the `{newWsOpen && ghRepo && (<NewWorkspaceModal ... />)}` block:

```tsx
          {revertTarget && ghRepo && (
            <ConfirmDialog
              title="Discard this workspace?"
              body={
                <>
                  The storyline and title are removed. The branch{' '}
                  <span className="mono">{revertTarget.head_ref}</span> is kept and returns to
                  Self-Review.
                </>
              }
              confirmLabel="Discard"
              onConfirm={async () => {
                await workspaceDelete(revertTarget.id);
                loadOverview(ghRepo.owner, ghRepo.repo);
              }}
              onClose={() => setRevertTarget(null)}
            />
          )}
```

- [ ] **Step 6: Verify types + lint**

Run: `cd client && bun run typecheck && bun run lint`
Expected: PASS — 0 errors, 0 warnings. If a post-edit hook flips quotes, run `bun run format` and re-run. If Biome reports a different a11y rule id on the dialog `<div>` than `lint/a11y/useSemanticElements`, change the `biome-ignore` to the exact id reported, then re-run until clean.

- [ ] **Step 7: Manual verification (controller runs the app)**

Run: `cd client && just dev`. Then:
1. Create a workspace (or use an existing Ready-to-share one). Its row shows a **↩ Back to Self-Review** button.
2. Confirm published ("In review") rows and rows authored by others do NOT show the button.
3. Click **Back to Self-Review** → confirm dialog names the branch → **Discard** → dialog closes, overview reloads, the workspace leaves "Ready to share" and its branch reappears under Self-Review.
4. Cancel leaves everything unchanged.

- [ ] **Step 8: Commit**

```bash
git add client/src/screens/workspaces/Workspaces.tsx
git commit -m "$(cat <<'EOF'
feat(workspaces): Back to Self-Review (discard pre-publish workspace)

Inline button on the creator's Ready-to-share rows opens a confirm
dialog; on confirm calls workspaceDelete and reloads the overview, so
the branch returns to Self-Review. Published / others' rows get no
button. Errors surface in the dialog (fail loud).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Full verify pass

- [ ] **Step 1: Run the whole pipeline**

Run (from repo root): `just verify`
Expected: PASS — pre-commit (ruff + ruff-format + pyrefly + biome + cargo fmt + tsc + cargo check), `just client::clippy`, `just client::test`, `just backend::test`, all green.

If pre-commit auto-fixes files, stage and re-run:

```bash
git add -A
just verify
```

- [ ] **Step 2: Commit any auto-fixes (only if pre-commit changed files)**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: pre-commit auto-fixes for revert-workspace slice

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (filled in by the plan author)

**Spec coverage:**
- Pre-publish-only delete, creator-only, cascade → Task 2 (`workspace_delete` service). ✓
- 204 / 409 / 404(non-creator pre-publish) / 403(non-creator published) / 404(unknown) → Task 2 tests + API guard + service guards. ✓
- `_overview_cache_key` helper, 3 sites, busted on delete → Task 1 (extract + 2 sites) + Task 2 (delete site). ✓
- DELETE REST shape on `WorkspaceDetailApi` → Task 2. ✓
- Rust SDK 204 → `Ok(())` + 409 test → Task 3. ✓
- Tauri command + registration → Task 4. ✓
- TS wrapper → Task 5. ✓
- "Back to Self-Review" button on creator's Ready-to-share rows only → Task 6 Steps 3-4. ✓
- Confirm dialog, branch named, fail-loud banner → Task 6 Step 5. ✓
- Refresh = `loadOverview` (no client row synthesis) → Task 6 Step 5 `onConfirm`. ✓
- Out of scope (un-publish, soft-delete, branch deletion) → not built. ✓

**Placeholder scan:** No TBD/TODO; full code in every code step; commands have expected output. ✓

**Type consistency:** `workspaceDelete(workspaceId: string)` (Task 5) called with `revertTarget.id` (Task 6). Tauri `workspace_delete(workspace_id: String)` (Task 4) ↔ JS key `workspaceId` (camelCase→snake_case). Rust `Client::workspace_delete(token, workspace_id)` (Task 3) ↔ command (Task 4). Backend `workspace_delete(*, workspace, user)` (Task 2 service) ↔ API call site (Task 2). `_overview_cache_key(user_pk, owner, repo)` signature identical across Task 1 + Task 2 sites. `onBackToSelfReview?: (w: OverviewWorkspaceRow) => void` (Task 6 Step 4) ↔ `(ws) => setRevertTarget(ws)` (Step 3). ✓
