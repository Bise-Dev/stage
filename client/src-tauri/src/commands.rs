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
    state
        .active
        .lock()
        .as_ref()
        .map(|a| RepoInfo { path: a.path.clone() })
}

#[tauri::command]
pub fn list_recent_repos(state: State<'_, AppState>) -> Vec<RecentRepo> {
    state.recents.list()
}

#[tauri::command]
pub fn forget_recent_repo(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<(), AppError> {
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
