use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::api;
use crate::errors::AppError;
use crate::recents::RecentsStore;
use crate::watcher::WatcherHandle;

pub struct AppState {
    pub active: Mutex<Option<ActiveRepo>>,
    pub recents: Arc<RecentsStore>,
    pub api: api::Client,
    pub auth: Mutex<Option<AuthSession>>,
}

pub struct ActiveRepo {
    pub path: PathBuf,
    #[allow(dead_code)]
    pub watcher: WatcherHandle,
}

pub struct AuthSession {
    pub token: String,
    #[allow(dead_code)]
    pub user: api::User,
}

impl AppState {
    /// Returns a clone of the current session token, or `NotAuthenticated`
    /// if the user is not signed in. Locks briefly, never across `.await`.
    pub fn require_token(&self) -> Result<String, AppError> {
        self.auth
            .lock()
            .as_ref()
            .map(|a| a.token.clone())
            .ok_or(AppError::NotAuthenticated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_app_state_no_auth() -> AppState {
        AppState {
            active: Mutex::new(None),
            recents: Arc::new(RecentsStore::for_testing()),
            api: api::Client::new("http://localhost:8000").unwrap(),
            auth: Mutex::new(None),
        }
    }

    #[test]
    fn require_token_none_returns_not_authenticated() {
        let s = make_app_state_no_auth();
        let err = s.require_token().unwrap_err();
        assert!(matches!(err, AppError::NotAuthenticated), "got {err:?}");
    }

    #[test]
    fn require_token_some_returns_clone() {
        let s = make_app_state_no_auth();
        *s.auth.lock() = Some(AuthSession {
            token: "stg_xyz".to_string(),
            user: api::User {
                id: 1,
                github_login: "u".to_string(),
                github_user_id: 1,
                display_name: None,
                avatar_url: None,
            },
        });
        let tok = s.require_token().unwrap();
        assert_eq!(tok, "stg_xyz");
        // Lock is released, internal state still present.
        assert!(s.auth.lock().is_some());
    }
}
