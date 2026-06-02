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
/// - the shared **Handoff store file** → emits `handoff-changed`, so the
///   Self-Review screen live-refreshes when the `stage` CLI (or this app)
///   writes a Handoff or Review note. The store is a SQLite DB outside the repo
///   (ADR-0011).
///
/// We watch the **main DB file specifically, not its directory**. A SQLite read
/// in WAL mode creates and then deletes sibling `-wal`/`-shm` files on connection
/// close, which churns the *directory* but leaves the main file's mtime
/// untouched; a write checkpoints into the main file, moving its mtime. Watching
/// the directory would therefore make the app's own reads (every reload) emit
/// `handoff-changed` and feed back into another reload — a loop. Watching the
/// file alone catches writes and filters out read churn. The store is opened
/// once first so the file exists (and is migrated) before the watch attaches.
///
/// Both watchers fire on a 500ms debounce, which absorbs the burst of events a
/// single logical change produces. No ignore filters on the repo watch today —
/// repos with heavy build output emit lots of events; the debounce absorbs them.
pub fn spawn(app: AppHandle, repo_path: PathBuf) -> Result<WatcherHandle, AppError> {
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
        app,
        &store_path,
        RecursiveMode::NonRecursive,
        "handoff-changed",
    )?;

    Ok(WatcherHandle(Box::new((repo_watch, store_watch))))
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
