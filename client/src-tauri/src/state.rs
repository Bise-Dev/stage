use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::task::AbortHandle;

use crate::api;
use crate::errors::AppError;
use crate::recents::RecentsStore;
use crate::session::SessionStore;
use crate::watcher::WatcherHandle;

pub struct AppState {
    pub active: Mutex<Option<ActiveRepo>>,
    pub recents: Arc<RecentsStore>,
    /// On-disk mirror of the signed-in session token (ADR-0013). `auth` below
    /// is the runtime source of truth; this is written through on sign-in /
    /// logout and loaded into `auth` at boot.
    pub sessions: Arc<SessionStore>,
    pub api: api::Client,
    pub auth: Mutex<Option<AuthSession>>,
    pub auth_in_flight: Mutex<Option<AbortHandle>>,
    pub github_app_client_id: String,
    /// A pending `stage open` request (ADR-0014): on cold start it is parsed
    /// from this process's argv in `setup`; on warm start the single-instance
    /// callback writes it here and emits `open-intent`. The webview drains it
    /// once via `take_open_intent` and routes to Self-Review for `repo`.
    pub pending_open: Mutex<Option<OpenIntent>>,
    /// Dev-only Activity log ring (decision #6). The `tracing` layer in
    /// `lib.rs` holds the same `Arc`, so both the layer and the IPC commands
    /// read/write one buffer. Absent from release builds — see `activity_log.rs`.
    #[cfg(debug_assertions)]
    pub activity_log: Arc<crate::activity_log::ActivityLog>,
}

/// What `stage open` asks the GUI to do. Only the repo root is carried — the
/// branch is rediscovered from that working tree (ADR-0014).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenIntent {
    pub repo: PathBuf,
    pub mode: OpenMode,
}

/// The screen `stage open` lands on. Self-Review only today; an enum so adding
/// a mode later is a non-breaking change. Serializes as `"selfReview"`.
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenMode {
    SelfReview,
}

pub struct ActiveRepo {
    pub path: PathBuf,
    #[allow(dead_code)]
    pub watcher: WatcherHandle,
}

pub struct AuthSession {
    pub token: String,
}

impl AppState {
    pub fn require_token(&self) -> Result<String, AppError> {
        self.auth
            .lock()
            .as_ref()
            .map(|a| a.token.clone())
            .ok_or(AppError::NotAuthenticated)
    }
}
