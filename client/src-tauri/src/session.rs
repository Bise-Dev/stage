use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::errors::AppError;

/// On-disk mirror of the signed-in Stage session token, so a returning author
/// skips the GitHub sign-in flow on every launch (ADR-0013, Option C). The
/// in-memory `AppState.auth` stays the runtime source of truth; this store is
/// loaded into it at boot and written through on sign-in / logout.
///
/// TODO(keychain): the token is stored as **plaintext JSON** in the Tauri
/// app-data dir — a deliberate MVP stopgap that mirrors `RecentsStore`. It is
/// readable by anything running as the user; this is NOT secure secret storage.
/// The eventual target is the OS keychain (macOS Keychain via the `keyring`
/// crate). Do not widen what we persist here until that lands.
#[derive(Clone, Default, Serialize, Deserialize)]
struct PersistedSession {
    token: Option<String>,
}

pub struct SessionStore {
    file: PathBuf,
    token: Mutex<Option<String>>,
}

impl SessionStore {
    pub fn open(data_dir: &Path) -> Result<Self, AppError> {
        let file = data_dir.join("session.json");
        let token = if file.exists() {
            let raw = std::fs::read_to_string(&file)?;
            // A corrupt/partial file shouldn't wedge boot — treat it as "no
            // session" and let the normal sign-in path re-establish one.
            serde_json::from_str::<PersistedSession>(&raw)
                .unwrap_or_default()
                .token
        } else {
            None
        };
        Ok(Self {
            file,
            token: Mutex::new(token),
        })
    }

    /// The persisted token, if any. Used at boot to seed `AppState.auth`.
    pub fn token(&self) -> Option<String> {
        self.token.lock().clone()
    }

    /// Persist `token` to disk, replacing any prior value.
    pub fn save(&self, token: &str) -> Result<(), AppError> {
        *self.token.lock() = Some(token.to_string());
        persist(&self.file, Some(token))
    }

    /// Forget the persisted token. Removes the file outright rather than
    /// leaving a stale value on disk (logout / dead-session fallback).
    pub fn clear(&self) -> Result<(), AppError> {
        *self.token.lock() = None;
        if self.file.exists() {
            std::fs::remove_file(&self.file)?;
        }
        Ok(())
    }
}

fn persist(file: &Path, token: Option<&str>) -> Result<(), AppError> {
    let snapshot = PersistedSession {
        token: token.map(str::to_string),
    };
    let raw = serde_json::to_string_pretty(&snapshot)?;
    std::fs::write(file, raw)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path()).unwrap();
        assert_eq!(store.token(), None);
    }

    #[test]
    fn save_then_reopen_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = SessionStore::open(dir.path()).unwrap();
            store.save("stg_abc").unwrap();
            assert_eq!(store.token().as_deref(), Some("stg_abc"));
        }
        let reopened = SessionStore::open(dir.path()).unwrap();
        assert_eq!(reopened.token().as_deref(), Some("stg_abc"));
    }

    #[test]
    fn clear_removes_persisted_token() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path()).unwrap();
        store.save("stg_abc").unwrap();
        store.clear().unwrap();
        assert_eq!(store.token(), None);
        assert!(!dir.path().join("session.json").exists());
        // A fresh open sees nothing.
        let reopened = SessionStore::open(dir.path()).unwrap();
        assert_eq!(reopened.token(), None);
    }

    #[test]
    fn corrupt_file_is_treated_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("session.json"), "{not json").unwrap();
        let store = SessionStore::open(dir.path()).unwrap();
        assert_eq!(store.token(), None);
    }
}
