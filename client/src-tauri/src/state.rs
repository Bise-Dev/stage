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
