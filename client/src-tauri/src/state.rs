use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::recents::RecentsStore;
use crate::watcher::WatcherHandle;

pub struct AppState {
    pub active: Mutex<Option<ActiveRepo>>,
    pub recents: Arc<RecentsStore>,
    /// The credential-free GitHub adapter (ADR-0022 §5). Held here, as its own
    /// docs advise, so the `gh` auth gate and `gh api user` identity resolve at
    /// most once per process. Every GitHub command (publish, verdict, discussion,
    /// dashboard PR search, identity) goes through it. Stage stores no token.
    ///
    /// `Arc` so a networked command can `Arc::clone` it into a `spawn_blocking`
    /// closure and run its blocking `gh`/`git` I/O off the UI thread (ADR-0023)
    /// while still sharing the one cached auth gate + identity across calls.
    pub github: Arc<stage_core::GitHub>,
    /// A pending `stage open` request (ADR-0014): on cold start it is parsed
    /// from this process's argv in `setup`; on warm start the single-instance
    /// callback writes it here and emits `open-intent`. The webview drains it
    /// once via `take_open_intent` and routes per its mode.
    pub pending_open: Mutex<Option<OpenIntent>>,
    /// The desired background `git fetch` cadence in seconds (0 = off). Owned
    /// here (not on the engine) so it survives repo switches — each new
    /// [`crate::sync`] engine is seeded from it.
    pub auto_fetch_secs: Mutex<u32>,
    /// Dev-only Activity log ring (decision #6). The `tracing` layer in
    /// `lib.rs` holds the same `Arc`, so both the layer and the IPC commands
    /// read/write one buffer. Absent from release builds — see `activity_log.rs`.
    #[cfg(debug_assertions)]
    pub activity_log: Arc<crate::activity_log::ActivityLog>,
}

/// What `stage open` asks the GUI to do (ADR-0014). `repo` is the local clone
/// the screen targets — the branch is rediscovered from its working tree for
/// Self-Review, and for Review it is the clone the PR was resolved to by `origin`
/// match (ADR-0022 §6). `pr` is carried only in `Review` mode.
#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OpenIntent {
    pub repo: PathBuf,
    pub mode: OpenMode,
    /// The pull request to open for review; `Some` only when `mode == Review`
    /// (ADR-0022 §6). `null` for a Self-Review open.
    pub pr: Option<stage_core::PrRef>,
}

/// The screen `stage open` lands on. `SelfReview` (the author's local review) or
/// `Review` (open a PR read-only, ADR-0022 §6). Serializes as `"selfReview"` /
/// `"review"`.
#[derive(Clone, Copy, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum OpenMode {
    SelfReview,
    Review,
}

pub struct ActiveRepo {
    /// The **focused worktree**'s working directory — the one Self-Review,
    /// diff, and Debrief commands target (ADR-0016). Named `path` so the
    /// existing command bodies route to the focused worktree unchanged.
    pub path: PathBuf,
    /// Canonical Repo identity: the shared git common directory. Stable across
    /// every worktree of this repo.
    pub common_dir: PathBuf,
    #[allow(dead_code)]
    pub watcher: WatcherHandle,
    /// This repo's background sync engine — owns the overview snapshot and the
    /// GitHub poller. One per active repo (only one repo is open at a time);
    /// dropped (task aborted) together with the rest of the activation.
    pub sync: crate::sync::SyncHandle,
}
