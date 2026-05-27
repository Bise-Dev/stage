use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::api;
use crate::errors::AppError;
use crate::git;
use crate::oauth::{authorize_url, gen_state, pkce_pair, LoopbackListener};
use crate::recents::RecentRepo;
use crate::state::{ActiveRepo, AppState, AuthSession};
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

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>) -> Result<git::FetchOutcome, AppError> {
    let path = state
        .active
        .lock()
        .as_ref()
        .map(|a| a.path.clone())
        .ok_or(AppError::NoActiveRepo)?;
    // git2 fetch is blocking I/O — keep it off the async runtime's threads.
    tauri::async_runtime::spawn_blocking(move || git::fetch(&path))
        .await
        .map_err(|e| AppError::Backend(format!("fetch_join_error: {e}")))?
}

#[tauri::command]
pub fn open_in_finder(path: PathBuf) -> Result<(), AppError> {
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|e| AppError::Backend(format!("open_in_finder_failed: {e}")))
}

#[tauri::command]
pub async fn auth_sign_in(state: tauri::State<'_, AppState>) -> Result<api::User, AppError> {
    // Reject a second concurrent sign-in.
    {
        let in_flight = state.auth_in_flight.lock();
        if in_flight.is_some() {
            return Err(AppError::Backend("oauth_in_flight".into()));
        }
    }

    let (verifier, challenge) = pkce_pair();
    let state_param = gen_state();
    let listener = LoopbackListener::bind().await?;
    let redirect_uri = listener.redirect_uri().to_string();

    let client_id = state.github_app_client_id.clone();
    let url = authorize_url(&client_id, &redirect_uri, &state_param, &challenge);
    tauri_plugin_opener::open_url(&url, None::<String>)
        .map_err(|e| AppError::Backend(format!("oauth_browser_open_failed: {e}")))?;

    // Run the listener inside an abortable task so cancel works.
    let state_param_owned = state_param.clone();
    let handle = tokio::spawn(async move {
        listener
            .recv(Duration::from_secs(300), &state_param_owned)
            .await
    });
    {
        *state.auth_in_flight.lock() = Some(handle.abort_handle());
    }

    let recv_result = handle.await;
    {
        *state.auth_in_flight.lock() = None;
    }

    let params = match recv_result {
        Ok(inner) => inner?,
        Err(join_err) if join_err.is_cancelled() => return Err(AppError::Cancelled),
        Err(other) => return Err(AppError::Backend(format!("oauth_join_error: {other}"))),
    };

    let session = state
        .api
        .web_exchange(&params.code, &verifier, &redirect_uri)
        .await?;

    *state.auth.lock() = Some(AuthSession {
        token: session.session_token,
    });
    Ok(session.user)
}

#[tauri::command]
pub async fn auth_sign_in_cancel(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    if let Some(handle) = state.auth_in_flight.lock().take() {
        handle.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn auth_me(state: tauri::State<'_, AppState>) -> Result<api::User, AppError> {
    let token = state.require_token()?;
    let user = state.api.auth_me(&token).await?;
    Ok(user)
}

#[tauri::command]
pub async fn auth_logout(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let token = state.require_token()?;
    let result = state.api.logout(&token).await;
    *state.auth.lock() = None;
    result.map_err(Into::into)
}

#[tauri::command]
pub async fn github_prs(
    state: tauri::State<'_, AppState>,
    role: String,
) -> Result<Vec<api::GithubPrSearchItem>, AppError> {
    let token = state.require_token()?;
    let items = state.api.github_prs(&token, &role).await?;
    Ok(items)
}
