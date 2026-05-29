# Create-Workspace Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "New workspace" button (and a new per-branch "Ready to share" button) actually create a `Workspace` via the existing backend endpoint, and show the new workspace in the overview immediately.

**Architecture:** One vertical slice across five layers. The Django `POST /api/v1/workspaces/` endpoint and `workspace_create` service already exist and need no new logic — except invalidating the 30s overview cache on create so the new row is visible right away. The client gains a Rust SDK method → Tauri command → TS wrapper → a shared modal opened from two entry points. After a successful create the screen re-runs its existing `loadOverview`.

**Tech Stack:** Django + DRF + pytest (backend); Rust + reqwest + wiremock + Tauri (client SDK/commands); React 19 + TypeScript + Biome (webview). Build/test via `just` recipes; the client uses `bun`, never `npm`.

**Spec:** `docs/superpowers/specs/2026-05-29-create-workspace-wiring-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `backend/apps/workspaces/apis.py` | Modify (`WorkspaceListApi.post`, ~line 51) | Invalidate the per-`(user, repo)` overview cache after create. |
| `backend/tests/workspaces/test_workspace_apis.py` | Modify (append) | Test that create invalidates the overview cache. |
| `client/src-tauri/src/api/workspaces.rs` | Create | `Client::workspace_create` SDK method + wiremock tests. |
| `client/src-tauri/src/api/mod.rs` | Modify (line 4-9 block) | Register `mod workspaces;`. |
| `client/src-tauri/src/commands.rs` | Modify (append) | `workspace_create` Tauri command. |
| `client/src-tauri/src/lib.rs` | Modify (`invoke_handler!`, ~line 77-95) | Register the command. |
| `client/src/tauri.ts` | Modify (append) | `workspaceCreate` invoke wrapper + input type. |
| `client/src/screens/workspaces/Workspaces.tsx` | Modify | `NewWorkspaceModal` + `Field`; wire toolbar button + per-branch button; modal state. |

Order is back-to-front so each layer is testable against the one below it.

---

## Task 1: Backend — invalidate overview cache on create

**Why:** `RepoOverviewApi` caches per `(user, repo)` for 30s (`apis.py:64-73`, key `f"overview:{request.user.pk}:{owner}/{repo}"`). Without invalidation, a freshly created workspace is invisible for up to 30s and the feature looks broken.

**Files:**
- Modify: `backend/apps/workspaces/apis.py` (`WorkspaceListApi.post`, line 51-55)
- Test: `backend/tests/workspaces/test_workspace_apis.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/workspaces/test_workspace_apis.py`. Add these imports at the top of the file (next to the existing imports):

```python
from unittest.mock import MagicMock, patch

from django.core.cache import cache
```

Then append this test at the end of the file:

```python
def _gw_empty() -> MagicMock:
    """A gateway whose searches return nothing — enough for an overview that
    contains only pre-publish (draft) workspaces, which never fan out to GitHub."""
    gw = MagicMock()
    gw.__enter__ = lambda s: s
    gw.__exit__ = MagicMock(return_value=False)
    gw.search_issues.return_value = {"items": []}
    gw.get_pr.return_value = {"state": "open", "head": {"ref": "feat/x"}}
    gw.list_reviews.return_value = []
    return gw


@pytest.mark.django_db
def test_workspace_create_invalidates_overview_cache(authed_client) -> None:
    """Creating a workspace must bust the cached overview for that (user, repo)
    so the new row is visible immediately, not after the 30s TTL."""
    client, _ = authed_client
    cache.clear()  # LocMemCache persists across tests in-process; isolate this one.
    with patch("apps.workspaces.apis.make_user_gateway", return_value=_gw_empty()):
        # Prime the per-(user, repo) overview cache: no workspaces yet.
        primed = client.get("/api/v1/repos/o/r/overview/")
        assert primed.status_code == 200, primed.content
        assert primed.json() == []

        created = client.post(
            "/api/v1/workspaces/",
            {"repo_owner": "o", "repo_name": "r", "head_ref": "feat/x", "base_ref": "main"},
            format="json",
        )
        assert created.status_code == 201, created.content

        # Must reflect the new workspace right away (cache invalidated on create).
        after = client.get("/api/v1/repos/o/r/overview/")
    assert after.status_code == 200, after.content
    rows = after.json()
    assert any(
        r["kind"] == "workspace" and r["head_ref"] == "feat/x" for r in rows
    ), rows
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/workspaces/test_workspace_apis.py::test_workspace_create_invalidates_overview_cache -v`
Expected: FAIL — the second overview GET returns the stale cached `[]`, so the final `any(...)` assertion fails (`assert ... , []`).

- [ ] **Step 3: Implement the cache invalidation**

In `backend/apps/workspaces/apis.py`, replace `WorkspaceListApi.post` (currently lines 51-55):

```python
    def post(self, request: Request) -> Response:
        serializer = WorkspaceCreateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        ws = workspace_create(creator=cast(User, request.user), **serializer.validated_data)
        # The overview is cached per (user, repo) for 30s (see RepoOverviewApi).
        # Bust it so the new workspace shows up immediately. Key format MUST
        # match RepoOverviewApi.get exactly.
        cache.delete(
            f"overview:{request.user.pk}:"
            f"{serializer.validated_data['repo_owner']}/{serializer.validated_data['repo_name']}"
        )
        return Response(WorkspaceOutputSerializer(ws).data, status=status.HTTP_201_CREATED)
```

`cache` is already imported at `apis.py:4` (`from django.core.cache import cache`). No other change.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/workspaces/test_workspace_apis.py -v`
Expected: PASS — the new test plus the existing create/409/list/lookup/detail tests all green.

- [ ] **Step 5: Commit**

```bash
git add backend/apps/workspaces/apis.py backend/tests/workspaces/test_workspace_apis.py
git commit -m "$(cat <<'EOF'
feat(workspaces): bust overview cache on workspace create

The repo overview is cached per (user, repo) for 30s; without
invalidation a newly created workspace is invisible until the TTL
expires. Delete the matching cache key in WorkspaceListApi.post.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Rust SDK — `Client::workspace_create`

**Files:**
- Create: `client/src-tauri/src/api/workspaces.rs`
- Modify: `client/src-tauri/src/api/mod.rs` (the `mod` block, lines 4-9)
- Test: in `client/src-tauri/src/api/workspaces.rs` (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Register the module**

In `client/src-tauri/src/api/mod.rs`, add `mod workspaces;` to the module block so it reads:

```rust
mod auth;
mod client;
mod error;
mod github;
mod overview;
mod types;
mod workspaces;
```

(No `pub use` needed — the method is an `impl Client` block, reachable on the existing `Client` type.)

- [ ] **Step 2: Write the SDK method + failing tests**

Create `client/src-tauri/src/api/workspaces.rs`:

```rust
use super::client::Client;
use super::error::Error;

impl Client {
    /// Create a Stage workspace (pure backend DB record; no GitHub call).
    /// POST /api/v1/workspaces/. Returns the created workspace as raw JSON —
    /// the webview re-fetches the overview rather than mapping this body.
    pub async fn workspace_create(
        &self,
        token: &str,
        repo_owner: &str,
        repo_name: &str,
        head_ref: &str,
        base_ref: &str,
        title: &str,
    ) -> Result<serde_json::Value, Error> {
        let url = self.base_url.join("api/v1/workspaces/").unwrap();
        let body = serde_json::json!({
            "repo_owner": repo_owner,
            "repo_name": repo_name,
            "head_ref": head_ref,
            "base_ref": base_ref,
            "title": title,
        });
        let resp = self
            .http
            .post(url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{body_partial_json, header_exists, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::super::client::Client;
    use super::super::error::Error;

    #[tokio::test]
    async fn workspace_create_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/"))
            .and(header_exists("authorization"))
            .and(body_partial_json(serde_json::json!({
                "repo_owner": "o",
                "repo_name": "r",
                "head_ref": "feat/x",
                "base_ref": "main",
                "title": "T"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": "11111111-1111-1111-1111-111111111111",
                "head_ref": "feat/x"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let v = client
            .workspace_create("stg_abc", "o", "r", "feat/x", "main", "T")
            .await
            .unwrap();
        assert_eq!(v["head_ref"], "feat/x");
    }

    #[tokio::test]
    async fn workspace_create_duplicate_409() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "message": "Workspace already exists for that repo + head_ref",
                "extra": { "head_ref": "feat/x" }
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client
            .workspace_create("stg_abc", "o", "r", "feat/x", "main", "")
            .await
            .unwrap_err();
        match err {
            Error::Unexpected { status, message, .. } => {
                assert_eq!(status.as_u16(), 409);
                assert!(message.contains("already exists"), "message was: {message}");
            }
            other => panic!("expected Unexpected 409, got {other:?}"),
        }
    }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd client/src-tauri && cargo test workspace_create`
Expected: PASS — `workspace_create_ok` and `workspace_create_duplicate_409` both green. (If you wrote the test before the method, `cargo test` first fails to compile with "no method named `workspace_create`"; adding the `impl` block fixes it.)

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/api/workspaces.rs client/src-tauri/src/api/mod.rs
git commit -m "$(cat <<'EOF'
feat(client): add workspace_create to the backend SDK

POST /api/v1/workspaces/ returning raw JSON, mirroring api/overview.rs.
Covered by wiremock tests for the 201 happy path and the 409 duplicate
mapping to Error::Unexpected.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Tauri command — `workspace_create`

**Why:** Bridges the webview `invoke` to the SDK method, attaching the session token Rust-side (the webview never sees the token).

**Files:**
- Modify: `client/src-tauri/src/commands.rs` (append a command, mirror `repo_overview` at line 99-108)
- Modify: `client/src-tauri/src/lib.rs` (`invoke_handler!`, line 77-95)

No unit test: this command is a thin passthrough, consistent with the existing `repo_overview` / `github_prs` commands, which have none. The SDK behaviour is covered in Task 2; this task is verified by `cargo check` + clippy + the build.

- [ ] **Step 1: Add the command**

Append to `client/src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub async fn workspace_create(
    state: tauri::State<'_, AppState>,
    repo_owner: String,
    repo_name: String,
    head_ref: String,
    base_ref: String,
    title: String,
) -> Result<serde_json::Value, AppError> {
    let token = state.require_token()?;
    let ws = state
        .api
        .workspace_create(&token, &repo_owner, &repo_name, &head_ref, &base_ref, &title)
        .await?;
    Ok(ws)
}
```

(`serde_json` and `AppError` are already in scope in `commands.rs`; `repo_overview` uses both.)

- [ ] **Step 2: Register it in the invoke handler**

In `client/src-tauri/src/lib.rs`, add `commands::workspace_create,` to the `tauri::generate_handler!` list (after `commands::repo_overview,` on line 86):

```rust
            commands::repo_overview,
            commands::workspace_create,
            commands::git_fetch,
```

- [ ] **Step 3: Verify it compiles (and lint passes)**

Run: `cd client/src-tauri && cargo check --all-targets && cargo clippy --all-targets -- -D warnings`
Expected: clean — no errors, no clippy warnings.

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/commands.rs client/src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(client): expose workspace_create Tauri command

Thin async command mirroring repo_overview: pulls the session token
via require_token() and forwards to the SDK. Registered in the invoke
handler.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: TS wrapper — `workspaceCreate`

**Files:**
- Modify: `client/src/tauri.ts` (append, near the other wrappers)

No JS test runner exists in this project (`client/package.json` scripts are `dev`/`build`/`lint`/`format`/`typecheck` only). Verification is `tsc` + Biome.

- [ ] **Step 1: Add the wrapper**

Append to `client/src/tauri.ts` (after the GitHub proxy section, end of file):

```ts
// --- Workspaces ---
export type WorkspaceCreateInput = {
  repoOwner: string;
  repoName: string;
  headRef: string;
  baseRef: string;
  title: string;
};

// Returns the created workspace as raw JSON; the caller ignores the body and
// re-fetches the overview instead (see docs/adr/0009 + the create-workspace spec).
export const workspaceCreate = (input: WorkspaceCreateInput) =>
  invoke<unknown>('workspace_create', input);
```

- [ ] **Step 2: Verify types + lint**

Run: `cd client && bun run typecheck && bun run lint`
Expected: PASS — `tsc -b --noEmit` clean, Biome clean. (`bun` is the project's runner; do not use npm/npx.)

- [ ] **Step 3: Commit**

```bash
git add client/src/tauri.ts
git commit -m "$(cat <<'EOF'
feat(client): add workspaceCreate invoke wrapper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: UI — modal + both entry points

**Files:**
- Modify: `client/src/screens/workspaces/Workspaces.tsx`

No JS test runner — verified by `tsc` + Biome + a manual run. This task: (a) import `workspaceCreate`; (b) add `NewWorkspaceModal` + `Field` components; (c) add modal open-state to `Workspaces`; (d) wire the toolbar button; (e) add a per-branch "Ready to share" button on `BranchRowCompact`; (f) render the modal.

- [ ] **Step 1: Import the wrapper**

In `Workspaces.tsx`, add `workspaceCreate` to the existing import from `../../tauri` (the block at lines 6-22). Insert it alphabetically near `repoOverview`/`repoSummary`:

```ts
  repoOverview,
  repoSummary,
  workspaceCreate,
} from '../../tauri';
```

- [ ] **Step 2: Add modal open-state to the `Workspaces` component**

Inside `Workspaces` (after the existing `useState` hooks, e.g. after `const [fetchError, setFetchError] = useState<string | null>(null);` at line 71), add:

```ts
  const [newWsOpen, setNewWsOpen] = useState(false);
  const [newWsBranch, setNewWsBranch] = useState<string | undefined>(undefined);

  const openNewWorkspace = useCallback((branch?: string) => {
    setNewWsBranch(branch);
    setNewWsOpen(true);
  }, []);
```

`useState` and `useCallback` are already imported (line 2).

- [ ] **Step 3: Wire the toolbar "New workspace" button**

Replace the toolbar button (currently lines 435-441) with:

```tsx
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => openNewWorkspace()}
                disabled={!ghRepo}
                title={
                  ghRepo
                    ? undefined
                    : 'Open a repo with a GitHub remote to create a workspace'
                }
              >
                <Icon name="plus" size={12} color="#fff" /> New workspace
              </button>
```

- [ ] **Step 4: Render the modal**

Immediately before the final closing `</div>` of the component's outer return — i.e. after the main content `</div>` and before `</div></div>` that closes `.win`/`.stage` (the block ends at lines 612-615) — insert the modal render. Place it just after the closing `</div>` of the `{/* Main */}` column (line 612), so it sits inside `.win`:

```tsx
          {newWsOpen && ghRepo && (
            <NewWorkspaceModal
              branches={selfReviewBranches}
              defaultBranch={defaultBranch}
              ghRepo={ghRepo}
              prefillBranch={newWsBranch}
              onClose={() => setNewWsOpen(false)}
              onCreated={() => loadOverview(ghRepo.owner, ghRepo.repo)}
            />
          )}
```

`selfReviewBranches`, `defaultBranch`, `ghRepo`, and `loadOverview` are all already in scope in the component.

- [ ] **Step 5: Give `BranchRowCompact` a "Ready to share" button**

Change the `BranchRowCompact` signature to accept an optional callback, and add the button next to the existing Self-Review button. Replace the whole `BranchRowCompact` function (lines 991-1042) with:

```tsx
function BranchRowCompact({
  b,
  stats,
  onReadyToShare,
}: {
  b: BranchInfo;
  stats?: DiffStats;
  onReadyToShare?: (branch: string) => void;
}) {
  return (
    <div style={rowShell()}>
      <Icon name="branch" size={12} color="var(--gray-500)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            className="mono"
            style={{
              fontSize: 12,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {b.name}
          </span>
          {b.isHead && (
            <span className="badge badge-green" style={{ flex: '0 0 auto' }}>
              current
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--gray-500)',
            marginTop: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            overflow: 'hidden',
          }}
        >
          {stats && <DiffStat added={stats.added} removed={stats.removed} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {b.lastCommit ? `${b.lastCommit} · ` : ''}
            {relativeTimeFromEpoch(b.updatedAt)}
          </span>
        </div>
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => console.info('workspaces_self_review_stub', b.name)}
      >
        <Icon name="play" size={10} color="var(--gray-700)" /> Self-Review
      </button>
      {onReadyToShare && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onReadyToShare(b.name)}
        >
          <Icon name="plus" size={10} color="#fff" /> Ready to share
        </button>
      )}
    </div>
  );
}
```

Then pass the callback where `BranchRowCompact` is rendered (currently line 518). Replace that line with:

```tsx
                        <BranchRowCompact
                          key={b.name}
                          b={b}
                          stats={diffStats[b.name]}
                          onReadyToShare={ghRepo ? openNewWorkspace : undefined}
                        />
```

(`openNewWorkspace(branch)` matches the `(branch: string) => void` signature.)

- [ ] **Step 6: Add the `NewWorkspaceModal` and `Field` components**

Append these two functions at the end of `Workspaces.tsx` (after `OpenPrRowCompact`, line 1202):

```tsx
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gray-600)', marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </label>
  );
}

function NewWorkspaceModal({
  branches,
  defaultBranch,
  ghRepo,
  prefillBranch,
  onClose,
  onCreated,
}: {
  branches: BranchInfo[];
  defaultBranch: string | null;
  ghRepo: { owner: string; repo: string };
  prefillBranch?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [headRef, setHeadRef] = useState(prefillBranch ?? branches[0]?.name ?? '');
  const [baseRef, setBaseRef] = useState(defaultBranch ?? 'main');
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!headRef) {
      setError('Pick a branch to share.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await workspaceCreate({
        repoOwner: ghRepo.owner,
        repoName: ghRepo.repo,
        headRef,
        baseRef: baseRef.trim() || 'main',
        title: title.trim(),
      });
      onCreated();
      onClose();
    } catch (e) {
      // Fail loud (CLAUDE.md "Error handling"): surface the backend message
      // verbatim in the modal; never close on a swallowed error.
      console.warn('workspace_create_failed', e);
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close is supplementary; Cancel button + Esc-less modal is acceptable for this POC.
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New workspace"
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
          width: 420,
          background: '#fff',
          borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--sh-pop)',
          padding: 18,
        }}
      >
        <div
          style={{ fontSize: 15, fontWeight: 700, color: 'var(--gray-900)', marginBottom: 14 }}
        >
          New workspace
        </div>

        <Field label="Branch">
          <select
            className="input"
            value={headRef}
            onChange={(e) => setHeadRef(e.target.value)}
            style={{ width: '100%' }}
          >
            {branches.length === 0 && <option value="">No branches without a workspace</option>}
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Base">
          <input
            className="input"
            value={baseRef}
            onChange={(e) => setBaseRef(e.target.value)}
            placeholder="main"
            style={{ width: '100%' }}
          />
        </Field>

        <Field label="Title (optional)">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={headRef || 'Workspace title'}
            style={{ width: '100%' }}
          />
        </Field>

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
            Couldn't create workspace: {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={submitting || !headRef}
            style={{ opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Verify types + lint**

Run: `cd client && bun run typecheck && bun run lint`
Expected: PASS — `tsc -b --noEmit` clean and Biome clean. If Biome flags the backdrop `onMouseDown` without keyboard handler, the inline `biome-ignore` above covers it; if Biome reports a different rule id, adjust the ignore comment's rule name to match the reported one.

- [ ] **Step 8: Manual verification (run the app)**

Run: `cd client && just dev` (or from repo root `just client::dev`). Then:
1. Sign in → open a repo that has a GitHub remote.
2. Click **New workspace** (toolbar) → modal opens with the branch dropdown populated from Self-Review branches, Base prefilled to the default branch. Pick a branch, optionally type a title, click **Create**.
3. Expected: modal closes, the overview reloads, and the branch now appears under **Authored by you → Ready to share** (and disappears from Self-Review).
4. On a Self-Review branch row, click **Ready to share** → same modal opens with that branch preselected → Create → same result.
5. Create a workspace for a branch that already has one → red banner inside the modal with the backend's "Workspace already exists for that repo + head_ref" message; modal stays open.

- [ ] **Step 9: Commit**

```bash
git add client/src/screens/workspaces/Workspaces.tsx
git commit -m "$(cat <<'EOF'
feat(workspaces): wire New workspace + per-branch Ready to share

Shared NewWorkspaceModal (branch picker, base, optional title) opened
from the toolbar button and from a per-branch button on Self-Review
rows. On success re-runs loadOverview; on failure renders the backend
message in-modal. Disabled when the active repo has no GitHub remote.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Full verify pass

- [ ] **Step 1: Run the whole pipeline**

Run (from repo root): `just verify`
Expected: PASS — pre-commit (ruff + ruff-format + pyrefly + biome + cargo fmt + tsc + cargo check), then `just client::clippy`, `just client::test`, `just backend::test`, all green.

If pre-commit auto-fixes files, stage them and re-run:

```bash
git add -A
just verify
```

- [ ] **Step 2: Commit any auto-fixes (only if pre-commit changed files)**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: pre-commit auto-fixes for create-workspace wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (filled in by the plan author)

**Spec coverage:**
- A1 backend cache invalidation → Task 1. ✓
- B1 raw-JSON Rust SDK → Task 2. ✓
- Tauri command + registration → Task 3. ✓
- TS wrapper → Task 4. ✓
- Toolbar entry point (disabled when no GitHub remote) → Task 5 Steps 3-4. ✓
- Per-branch "Ready to share" entry point (prefilled branch) → Task 5 Steps 5. ✓
- Shared modal, branch picker over `selfReviewBranches`, base default = `defaultBranch`, optional title → Task 5 Step 6. ✓
- Post-create = refresh overview, no detail screen → Task 5 Step 4 (`onCreated` → `loadOverview`). ✓
- Fail-loud error surfacing in modal → Task 5 Step 6 (`catch` → banner). ✓
- No-GitHub-pre-check assumption → honored (create call never inspects GitHub). ✓
- Tests: backend cache test (Task 1), Rust SDK tests (Task 2). ✓
- Verify pipeline → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type consistency:** `workspaceCreate(input: WorkspaceCreateInput)` (Task 4) is called with `{repoOwner, repoName, headRef, baseRef, title}` (Task 5). Rust `workspace_create(token, repo_owner, repo_name, head_ref, base_ref, title)` (Task 2) matches the command params (Task 3) and the JSON body matches `WorkspaceCreateInputSerializer` field names (`repo_owner, repo_name, head_ref, base_ref, title`). `onReadyToShare: (branch: string) => void` matches `openNewWorkspace(branch?: string)`. ✓
