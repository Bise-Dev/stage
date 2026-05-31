# Storyline Composition v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Workspace author build a Storyline before any PR exists — list the branch's changed files from local git, curate which become ordered steps, and write a markdown intro per step — persisting through the existing backend storyline endpoints.

**Architecture:** Client-only. New local-git Tauri command lists changed files; new Rust SDK methods call the already-built `GET`/`PUT /api/v1/workspaces/{id}/storyline/`; a new React screen reconciles "changed files now" with "saved steps" and edits them. Backend unchanged.

**Tech Stack:** Rust (`git2` 0.19, `reqwest`, Tauri 2 commands, `wiremock`+`tempfile` tests), React 19 + TypeScript (Vite, `react-markdown`+`remark-gfm`). Spec: `docs/superpowers/specs/2026-05-30-storyline-composition-v1-design.md`.

**Conventions (from `CLAUDE.md` / `client/STACK.md`):**
- Fail loud: Rust returns `AppError` naming the cause; TS surfaces `e.message` verbatim in a red banner; no silent fallbacks.
- Verify after each task: `just client::check` (tsc + cargo check) and the task's tests. Full gate before done: `just pre-commit`, `just client::clippy`, `just client::test`.
- Bun, not npm (no `nvm` needed). Biome for TS lint/format.

---

## Task 1: `git::diff_files` — list changed files via local git

**Files:**
- Modify: `client/src-tauri/Cargo.toml` (add `tempfile` dev-dep)
- Modify: `client/src-tauri/src/git.rs` (add `ChangedFile` + `diff_files` + tests)

- [ ] **Step 1: Add the `tempfile` dev-dependency**

In `client/src-tauri/Cargo.toml`, change the `[dev-dependencies]` block:

```toml
[dev-dependencies]
wiremock = "0.6"
tempfile = "3"
```

- [ ] **Step 2: Write the failing test**

Append to `client/src-tauri/src/git.rs`:

```rust
#[cfg(test)]
mod tests {
    use std::fs;

    use git2::{IndexAddOption, Repository, Signature};

    use super::*;

    fn commit_all(repo: &Repository, msg: &str, parent: Option<git2::Oid>) -> git2::Oid {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("t", "t@example.com").unwrap();
        let parents: Vec<git2::Commit> =
            parent.map(|p| repo.find_commit(p).unwrap()).into_iter().collect();
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs)
            .unwrap()
    }

    #[test]
    fn diff_files_lists_added_modified_and_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();

        fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        fs::write(dir.path().join("gone.txt"), "bye\n").unwrap();
        let base = commit_all(&repo, "base", None);

        fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap(); // modify
        fs::write(dir.path().join("b.txt"), "hello\n").unwrap(); // add
        fs::remove_file(dir.path().join("gone.txt")).unwrap(); // delete
        let head = commit_all(&repo, "head", Some(base));

        let files = diff_files(dir.path(), &base.to_string(), &head.to_string()).unwrap();
        let mut got: Vec<(&str, &str)> =
            files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect();
        got.sort();
        assert_eq!(got, vec![("a.txt", "M"), ("b.txt", "A"), ("gone.txt", "D")]);

        let b = files.iter().find(|f| f.path == "b.txt").unwrap();
        assert_eq!(b.added, 1);
        assert_eq!(b.removed, 0);
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd client/src-tauri && cargo test diff_files_lists`
Expected: FAIL — `cannot find function `diff_files`` (and `ChangedFile` unresolved).

- [ ] **Step 4: Implement `ChangedFile` + `diff_files`**

Add to `client/src-tauri/src/git.rs` (after `diff_stats`, before `FetchOutcome`). It mirrors `diff_stats`' ref resolution exactly, then walks per-file deltas. Per-file line counts come from `Patch`; binary files (no patch) report `0/0`. Fail-loud on any unreadable delta/path (CLAUDE.md "Error handling"):

```rust
#[derive(Serialize)]
pub struct ChangedFile {
    pub path: String,
    /// One of "A" added, "M" modified, "D" deleted, "R" renamed, "C" copied, "?" other.
    pub status: String,
    pub added: usize,
    pub removed: usize,
}

/// Files changed in `head_ref` since it diverged from `base_ref` (merge-base
/// tree → head tree), with per-file +/− counts. Same resolution as
/// [`diff_stats`]; here we enumerate per-file deltas instead of aggregating.
///
/// Rename detection is intentionally off (no `find_similar`): a rename surfaces
/// as a delete + add pair, which is fine for v1's file-ordering UI. Fail-loud
/// per CLAUDE.md: an unreadable delta/path fails the whole call naming the
/// offending index rather than silently dropping a file the user can't see.
pub fn diff_files(repo_path: &Path, base_ref: &str, head_ref: &str) -> Result<Vec<ChangedFile>, AppError> {
    let repo = Repository::open(repo_path)?;
    let base_commit = repo.revparse_single(base_ref)?.peel_to_commit()?;
    let head_commit = repo.revparse_single(head_ref)?.peel_to_commit()?;
    let merge_base = repo.merge_base(base_commit.id(), head_commit.id())?;
    let base_tree = repo.find_commit(merge_base)?.tree()?;
    let head_tree = head_commit.tree()?;
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), None)?;

    let mut out = Vec::new();
    for (idx, delta) in diff.deltas().enumerate() {
        let status = match delta.status() {
            git2::Delta::Added => "A",
            git2::Delta::Deleted => "D",
            git2::Delta::Modified => "M",
            git2::Delta::Renamed => "R",
            git2::Delta::Copied => "C",
            _ => "?",
        }
        .to_string();
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .and_then(|p| p.to_str())
            .ok_or_else(|| {
                AppError::Backend(format!("diff_files: non-UTF-8 or missing path at delta {idx}"))
            })?
            .to_string();
        let (added, removed) = match git2::Patch::from_diff(&diff, idx) {
            Ok(Some(patch)) => {
                let (_context, additions, deletions) = patch.line_stats().map_err(|e| {
                    AppError::Backend(format!("diff_files: line stats for '{path}' failed: {e}"))
                })?;
                (additions, deletions)
            }
            Ok(None) => (0, 0), // binary or no textual patch
            Err(e) => {
                return Err(AppError::Backend(format!(
                    "diff_files: patch failed for '{path}': {e}"
                )))
            }
        };
        out.push(ChangedFile {
            path,
            status,
            added,
            removed,
        });
    }
    Ok(out)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client/src-tauri && cargo test diff_files_lists`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add client/src-tauri/Cargo.toml client/src-tauri/Cargo.lock client/src-tauri/src/git.rs
git commit -m "feat(client): git::diff_files — list changed files for a branch vs base"
```

---

## Task 2: `git_diff_files` Tauri command + TS wrapper

**Files:**
- Modify: `client/src-tauri/src/commands.rs` (add command)
- Modify: `client/src-tauri/src/lib.rs:77-97` (register in `generate_handler!`)
- Modify: `client/src/tauri.ts` (wrapper + `ChangedFile` type)

- [ ] **Step 1: Add the command**

In `client/src-tauri/src/commands.rs`, after `git_diff_stats` (ends at line 97), add — copying the active-repo-lock boilerplate verbatim:

```rust
#[tauri::command]
pub fn git_diff_files(
    state: State<'_, AppState>,
    base_ref: String,
    head_ref: String,
) -> Result<Vec<git::ChangedFile>, AppError> {
    let path = state
        .active
        .lock()
        .as_ref()
        .map(|a| a.path.clone())
        .ok_or(AppError::NoActiveRepo)?;
    git::diff_files(&path, &base_ref, &head_ref)
}
```

- [ ] **Step 2: Register the command**

In `client/src-tauri/src/lib.rs`, add to the `tauri::generate_handler![...]` list (after `commands::git_diff_stats,` on line 85):

```rust
            commands::git_diff_files,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd client/src-tauri && cargo check`
Expected: compiles clean (no warnings about unused command).

- [ ] **Step 4: Add the TS wrapper + type**

In `client/src/tauri.ts`, after the `gitDiffStats` block (line 37), add:

```ts
export type ChangedFile = {
  path: string;
  /** "A" added · "M" modified · "D" deleted · "R" renamed · "C" copied · "?" other. */
  status: string;
  added: number;
  removed: number;
};
export const gitDiffFiles = (baseRef: string, headRef: string) =>
  invoke<ChangedFile[]>('git_diff_files', { baseRef, headRef });
```

- [ ] **Step 5: Typecheck**

Run: `cd client && bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 6: Commit**

```bash
git add client/src-tauri/src/commands.rs client/src-tauri/src/lib.rs client/src/tauri.ts
git commit -m "feat(client): git_diff_files Tauri command + TS wrapper"
```

---

## Task 3: Storyline SDK DTOs

**Files:**
- Modify: `client/src-tauri/src/api/types.rs` (add 3 structs + tests)
- Modify: `client/src-tauri/src/api/mod.rs:14` (export)

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `client/src-tauri/src/api/types.rs` (inside the existing `#[cfg(test)] mod tests { ... }`, before its closing brace):

```rust
    #[test]
    fn storyline_dto_deserializes_backend_payload() {
        let json = serde_json::json!({
            "etag": "e1",
            "head_sha": null,
            "files": [
                {
                    "id": "11111111-1111-1111-1111-111111111111",
                    "diff_file_path": "src/a.py",
                    "order_index": 0,
                    "title": "",
                    "intro_text": "why a",
                    "stale": false,
                    "stale_reason": null
                }
            ]
        });
        let dto: StorylineDto = serde_json::from_value(json).unwrap();
        assert_eq!(dto.etag, "e1");
        assert!(dto.head_sha.is_none());
        assert_eq!(dto.files.len(), 1);
        assert_eq!(dto.files[0].diff_file_path, "src/a.py");
        assert_eq!(dto.files[0].intro_text, "why a");
    }

    #[test]
    fn storyline_file_write_reads_camelcase_from_webview() {
        let json = serde_json::json!({
            "diffFilePath": "src/a.py",
            "orderIndex": 2,
            "introText": "note"
        });
        let w: StorylineFileWrite = serde_json::from_value(json).unwrap();
        assert_eq!(w.diff_file_path, "src/a.py");
        assert_eq!(w.order_index, 2);
        assert_eq!(w.intro_text, "note");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client/src-tauri && cargo test storyline_dto storyline_file_write`
Expected: FAIL — `StorylineDto` / `StorylineFileWrite` not found.

- [ ] **Step 3: Add the structs**

In `client/src-tauri/src/api/types.rs`, add before the `#[cfg(test)]` module. `StorylineDto`/`StorylineFileDto` are snake_case both directions (backend → command → webview, matching the existing `OverviewWorkspaceRow` snake_case convention in `tauri.ts`). `StorylineFileWrite` is the webview→command input, camelCase to match the app's `invoke` arg convention:

```rust
/// One storyline step as returned by GET/PUT `/workspaces/{id}/storyline/`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct StorylineFileDto {
    pub id: String,
    pub diff_file_path: String,
    pub order_index: i64,
    pub title: String,
    pub intro_text: String,
    pub stale: bool,
    pub stale_reason: Option<String>,
}

/// The full storyline payload (`storyline_read` shape). `etag` drives optimistic
/// concurrency on PUT; `head_sha` is null pre-publish.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct StorylineDto {
    pub etag: String,
    pub head_sha: Option<String>,
    pub files: Vec<StorylineFileDto>,
}

/// One step as sent from the webview into the `storyline_update` command.
/// camelCase on the wire (webview convention); the SDK maps it to the backend's
/// snake_case body explicitly (see `Client::storyline_update`).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorylineFileWrite {
    pub diff_file_path: String,
    pub order_index: i64,
    pub intro_text: String,
}
```

- [ ] **Step 4: Export from the api module**

In `client/src-tauri/src/api/mod.rs`, extend the `pub use types::{...}` line (line 14):

```rust
pub use types::{
    GithubPrSearchItem, SessionData, StorylineDto, StorylineFileDto, StorylineFileWrite, User,
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd client/src-tauri && cargo test storyline_dto storyline_file_write`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src-tauri/src/api/types.rs client/src-tauri/src/api/mod.rs
git commit -m "feat(client): storyline SDK DTOs (StorylineDto/StorylineFileDto/StorylineFileWrite)"
```

---

## Task 4: SDK `Client::storyline_get`

**Files:**
- Modify: `client/src-tauri/src/api/workspaces.rs` (add method + wiremock test)

- [ ] **Step 1: Write the failing test**

In `client/src-tauri/src/api/workspaces.rs`, inside the `#[cfg(test)] mod tests`, add (and extend the `use` line at the top of the test module to include `StorylineDto` — see Step 3):

```rust
    #[tokio::test]
    async fn storyline_get_ok() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(
                "/api/v1/workspaces/11111111-1111-1111-1111-111111111111/storyline/",
            ))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "etag": "e1",
                "head_sha": null,
                "files": [{
                    "id": "22222222-2222-2222-2222-222222222222",
                    "diff_file_path": "src/a.py",
                    "order_index": 0,
                    "title": "",
                    "intro_text": "why",
                    "stale": false,
                    "stale_reason": null
                }]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let dto = client
            .storyline_get("stg_abc", "11111111-1111-1111-1111-111111111111")
            .await
            .unwrap();
        assert_eq!(dto.etag, "e1");
        assert_eq!(dto.files.len(), 1);
        assert_eq!(dto.files[0].diff_file_path, "src/a.py");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client/src-tauri && cargo test storyline_get_ok`
Expected: FAIL — no method `storyline_get`.

- [ ] **Step 3: Implement the method + import the DTO**

In `client/src-tauri/src/api/workspaces.rs`, change the top imports (lines 1-2) to bring the DTO into scope:

```rust
use super::client::Client;
use super::error::Error;
use super::types::StorylineDto;
```

Add inside `impl Client` (after `workspace_delete`, before the closing `}` of the impl at line 53):

```rust
    /// Read a workspace's storyline. GET /api/v1/workspaces/{id}/storyline/.
    /// `etag` in the returned body drives optimistic concurrency on update.
    pub async fn storyline_get(&self, token: &str, workspace_id: &str) -> Result<StorylineDto, Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/workspaces/{workspace_id}/storyline/"))
            .unwrap();
        let resp = self.http.get(url).bearer_auth(token).send().await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }
```

Also add `header_exists` to the test module's `use wiremock::matchers::{...}` if it is not already imported (it is, per line 57).

- [ ] **Step 4: Run to verify it passes**

Run: `cd client/src-tauri && cargo test storyline_get_ok`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src-tauri/src/api/workspaces.rs
git commit -m "feat(client): SDK Client::storyline_get"
```

---

## Task 5: SDK `Client::storyline_update`

**Files:**
- Modify: `client/src-tauri/src/api/workspaces.rs` (add method + wiremock test)

- [ ] **Step 1: Write the failing test**

In the `tests` module of `client/src-tauri/src/api/workspaces.rs`, add. It asserts the `If-Match` header is sent and the request body carries the steps in snake_case, and that the new etag round-trips:

```rust
    #[tokio::test]
    async fn storyline_update_sends_if_match_and_snake_case_body() {
        use crate::api::types::StorylineFileWrite;
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path(
                "/api/v1/workspaces/11111111-1111-1111-1111-111111111111/storyline/",
            ))
            .and(header_exists("authorization"))
            .and(header_exists("if-match"))
            .and(body_partial_json(serde_json::json!({
                "files": [{ "diff_file_path": "src/a.py", "order_index": 0, "intro_text": "why" }]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "etag": "e2",
                "head_sha": null,
                "files": [{
                    "id": "22222222-2222-2222-2222-222222222222",
                    "diff_file_path": "src/a.py",
                    "order_index": 0,
                    "title": "",
                    "intro_text": "why",
                    "stale": false,
                    "stale_reason": null
                }]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let files = vec![StorylineFileWrite {
            diff_file_path: "src/a.py".into(),
            order_index: 0,
            intro_text: "why".into(),
        }];
        let dto = client
            .storyline_update("stg_abc", "11111111-1111-1111-1111-111111111111", "e1", &files)
            .await
            .unwrap();
        assert_eq!(dto.etag, "e2");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client/src-tauri && cargo test storyline_update_sends`
Expected: FAIL — no method `storyline_update`.

- [ ] **Step 3: Implement the method**

In `client/src-tauri/src/api/workspaces.rs`, change the imports line to also bring in the write struct:

```rust
use super::types::{StorylineDto, StorylineFileWrite};
```

Add inside `impl Client` (after `storyline_get`). It builds the backend's snake_case body explicitly from the camelCase input struct and sends `If-Match`:

```rust
    /// Replace a workspace's storyline. PUT /api/v1/workspaces/{id}/storyline/
    /// with `If-Match: <etag>` (optimistic concurrency; 409 etag_mismatch on
    /// stale etag, 412 if the header is missing). Returns the re-read payload
    /// with the freshly minted etag.
    pub async fn storyline_update(
        &self,
        token: &str,
        workspace_id: &str,
        etag: &str,
        files: &[StorylineFileWrite],
    ) -> Result<StorylineDto, Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/workspaces/{workspace_id}/storyline/"))
            .unwrap();
        let body = serde_json::json!({
            "files": files
                .iter()
                .map(|f| serde_json::json!({
                    "diff_file_path": f.diff_file_path,
                    "order_index": f.order_index,
                    "intro_text": f.intro_text,
                }))
                .collect::<Vec<_>>(),
        });
        let resp = self
            .http
            .put(url)
            .bearer_auth(token)
            .header("If-Match", etag)
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client/src-tauri && cargo test storyline_update_sends`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src-tauri/src/api/workspaces.rs
git commit -m "feat(client): SDK Client::storyline_update (If-Match, snake_case body)"
```

---

## Task 6: storyline Tauri commands + TS wrappers

**Files:**
- Modify: `client/src-tauri/src/commands.rs` (2 commands)
- Modify: `client/src-tauri/src/lib.rs` (register both)
- Modify: `client/src/tauri.ts` (2 wrappers + 3 types)

- [ ] **Step 1: Add the commands**

In `client/src-tauri/src/commands.rs`, after `workspace_delete` (ends line 244), add:

```rust
#[tauri::command]
pub async fn storyline_get(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<api::StorylineDto, AppError> {
    let token = state.require_token()?;
    let dto = state.api.storyline_get(&token, &workspace_id).await?;
    Ok(dto)
}

#[tauri::command]
pub async fn storyline_update(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
    etag: String,
    files: Vec<api::StorylineFileWrite>,
) -> Result<api::StorylineDto, AppError> {
    let token = state.require_token()?;
    let dto = state
        .api
        .storyline_update(&token, &workspace_id, &etag, &files)
        .await?;
    Ok(dto)
}
```

- [ ] **Step 2: Register both commands**

In `client/src-tauri/src/lib.rs`, add to `generate_handler![...]` (after `commands::workspace_delete,`):

```rust
            commands::storyline_get,
            commands::storyline_update,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd client/src-tauri && cargo check`
Expected: compiles clean.

- [ ] **Step 4: Add the TS wrappers + types**

In `client/src/tauri.ts`, at the end of the `// --- Workspaces ---` section (after `workspaceDelete`, line 140), add. Note the `workspaceCreate` return type is widened from `unknown` to `WorkspaceCreated` so the create flow can navigate to the new workspace's storyline (Task 10):

```ts
// --- Storyline ---
// Returned by GET/PUT .../storyline/ (snake_case — matches OverviewRow convention).
export type StorylineFile = {
  id: string;
  diff_file_path: string;
  order_index: number;
  title: string;
  intro_text: string;
  stale: boolean;
  stale_reason: string | null;
};
export type Storyline = {
  etag: string;
  head_sha: string | null;
  files: StorylineFile[];
};
// One step sent into storyline_update (camelCase — invoke arg convention).
export type StorylineFileWrite = {
  diffFilePath: string;
  orderIndex: number;
  introText: string;
};

export const storylineGet = (workspaceId: string) =>
  invoke<Storyline>('storyline_get', { workspaceId });

export const storylineUpdate = (workspaceId: string, etag: string, files: StorylineFileWrite[]) =>
  invoke<Storyline>('storyline_update', { workspaceId, etag, files });
```

Then change the `workspaceCreate` declaration (lines 134-137) to a typed return:

```ts
// The created workspace (subset of WorkspaceOutputSerializer we use to navigate
// straight into storyline composition). The caller also re-fetches the overview.
export type WorkspaceCreated = {
  id: string;
  repo_owner: string;
  repo_name: string;
  head_ref: string;
  base_ref: string;
  title: string;
};
export const workspaceCreate = (input: WorkspaceCreateInput) =>
  invoke<WorkspaceCreated>('workspace_create', input);
```

- [ ] **Step 5: Typecheck**

Run: `cd client && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src-tauri/src/commands.rs client/src-tauri/src/lib.rs client/src/tauri.ts
git commit -m "feat(client): storyline_get/storyline_update Tauri commands + TS wrappers"
```

---

## Task 7: Markdown render component

**Files:**
- Modify: `client/package.json` + `client/bun.lock` (add deps)
- Create: `client/src/components/Markdown.tsx`

- [ ] **Step 1: Look up the current API**

Before coding, fetch current `react-markdown` + `remark-gfm` usage via Context7 (`resolve-library-id` → `query-docs` for "react-markdown remark-gfm basic usage props"). Confirm: the markdown source is passed as `children` and GFM is enabled via `remarkPlugins={[remarkGfm]}` (react-markdown v9 API). Adjust Step 3 if the API differs.

- [ ] **Step 2: Install the deps**

Run: `cd client && bun add react-markdown remark-gfm`
Expected: both added to `dependencies`; `bun.lock` updated.

- [ ] **Step 3: Create the component**

Create `client/src/components/Markdown.tsx`. A thin wrapper (chosen over `marked`→HTML so the AST stays available for the future line-reference feature — see spec §10). Safe-by-default: react-markdown does not render raw HTML.

```tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Render an author's storyline intro (markdown). GFM enabled (lists, tables,
 * strikethrough). Raw HTML is NOT rendered — react-markdown is safe by default. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd client && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/package.json client/bun.lock client/src/components/Markdown.tsx
git commit -m "feat(client): Markdown render component (react-markdown + remark-gfm)"
```

---

## Task 8: `reconcile` — merge saved steps with current changed files

**Files:**
- Create: `client/src/screens/storyline/reconcile.ts`

This is the one piece of non-trivial client logic; keep it a pure, exported function so it is verifiable in isolation (a `vitest` setup is a sensible follow-up; not added in v1).

- [ ] **Step 1: Create the function**

Create `client/src/screens/storyline/reconcile.ts`:

```ts
import type { ChangedFile, StorylineFile } from '../../tauri';

/** One editable storyline step in the composition screen. */
export type Step = {
  path: string;
  introText: string;
  /** Current-diff metadata; null when the saved step's file is no longer in the diff. */
  status: string | null;
  added: number | null;
  removed: number | null;
  /** True when this saved step's file no longer appears in the branch diff. */
  stale: boolean;
};

export type Reconciled = {
  /** Included steps, in saved order. */
  steps: Step[];
  /** Changed files not yet promoted to a step. */
  pool: ChangedFile[];
};

/** Merge the saved storyline (paths + intros + order) with the files currently
 * changed on the branch. Saved steps keep their order and intro; ones whose file
 * vanished from the diff are surfaced as `stale` (never silently dropped — the
 * author removes them). Remaining changed files form the pool to add from. */
export function reconcile(changed: ChangedFile[], saved: StorylineFile[]): Reconciled {
  const byPath = new Map(changed.map((c) => [c.path, c]));
  const ordered = [...saved].sort((a, b) => a.order_index - b.order_index);
  const steps: Step[] = ordered.map((s) => {
    const c = byPath.get(s.diff_file_path);
    return {
      path: s.diff_file_path,
      introText: s.intro_text,
      status: c ? c.status : null,
      added: c ? c.added : null,
      removed: c ? c.removed : null,
      stale: !c,
    };
  });
  const taken = new Set(ordered.map((s) => s.diff_file_path));
  const pool = changed.filter((c) => !taken.has(c.path));
  return { steps, pool };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd client && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/screens/storyline/reconcile.ts
git commit -m "feat(client): storyline reconcile (saved steps ⊕ current changed files)"
```

---

## Task 9: Storyline composition screen

**Files:**
- Create: `client/src/screens/storyline/Storyline.tsx`

- [ ] **Step 1: Create the screen**

Create `client/src/screens/storyline/Storyline.tsx`. Two zones: LEFT pool + ordered steps (add / remove / ▲▼ reorder / select); MAIN markdown editor + live preview for the selected step. Footer shows completeness + Save. Fail-loud banners reuse the red-banner style from `Workspaces.tsx`.

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { TitleBar } from '../../components/TitleBar';
import {
  type ChangedFile,
  gitDiffFiles,
  storylineGet,
  storylineUpdate,
} from '../../tauri';
import { reconcile, type Step } from './reconcile';

export type StorylineCtx = {
  workspaceId: string;
  owner: string;
  repo: string;
  headRef: string;
  baseRef: string;
  title: string;
};

const banner: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--red-d)',
  background: 'rgba(255,59,48,0.08)',
  border: '1px solid rgba(255,59,48,0.20)',
  borderRadius: 'var(--r-sm)',
  padding: '6px 10px',
  marginBottom: 10,
};

function msgOf(e: unknown): string {
  return typeof e === 'object' && e !== null && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);
}

export function Storyline({ ctx, onBack }: { ctx: StorylineCtx; onBack: () => void }) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [pool, setPool] = useState<ChangedFile[]>([]);
  const [etag, setEtag] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [changed, storyline] = await Promise.all([
        gitDiffFiles(ctx.baseRef, ctx.headRef),
        storylineGet(ctx.workspaceId),
      ]);
      const { steps: s, pool: p } = reconcile(changed, storyline.files);
      setSteps(s);
      setPool(p);
      setEtag(storyline.etag);
      setSelected((cur) => cur ?? s[0]?.path ?? null);
    } catch (e) {
      // Fail loud (CLAUDE.md): surface the cause; no empty-state fallback.
      console.warn('storyline_load_failed', e);
      setLoadError(msgOf(e));
    }
  }, [ctx.baseRef, ctx.headRef, ctx.workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  const addStep = (path: string) => {
    const c = pool.find((f) => f.path === path);
    if (!c) return;
    setPool((p) => p.filter((f) => f.path !== path));
    setSteps((s) => [
      ...s,
      { path: c.path, introText: '', status: c.status, added: c.added, removed: c.removed, stale: false },
    ]);
    setSelected(path);
  };

  const removeStep = (path: string) => {
    const step = steps.find((s) => s.path === path);
    setSteps((s) => s.filter((x) => x.path !== path));
    // Non-stale steps return to the pool; stale ones have no ChangedFile to restore.
    if (step && !step.stale) {
      setPool((p) =>
        [...p, { path: step.path, status: step.status ?? '?', added: step.added ?? 0, removed: step.removed ?? 0 }].sort(
          (a, b) => a.path.localeCompare(b.path),
        ),
      );
    }
    setSelected((cur) => (cur === path ? null : cur));
  };

  const move = (idx: number, delta: number) => {
    setSteps((s) => {
      const j = idx + delta;
      if (j < 0 || j >= s.length) return s;
      const next = [...s];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const setIntro = (path: string, text: string) => {
    setSteps((s) => s.map((x) => (x.path === path ? { ...x, introText: text } : x)));
  };

  const save = async () => {
    if (etag === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await storylineUpdate(
        ctx.workspaceId,
        etag,
        steps.map((s, i) => ({ diffFilePath: s.path, orderIndex: i, introText: s.introText })),
      );
      setEtag(result.etag);
    } catch (e) {
      // Fail loud: surface the backend message verbatim. On an etag conflict the
      // author can reload via Back; v1 does not auto-merge concurrent edits.
      console.warn('storyline_save_failed', e);
      setSaveError(msgOf(e));
    } finally {
      setSaving(false);
    }
  };

  const withIntro = useMemo(() => steps.filter((s) => s.introText.trim().length > 0).length, [steps]);
  const selectedStep = steps.find((s) => s.path === selected) ?? null;

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title={`Stage — Storyline · ${ctx.headRef}`} />
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 18px',
              borderBottom: '1px solid var(--hairline)',
            }}
          >
            <button type="button" className="btn" onClick={onBack}>
              <Icon name="chevron-left" size={10} color="var(--gray-700)" /> Workspaces
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gray-900)' }}>
                {ctx.title || ctx.headRef}
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--gray-500)' }}>
                {ctx.baseRef} → {ctx.headRef}
              </div>
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
              {withIntro} of {steps.length} steps have intros
            </span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={save}
              disabled={saving || etag === null}
              style={{ opacity: saving ? 0.6 : 1 }}
            >
              {saving ? 'Saving…' : 'Save storyline'}
            </button>
          </div>

          <div style={{ padding: '10px 18px 0' }}>
            {loadError && <div style={banner}>Couldn't load storyline: {loadError}</div>}
            {saveError && <div style={banner}>Couldn't save storyline: {saveError}</div>}
          </div>

          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            {/* LEFT: pool + ordered steps */}
            <div
              style={{
                width: 320,
                flex: '0 0 320px',
                borderRight: '1px solid var(--hairline)',
                overflow: 'auto',
                padding: '12px 14px',
              }}
            >
              <div className="section-label">Changed files ({pool.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
                {pool.length === 0 && (
                  <div style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
                    All changed files are in the storyline.
                  </div>
                )}
                {pool.map((f) => (
                  <div key={f.path} style={rowShell()}>
                    <span className="badge" style={{ flex: '0 0 auto' }}>
                      {f.status}
                    </span>
                    <span className="mono" style={ellipsis}>
                      {f.path}
                    </span>
                    <button type="button" className="btn btn-primary" onClick={() => addStep(f.path)}>
                      <Icon name="plus" size={10} color="#fff" /> Add
                    </button>
                  </div>
                ))}
              </div>

              <div className="section-label">Storyline ({steps.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {steps.length === 0 && (
                  <div style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
                    Add files above to build the storyline.
                  </div>
                )}
                {steps.map((s, i) => (
                  <button
                    key={s.path}
                    type="button"
                    onClick={() => setSelected(s.path)}
                    style={{
                      ...rowShell(),
                      cursor: 'default',
                      textAlign: 'left',
                      outline: selected === s.path ? '2px solid var(--blue)' : 'none',
                    }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray-500)', flex: '0 0 auto' }}>
                      {i + 1}
                    </span>
                    <span
                      title={s.introText.trim() ? 'has intro' : 'no intro yet'}
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 4,
                        flex: '0 0 auto',
                        background: s.introText.trim() ? 'var(--green)' : 'var(--gray-300)',
                      }}
                    />
                    <span className="mono" style={ellipsis}>
                      {s.path}
                    </span>
                    {s.stale && (
                      <span className="badge badge-orange" style={{ flex: '0 0 auto' }} title="File no longer changed">
                        stale
                      </span>
                    )}
                    <span style={{ display: 'flex', gap: 2, flex: '0 0 auto' }}>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="Move up"
                        className="btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          move(i, -1);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') move(i, -1);
                        }}
                      >
                        ▲
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="Move down"
                        className="btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          move(i, 1);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') move(i, 1);
                        }}
                      >
                        ▼
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="Remove step"
                        className="btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeStep(s.path);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') removeStep(s.path);
                        }}
                      >
                        ×
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* MAIN: editor + preview */}
            <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '14px 18px' }}>
              {!selectedStep && (
                <div style={{ fontSize: 12.5, color: 'var(--gray-500)' }}>
                  Select a step to write its intro.
                </div>
              )}
              {selectedStep && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="badge">{selectedStep.status ?? '—'}</span>
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
                      {selectedStep.path}
                    </span>
                    {selectedStep.added !== null && selectedStep.removed !== null && (
                      <span style={{ fontSize: 11 }}>
                        <span style={{ color: 'var(--green-d)' }}>+{selectedStep.added}</span>{' '}
                        <span style={{ color: 'var(--red-d)' }}>−{selectedStep.removed}</span>
                      </span>
                    )}
                  </div>
                  <div className="section-label">Intro for reviewers (markdown)</div>
                  <textarea
                    className="input"
                    value={selectedStep.introText}
                    onChange={(e) => setIntro(selectedStep.path, e.target.value)}
                    placeholder="Why this file matters, what to look at first…"
                    style={{ width: '100%', minHeight: 120, fontFamily: 'inherit', resize: 'vertical' }}
                  />
                  <div className="section-label">Preview</div>
                  <div
                    style={{
                      border: '1px solid var(--hairline)',
                      borderRadius: 'var(--r-md)',
                      padding: '10px 12px',
                      minHeight: 60,
                      background: '#fff',
                    }}
                  >
                    {selectedStep.introText.trim() ? (
                      <Markdown>{selectedStep.introText}</Markdown>
                    ) : (
                      <span style={{ fontSize: 11.5, color: 'var(--gray-400)' }}>no intro yet</span>
                    )}
                  </div>
                  {/* Per-file diff renders here next slice (spec §10). */}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const ellipsis: React.CSSProperties = {
  flex: 1,
  fontSize: 12,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

function rowShell(): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: '#fff',
    border: '1px solid var(--hairline)',
    borderRadius: 'var(--r-md)',
    padding: '6px 8px',
    boxShadow: 'var(--sh-1)',
    minWidth: 0,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd client && bun run typecheck`
Expected: PASS. (The screen is not yet reachable; Task 10 wires navigation.)

- [ ] **Step 3: Commit**

```bash
git add client/src/screens/storyline/Storyline.tsx
git commit -m "feat(client): storyline composition screen (curate, order, markdown intros)"
```

---

## Task 10: Wire navigation + entry points

**Files:**
- Modify: `client/src/App.tsx` (add `'storyline'` view + context)
- Modify: `client/src/screens/workspaces/Workspaces.tsx` (thread `onOpenStoryline`; row button + post-create navigate)

- [ ] **Step 1: Add the storyline view to `App.tsx`**

Replace `client/src/App.tsx` entirely with:

```tsx
import { useCallback, useState } from 'react';

import { OpenRepository } from './screens/onboarding/OpenRepository';
import { SignIn } from './screens/onboarding/SignIn';
import { Storyline, type StorylineCtx } from './screens/storyline/Storyline';
import { Workspaces } from './screens/workspaces/Workspaces';
import type { User } from './tauri';

type View = 'signIn' | 'openRepo' | 'workspace' | 'storyline';

export function App() {
  const [view, setView] = useState<View>('signIn');
  const [user, setUser] = useState<User | null>(null);
  const [hasRepo, setHasRepo] = useState(false);
  const [storylineCtx, setStorylineCtx] = useState<StorylineCtx | null>(null);

  const onAuthenticated = useCallback((u: User) => {
    setUser(u);
    setView('openRepo');
  }, []);

  const onRepoOpened = useCallback(() => {
    setHasRepo(true);
    setView('workspace');
  }, []);

  const changeRepo = useCallback(() => setView('openRepo'), []);

  const openStoryline = useCallback((ctx: StorylineCtx) => {
    setStorylineCtx(ctx);
    setView('storyline');
  }, []);

  const backToWorkspaces = useCallback(() => {
    setStorylineCtx(null);
    setView('workspace');
  }, []);

  if (view === 'signIn') return <SignIn onAuthenticated={onAuthenticated} />;
  if (view === 'openRepo') {
    return (
      <OpenRepository
        onOpened={onRepoOpened}
        onBack={hasRepo ? () => setView('workspace') : undefined}
      />
    );
  }
  if (!user) {
    return null;
  }
  if (view === 'storyline' && storylineCtx) {
    return <Storyline ctx={storylineCtx} onBack={backToWorkspaces} />;
  }
  return <Workspaces user={user} onChangeRepo={changeRepo} onOpenStoryline={openStoryline} />;
}
```

- [ ] **Step 2: Accept + thread `onOpenStoryline` in `Workspaces`**

In `client/src/screens/workspaces/Workspaces.tsx`:

(a) Extend imports from `../../tauri` (the existing import block, lines 6-24) to add the storyline ctx type — add this import near the top of the file (after the existing imports):

```tsx
import type { StorylineCtx } from '../storyline/Storyline';
```

(b) Change the component signature (lines 57-63) to accept the callback:

```tsx
export function Workspaces({
  user,
  onChangeRepo,
  onOpenStoryline,
}: {
  user: User;
  onChangeRepo: () => void;
  onOpenStoryline: (ctx: StorylineCtx) => void;
}) {
```

- [ ] **Step 3: Navigate after create**

In the `NewWorkspaceModal` render inside `Workspaces` (lines 656-665), the modal already calls `onCreated()`. Change the `onCreated` prop passed from the parent to capture the created workspace and open its storyline. Replace the `<NewWorkspaceModal ... onCreated={...} />` block with:

```tsx
        {newWsOpen && ghRepo && (
          <NewWorkspaceModal
            branches={selfReviewBranches}
            defaultBranch={defaultBranch}
            ghRepo={ghRepo}
            prefillBranch={newWsBranch}
            onClose={() => setNewWsOpen(false)}
            onCreated={(created) =>
              onOpenStoryline({
                workspaceId: created.id,
                owner: created.repo_owner,
                repo: created.repo_name,
                headRef: created.head_ref,
                baseRef: created.base_ref,
                title: created.title,
              })
            }
          />
        )}
```

Then update `NewWorkspaceModal`'s `onCreated` type + call. Change its prop type (line 1384) and the `submit` body (lines 1399-1410):

```tsx
  onClose: () => void;
  onCreated: (created: WorkspaceCreated) => void | Promise<void>;
}) {
```

```tsx
    try {
      const created = await workspaceCreate({
        repoOwner: ghRepo.owner,
        repoName: ghRepo.repo,
        headRef,
        baseRef: baseRef.trim() || 'main',
        title: title.trim(),
      });
      onClose();
      await onCreated(created);
    } catch (e) {
```

Add `WorkspaceCreated` to the `../../tauri` import block (lines 6-24):

```tsx
  type WorkspaceCreated,
```

- [ ] **Step 4: Add a "Storyline" button on pre-publish workspace rows**

`WorkspaceRowCompact` already renders an optional `onBackToSelfReview` button for pre-publish rows. Add a parallel `onOpenStoryline` button. Change its props (lines 1169-1179):

```tsx
function WorkspaceRowCompact({
  w,
  stats,
  reviewing,
  onBackToSelfReview,
  onOpenStoryline,
}: {
  w: OverviewWorkspaceRow;
  stats: { added: number | null; removed: number | null };
  reviewing?: boolean;
  onBackToSelfReview?: (w: OverviewWorkspaceRow) => void;
  onOpenStoryline?: (w: OverviewWorkspaceRow) => void;
}) {
```

Add the button just before the `onBackToSelfReview` button (before line 1251 `{onBackToSelfReview && (`):

```tsx
      {onOpenStoryline && (
        <button
          type="button"
          className="btn"
          onClick={() => onOpenStoryline(w)}
          title="Open the storyline for this workspace"
          style={{ flex: '0 0 auto' }}
        >
          <Icon name="doc-stack" size={10} color="var(--gray-700)" /> Storyline
        </button>
      )}
```

Then pass it from the "Ready to share" bucket render (lines 567-574). Replace that `WorkspaceRowCompact` usage with:

```tsx
                        {yoursReadyToShare.filter(matchWorkspace).map((w) => (
                          <WorkspaceRowCompact
                            key={w.id}
                            w={w}
                            stats={wsStats(w)}
                            onBackToSelfReview={ghRepo ? (ws) => setRevertTarget(ws) : undefined}
                            onOpenStoryline={(ws) =>
                              onOpenStoryline({
                                workspaceId: ws.id,
                                owner: ws.repo_owner,
                                repo: ws.repo_name,
                                headRef: ws.head_ref,
                                baseRef: ws.base_ref,
                                title: ws.title,
                              })
                            }
                          />
                        ))}
```

- [ ] **Step 5: Typecheck + lint**

Run: `cd client && bun run typecheck && bun run lint`
Expected: PASS. (If Biome flags the `▲▼×` spans, they already use `role="button"` + `tabIndex` + `onKeyDown`; adjust per Biome's message if needed.)

- [ ] **Step 6: Commit**

```bash
git add client/src/App.tsx client/src/screens/workspaces/Workspaces.tsx
git commit -m "feat(client): wire storyline screen — post-create + Ready-to-share row entry"
```

---

## Task 11: Full verification + manual end-to-end

**Files:** none (verification only)

- [ ] **Step 1: Run the full client gate**

Run: `just client::check && just client::lint && just client::clippy && just client::test`
Expected: all PASS (tsc, biome, cargo fmt --check, clippy -D warnings, cargo test incl. the new `diff_files_*`, `storyline_*` tests).

- [ ] **Step 2: Run repo pre-commit**

Run: `just pre-commit`
Expected: PASS (or auto-fix → `git add -u` the changes and re-run).

- [ ] **Step 3: Manual end-to-end (requires backend running + a repo with a GitHub remote)**

Start the backend (`cd backend && just dev` or per backend README) and the client (`cd client && just dev`). Then:
1. Sign in, open a local repo that has a GitHub remote and at least one feature branch ahead of its base.
2. Click **New workspace**, pick the branch, Create → you land on the **Storyline** screen.
3. The changed files for that branch appear under **Changed files**. **Add** two or three, **reorder** with ▲▼, write a **markdown** intro (e.g. a bullet list) on one — confirm the **Preview** renders the list.
4. **Save storyline** → no error banner. Click **Workspaces** (Back), then the row's **Storyline** button → your steps + intros reload in the saved order.
5. Confirm the workspace row's storyline count badge reflects the saved steps after the overview refreshes.

- [ ] **Step 4: Commit (if pre-commit auto-fixed anything)**

```bash
git add -u
git commit -m "chore(client): formatting from pre-commit"
```

---

## Self-Review

**Spec coverage** (`docs/superpowers/specs/2026-05-30-storyline-composition-v1-design.md`):
- §5.2 local-git changed files → Tasks 1-2. §6.1 GET storyline → Tasks 3-4, 6. §6.1 PUT storyline → Tasks 3, 5, 6. §5.2 reconcile (included/pool/orphan) → Task 8 (orphans surfaced as `stale`). §5.1 screen (pool/steps/editor/preview/completeness/save) → Task 9. §6 markdown → Task 7. §6.5 entry points (post-create + row) → Task 10. §8 fail-loud (banners, no fallback, stale surfaced) → Tasks 1, 9. §7 backend zero-change → no backend task. §9 testing (Rust unit + wiremock) → Tasks 1, 4, 5; reconcile kept pure for later JS tests (Task 8).
- Deliberately out (spec §3) and absent from the plan: reviewer walkthrough, per-file diff render, drag-drop, AI, per-step title edit, line-refs. Per-file diff slot is reserved in Task 9 (comment marker).

**Placeholder scan:** none — every code step shows the full code; commands have expected output.

**Type consistency:** `StorylineFileWrite` is camelCase on the webview→command wire (Task 3 Rust `#[serde(rename_all="camelCase")]`; Task 6 TS `{diffFilePath, orderIndex, introText}`); the SDK maps it to snake_case for the backend (Task 5). `Storyline`/`StorylineFile` (response) are snake_case both in Rust DTO (Task 3) and TS (Task 6), matching the existing `OverviewRow` convention. `StorylineCtx` fields (`workspaceId, owner, repo, headRef, baseRef, title`) are defined in Task 9 and consumed identically in Task 10. `Step` (Task 8) is consumed in Task 9. `gitDiffFiles(baseRef, headRef)` and `ChangedFile` names match across Tasks 2, 8, 9.
