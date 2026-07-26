use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebouncedEvent, Debouncer};
use stage_core::{default_store_path, Store};
use tauri::{AppHandle, Emitter};
use tracing::{debug, warn};

use crate::errors::AppError;
use crate::sync::SyncMsg;

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
///   (ADR-0011). Also nudges the sync engine — drafts and Debrief flags feed
///   the overview snapshot.
/// - the **common directory** (recursive) → emits `worktrees-changed` when an
///   external tool (e.g. agent-deck) adds or removes a worktree under
///   `<common_dir>/worktrees/`, so the worktree list refreshes without requiring
///   a manual reload. When the change touches a **significant git path** (a ref,
///   `HEAD`, `packed-refs`, or the worktree registry — the things the overview
///   is derived from) it also nudges the sync engine. Working-tree edits and
///   `.git` bookkeeping like `FETCH_HEAD`/`index` deliberately don't: the
///   overview reads only committed state (ADR-0018).
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
/// repos with heavy build output emit lots of events; the debounce absorbs
/// them, and since the sync engine ignores this watch entirely, a flood costs
/// webview reloads of an unchanged snapshot (cheap), never `gh`/diff work.
pub fn spawn(
    app: AppHandle,
    repo_path: PathBuf,
    common_dir: PathBuf,
    engine: tokio::sync::mpsc::UnboundedSender<SyncMsg>,
) -> Result<WatcherHandle, AppError> {
    let repo_watch = watch_path(&repo_path, RecursiveMode::Recursive, {
        let app = app.clone();
        move |_events| emit(&app, "repo-changed")
    })?;

    // The store may not exist yet (the agent may not have run `stage` against
    // this repo); open it once to create + migrate the file, so the watch has a
    // concrete, stable target. The connection is dropped immediately.
    let store_path = default_store_path()?;
    Store::open(&store_path)?;
    let store_watch = watch_path(&store_path, RecursiveMode::NonRecursive, {
        let app = app.clone();
        let engine = engine.clone();
        move |_events| {
            emit(&app, "debrief-changed");
            let _ = engine.send(SyncMsg::LocalChanged);
        }
    })?;

    // Worktree add/remove (e.g. agent-deck) lands under `<common_dir>/worktrees/`.
    // Watch the common dir so the list refreshes regardless of which worktree is
    // focused -- the repo watch above only covers the focused dir, and a linked
    // worktree's common dir is outside it. Re-listing worktrees is a read, so
    // unlike the store watch there is no write-feedback loop (ADR-0016). The
    // common dir IS the shared `.git`, so this watch is also where every ref
    // move (commit, fetch, branch) surfaces for the sync engine.
    let worktrees_watch = watch_path(&common_dir, RecursiveMode::Recursive, {
        move |events: &[DebouncedEvent]| {
            emit(&app, "worktrees-changed");
            if events.iter().any(|e| significant_git_path(&e.path)) {
                let _ = engine.send(SyncMsg::LocalChanged);
            }
        }
    })?;

    Ok(WatcherHandle(Box::new((
        repo_watch,
        store_watch,
        worktrees_watch,
    ))))
}

/// Whether a `.git` (common-dir) path is one the overview is derived from:
/// branch/remote refs (`refs/**`, `packed-refs`), a `HEAD` symref (the root's or
/// a linked worktree's — branch switches and commits), or the worktree registry
/// (`worktrees/**`, add/remove). Excludes by construction the noisy bookkeeping
/// the overview does not read: `FETCH_HEAD`/`ORIG_HEAD` (file name is not
/// exactly `HEAD`), `index`, object/pack writes.
fn significant_git_path(path: &Path) -> bool {
    let file_name = path.file_name().and_then(|n| n.to_str());
    if matches!(file_name, Some("HEAD" | "packed-refs")) {
        return true;
    }
    path.components()
        .any(|c| matches!(c.as_os_str().to_str(), Some("refs" | "worktrees")))
}

fn emit(app: &AppHandle, event: &'static str) {
    if let Err(e) = app.emit(event, ()) {
        warn!(error = %e, event, "watcher emit failed");
    }
}

/// Spawn one debounced watcher over `path`, invoking `handler` with the batch
/// on any debounced change. Returns the live debouncer; dropping it stops the
/// watch.
fn watch_path(
    path: &Path,
    mode: RecursiveMode,
    handler: impl Fn(&[DebouncedEvent]) + Send + 'static,
) -> Result<Debouncer<notify::RecommendedWatcher>, AppError> {
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |res: notify_debouncer_mini::DebounceEventResult| match res {
            Ok(events) => {
                debug!(count = events.len(), "watcher: debounced events");
                handler(&events);
            }
            Err(e) => warn!(error = ?e, "watcher error"),
        },
    )
    .map_err(|e| AppError::Watcher(e.to_string()))?;

    debouncer
        .watcher()
        .watch(path, mode)
        .map_err(|e| AppError::Watcher(e.to_string()))?;

    Ok(debouncer)
}

#[cfg(test)]
mod tests {
    use super::significant_git_path;
    use std::path::Path;

    #[test]
    fn ref_moves_and_worktree_registry_are_significant() {
        for p in [
            "/repo/.git/HEAD",
            "/repo/.git/packed-refs",
            "/repo/.git/refs/heads/feat",
            "/repo/.git/refs/remotes/origin/main",
            "/repo/.git/worktrees/feat/HEAD",
            "/repo/.git/worktrees/feat/gitdir",
        ] {
            assert!(significant_git_path(Path::new(p)), "{p} must nudge");
        }
    }

    #[test]
    fn bookkeeping_noise_is_not_significant() {
        for p in [
            "/repo/.git/FETCH_HEAD",
            "/repo/.git/ORIG_HEAD",
            "/repo/.git/index",
            "/repo/.git/objects/ab/cdef",
            "/repo/.git/COMMIT_EDITMSG",
        ] {
            assert!(!significant_git_path(Path::new(p)), "{p} must not nudge");
        }
    }
}
