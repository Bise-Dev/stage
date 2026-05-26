use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::task::AbortHandle;

use crate::api;
use crate::errors::AppError;
use crate::recents::RecentsStore;
use crate::watcher::WatcherHandle;

pub struct AppState {
    pub active: Mutex<Option<ActiveRepo>>,
    pub recents: Arc<RecentsStore>,
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
    pub user: api::User,
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
