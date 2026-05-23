use std::path::PathBuf;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::new_debouncer;
use tauri::{AppHandle, Emitter};
use tracing::{debug, warn};

use crate::errors::AppError;

/// Opaque owner for a live filesystem watcher. Drops cleanly when replaced.
pub struct WatcherHandle(#[allow(dead_code)] Box<dyn std::any::Any + Send + Sync>);

/// Spawn a recursive filesystem watcher rooted at `repo_path`. Emits a
/// `repo-changed` Tauri event (no payload) on any debounced change.
///
/// No ignore filters today — repos with heavy build output (target/, node_modules/)
/// will emit lots of events. The debounce window absorbs bursts; smarter
/// filtering is a future refinement.
pub fn spawn(app: AppHandle, repo_path: PathBuf) -> Result<WatcherHandle, AppError> {
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |res: notify_debouncer_mini::DebounceEventResult| match res {
            Ok(events) => {
                debug!(count = events.len(), "watcher: debounced events");
                if let Err(e) = app.emit("repo-changed", ()) {
                    warn!(error = %e, "emit repo-changed failed");
                }
            }
            Err(e) => warn!(error = ?e, "watcher error"),
        },
    )
    .map_err(|e| AppError::Watcher(e.to_string()))?;

    debouncer
        .watcher()
        .watch(&repo_path, RecursiveMode::Recursive)
        .map_err(|e| AppError::Watcher(e.to_string()))?;

    Ok(WatcherHandle(Box::new(debouncer)))
}
