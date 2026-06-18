# ADR-0023 · Networked Tauri commands run off the UI thread

**Status:** accepted
**Date:** 2026-06-18

> Scope: a cross-cutting rule for the Tauri command layer (`client/src-tauri/src/commands.rs`)
> on the `.stage` refactor (ADR-0022). It does not change any data model or IPC type — only
> *where* a command's blocking work runs.

## Context

In Tauri v2 a synchronous `#[tauri::command] pub fn` runs on the **main (UI) thread**; an
`async fn` command runs on the async runtime, off the UI thread. The whole engine reaches GitHub
by shelling out to the user's local `gh` and `git` (ADR-0022 §5): every PR read, verdict, comment,
thread action, the dashboard PR search, identity resolution, publish, push, and checkout is a
**blocking subprocess that waits on the network**.

These were all written as synchronous commands. The result was a systemic freeze: opening the
Dashboard ran a `gh` PR search on the UI thread and locked the window until GitHub responded; the
same applied to every reviewer/publish action. The webview correctly `await`ed and showed a spinner
— the spinner just never got a frame to paint, because the thread that paints it was blocked.

Only `git_fetch` was already correct: an `async fn` that runs the blocking call inside
`tauri::async_runtime::spawn_blocking`.

## Decision

**Any command that performs network or other blocking subprocess I/O is an `async fn` whose
blocking body runs inside `tauri::async_runtime::spawn_blocking`.** This covers everything that
touches the `gh` adapter (`stage_core::GitHub`) or pushes/fetches over `git`. The pattern (mirroring
`git_fetch`):

1. Lock state and clone the cheap, owned inputs **up front**, on the runtime thread — never hold a
   `State` borrow across the `.await`.
2. `Arc::clone` the GitHub adapter into the closure.
3. Resolve the rest (repo key/root, `Store::open_default()`) and run the blocking call **inside**
   `spawn_blocking(move || …)`.
4. `.await` the join handle and map a join error to a loud `AppError::Backend("…_join_error: …")`
   — never swallow it (fail-loud, CLAUDE.md).

To make the adapter movable into a `'static + Send` closure while keeping its cached auth gate +
identity shared across calls, **`AppState.github` is `Arc<stage_core::GitHub>`** (the struct is not
`Clone`; `#[derive(Clone)]` would duplicate the cache per call). `Arc<GitHub>` derefs to `&GitHub`,
so call sites are unchanged.

**Local-only commands stay synchronous.** Store reads/writes, libgit2 tree-to-tree diffs, and
remote-tracking-ref reads (`git_remote_branches`) touch only local disk; running them on the UI
thread is fine and async would add overhead for nothing.

## Consequences

- The window stays responsive during every GitHub/push action; the webview spinner actually paints.
- The IPC contract is unchanged — `invoke()` already returns a `Promise`, so no TS/ts-rs change. The
  frontend was already `await`ing.
- **Frontend double-click guards now matter.** With the UI thread no longer frozen, a user can click
  a write-action button (publish, merge, verdict, comment) twice before the first resolves, firing
  duplicate GitHub mutations. Write-action controls must disable / short-circuit while their call is
  pending.
- New networked commands must follow this rule; a synchronous command that shells out to `gh`/`git`
  is a regression of this ADR.

## Considered alternatives

- **`async fn` with the body run directly on a tokio worker (no `spawn_blocking`).** Stops the UI
  freeze, but a long synchronous subprocess call would block a runtime worker thread, starving other
  async work. `spawn_blocking` is the runtime's own mechanism for exactly this. Rejected.
- **`#[derive(Clone)]` on `GitHub` instead of `Arc`.** Each clone gets its own `OnceLock` auth/identity
  cache, so every command would re-run `gh auth status` + `gh api user`. Defeats the purpose of holding
  the adapter. Rejected.
