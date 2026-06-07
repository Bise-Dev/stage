use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, Debouncer};
use stage_core::{default_store_path, Store};
use tauri::{AppHandle, Emitter};
use tracing::{debug, warn};

use crate::errors::AppError;

/// Opaque owner for the live filesystem watchers. Drops cleanly when replaced,
/// tearing down both the repo and the store watcher.
pub struct WatcherHandle(#[allow(dead_code)] Box<dyn std::any::Any + Send + Sync>);

/// Spawn the filesystem watchers for an active repo:
///
/// - the **repo** itself (recursive) → emits `repo-changed`, driving the diff
///   refresh on any working-tree / `.git` change;
/// - the shared **Debrief store file** → emits `debrief-changed`, so the
///   Self-Review screen live-refreshes when the `stage` CLI (or this app)
///   writes a Debrief or Review note. The store is a SQLite DB outside the repo
///   (ADR-0011).
/// - the **common directory** (recursive) → emits `worktrees-changed` when an
///   external tool (e.g. agent-deck) adds or removes a worktree under
///   `<common_dir>/worktrees/`, so the worktree list refreshes without requiring
///   a manual reload.
///
/// We watch the **main DB file specifically, not its directory**. A SQLite read
/// in WAL mode creates and then deletes sibling `-wal`/`-shm` files on connection
/// close, which churns the *directory* but leaves the main file's mtime
/// untouched; a write checkpoints into the main file, moving its mtime. Watching
/// the directory would therefore make the app's own reads (every reload) emit
/// `debrief-changed` and feed back into another reload — a loop. Watching the
/// file alone catches writes and filters out read churn. The store is opened
/// once first so the file exists (and is migrated) before the watch attaches.
///
/// All watchers fire on a 500ms debounce, which absorbs the burst of events a
/// single logical change produces. No ignore filters on the repo watch today --
/// repos with heavy build output emit lots of events; the debounce absorbs them.
pub fn spawn(
    app: AppHandle,
    repo_path: PathBuf,
    common_dir: PathBuf,
) -> Result<WatcherHandle, AppError> {
    let repo_watch = watch_path(
        app.clone(),
        &repo_path,
        RecursiveMode::Recursive,
        "repo-changed",
    )?;

    // The store may not exist yet (the agent may not have run `stage` against
    // this repo); open it once to create + migrate the file, so the watch has a
    // concrete, stable target. The connection is dropped immediately.
    let store_path = default_store_path()?;
    Store::open(&store_path)?;
    let store_watch = watch_path(
        app.clone(),
        &store_path,
        RecursiveMode::NonRecursive,
        "debrief-changed",
    )?;

    // Worktree add/remove (e.g. agent-deck) lands under `<common_dir>/worktrees/`.
    // Watch the common dir so the list refreshes regardless of which worktree is
    // focused -- the repo watch above only covers the focused dir, and a linked
    // worktree's common dir is outside it. Re-listing worktrees is a read, so
    // unlike the store watch there is no write-feedback loop (ADR-0016).
    let worktrees_watch = watch_path(
        app,
        &common_dir,
        RecursiveMode::Recursive,
        "worktrees-changed",
    )?;

    Ok(WatcherHandle(Box::new((
        repo_watch,
        store_watch,
        worktrees_watch,
    ))))
}

/// Spawn one debounced watcher over `path`, emitting `event` (no payload) on any
/// debounced change. Returns the live debouncer; dropping it stops the watch.
fn watch_path(
    app: AppHandle,
    path: &Path,
    mode: RecursiveMode,
    event: &'static str,
) -> Result<Debouncer<notify::RecommendedWatcher>, AppError> {
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |res: notify_debouncer_mini::DebounceEventResult| match res {
            Ok(events) => {
                debug!(count = events.len(), event, "watcher: debounced events");
                if let Err(e) = app.emit(event, ()) {
                    warn!(error = %e, event, "watcher emit failed");
                }
            }
            Err(e) => warn!(error = ?e, event, "watcher error"),
        },
    )
    .map_err(|e| AppError::Watcher(e.to_string()))?;

    debouncer
        .watcher()
        .watch(path, mode)
        .map_err(|e| AppError::Watcher(e.to_string()))?;

    Ok(debouncer)
}
