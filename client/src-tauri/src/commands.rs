use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::errors::AppError;
use crate::git;
use crate::recents::RecentRepo;
use crate::state::{ActiveRepo, AppState};
use crate::watcher;

#[derive(Serialize, Deserialize)]
pub struct RepoInfo {
    pub path: PathBuf,
}

#[tauri::command]
pub fn set_active_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<RepoInfo, AppError> {
    // Validate it's a real git repo before touching state.
    git2::Repository::open(&path).map_err(|_| AppError::NotARepo(path.clone()))?;

    let watcher = watcher::spawn(app.clone(), path.clone())?;
    state.recents.touch(&path)?;

    *state.active.lock() = Some(ActiveRepo {
        path: path.clone(),
        watcher,
    });

    Ok(RepoInfo { path })
}

#[tauri::command]
pub fn get_active_repo(state: State<'_, AppState>) -> Option<RepoInfo> {
    state.active.lock().as_ref().map(|a| RepoInfo {
        path: a.path.clone(),
    })
}

#[tauri::command]
pub fn list_recent_repos(state: State<'_, AppState>) -> Vec<RecentRepo> {
    state.recents.list()
}

#[tauri::command]
pub fn forget_recent_repo(state: State<'_, AppState>, path: PathBuf) -> Result<(), AppError> {
    state.recents.forget(&path)
}

#[tauri::command]
pub fn git_current_branch(state: State<'_, AppState>) -> Result<String, AppError> {
    let path = state
        .active
        .lock()
        .as_ref()
        .map(|a| a.path.clone())
        .ok_or(AppError::NoActiveRepo)?;
    git::current_branch(&path)
}

#[tauri::command]
pub fn repo_summary(path: PathBuf) -> Result<git::RepoSummary, AppError> {
    git::summary(&path)
}

use crate::api;
use crate::state::AuthSession;

/// Webview-facing variant of `api::DevicePollOutcome`. The `session_token`
/// from `DevicePollOutcome::Authorized(SessionData)` is intentionally
/// **NOT** included — it stays Rust-side in `AppState.auth`.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthPollResult {
    Pending,
    SlowDown,
    Authorized { user: api::User },
    Expired,
    Denied,
}

#[tauri::command]
pub async fn auth_device_start(state: State<'_, AppState>) -> Result<api::DeviceCode, AppError> {
    state.api.device_start().await.map_err(Into::into)
}

#[tauri::command]
pub async fn auth_device_poll(
    state: State<'_, AppState>,
    device_code: String,
) -> Result<AuthPollResult, AppError> {
    let outcome = state.api.device_poll(&device_code).await?;
    Ok(match outcome {
        api::DevicePollOutcome::Pending => AuthPollResult::Pending,
        api::DevicePollOutcome::SlowDown => AuthPollResult::SlowDown,
        api::DevicePollOutcome::Expired => AuthPollResult::Expired,
        api::DevicePollOutcome::Denied => AuthPollResult::Denied,
        api::DevicePollOutcome::Authorized(api::SessionData {
            session_token,
            user,
        }) => {
            let user_for_event = user.clone();
            *state.auth.lock() = Some(AuthSession {
                token: session_token,
                user,
            });
            AuthPollResult::Authorized {
                user: user_for_event,
            }
        }
    })
}

#[tauri::command]
pub async fn auth_me(state: State<'_, AppState>) -> Result<api::User, AppError> {
    let token = state.require_token()?;
    state.api.auth_me(&token).await.map_err(Into::into)
}

#[tauri::command]
pub async fn auth_logout(state: State<'_, AppState>) -> Result<(), AppError> {
    let token = state.require_token()?;
    let result = state.api.logout(&token).await;
    *state.auth.lock() = None;
    result.map_err(Into::into)
}

#[tauri::command]
pub async fn github_prs(
    state: State<'_, AppState>,
    role: String,
) -> Result<Vec<api::GithubPrSearchItem>, AppError> {
    let token = state.require_token()?;
    state
        .api
        .github_prs(&token, &role)
        .await
        .map_err(Into::into)
}
