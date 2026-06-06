use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use stage_core::diff::{default_base, DiffLineIndex};
use stage_core::{
    repo_key_from_cwd, Debrief, NoteAnchor, NoteStatus, ReviewNote, ReviewNoteView, Store,
};

use crate::api;
use crate::errors::AppError;
use crate::git;
use crate::oauth::{authorize_url, gen_state, pkce_pair, LoopbackListener};
use crate::recents::RecentRepo;
use crate::state::{ActiveRepo, AppState, AuthSession, OpenIntent};
use crate::watcher;

/// The active repo's working-tree path, or `NoActiveRepo`. The Self-Review
/// Debrief commands derive the store key from this (same `(repo, branch)`
/// keying the `stage` CLI uses), so they read/write the exact rows the agent
/// authored. See ADR-0011.
fn active_repo_path(state: &State<'_, AppState>) -> Result<PathBuf, AppError> {
    state
        .active
        .lock()
        .as_ref()
        .map(|a| a.path.clone())
        .ok_or(AppError::NoActiveRepo)
}

#[derive(Serialize, Deserialize)]
pub struct RepoInfo {
    pub path: PathBuf,
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn set_active_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<RepoInfo, AppError> {
    // Validate it's a real git repo and learn its canonical identity.
    // NOTE: git2 0.19 has no `commondir()` binding — use stage-core's helper.
    let repo = git2::Repository::open(&path).map_err(|_| AppError::NotARepo(path.clone()))?;
    let common_dir = stage_core::repo_common_dir(&repo);

    // Git is the source of truth for the worktree set (ADR-0016).
    let worktrees = stage_core::list_worktrees(&path)?;
    let activation = crate::repo_activation::resolve_activation(&worktrees, &path);

    // Recents collapse to the Repo: key on the root worktree so opening any
    // worktree (root or linked) touches one entry, not one per directory.
    state.recents.touch(&activation.root)?;

    // Watch the focused worktree (diff refresh). The focused path drives every
    // path-keyed command.
    let watcher = watcher::spawn(app.clone(), activation.focused.clone(), common_dir.clone())?;

    *state.active.lock() = Some(ActiveRepo {
        path: activation.focused.clone(),
        common_dir,
        watcher,
    });

    Ok(RepoInfo {
        path: activation.focused,
    })
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn get_active_repo(state: State<'_, AppState>) -> Option<RepoInfo> {
    state.active.lock().as_ref().map(|a| RepoInfo {
        path: a.path.clone(),
    })
}

/// Drain the pending `stage open` intent for this launch, if any (ADR-0014).
/// Consumed once at boot by the webview, which then sets the active repo and
/// routes to Self-Review. Returns `null` for a plain dock/Finder launch. Warm
/// starts are delivered separately via the `open-intent` event.
#[tauri::command]
pub fn take_open_intent(state: State<'_, AppState>) -> Option<OpenIntent> {
    state.pending_open.lock().take()
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn list_recent_repos(state: State<'_, AppState>) -> Vec<RecentRepo> {
    state.recents.list()
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn forget_recent_repo(state: State<'_, AppState>, path: PathBuf) -> Result<(), AppError> {
    state.recents.forget(&path)
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
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
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn repo_summary(path: PathBuf) -> Result<git::RepoSummary, AppError> {
    git::summary(&path)
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn git_local_branches(state: State<'_, AppState>) -> Result<Vec<git::BranchInfo>, AppError> {
    let path = state
        .active
        .lock()
        .as_ref()
        .map(|a| a.path.clone())
        .ok_or(AppError::NoActiveRepo)?;
    git::local_branches(&path)
}

/// The worktrees git reports for the active Repo, root first (ADR-0016).
/// Re-enumerated from git on every call — Stage holds no worktree registry.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn repo_worktrees(
    state: State<'_, AppState>,
) -> Result<Vec<stage_core::WorktreeInfo>, AppError> {
    let path = active_repo_path(&state)?;
    Ok(stage_core::list_worktrees(&path)?)
}

/// Focus a different worktree of the active Repo. Observe-only: this does NOT
/// check out — it re-points which worktree's working tree Self-Review/diff read
/// (ADR-0016). Fails loud if `path` is not one of the repo's worktrees.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn set_focused_worktree(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<RepoInfo, AppError> {
    let (current_path, common_dir) = state
        .active
        .lock()
        .as_ref()
        .map(|a| (a.path.clone(), a.common_dir.clone()))
        .ok_or(AppError::NoActiveRepo)?;

    // Re-ask git (Pillar 1) and confirm membership.
    let worktrees = stage_core::list_worktrees(&current_path)?;
    let focused = crate::repo_activation::match_worktree(&worktrees, &path).ok_or_else(|| {
        AppError::Backend(format!(
            "set_focused_worktree: {} is not a worktree of this repo",
            path.display()
        ))
    })?;

    let watcher = watcher::spawn(app.clone(), focused.clone(), common_dir.clone())?;
    *state.active.lock() = Some(ActiveRepo {
        path: focused.clone(),
        common_dir,
        watcher,
    });

    Ok(RepoInfo { path: focused })
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_diff(
    state: State<'_, AppState>,
    scope: String,
    base_ref: Option<String>,
) -> Result<git::SelfReviewDiff, AppError> {
    let path = state
        .active
        .lock()
        .as_ref()
        .map(|a| a.path.clone())
        .ok_or(AppError::NoActiveRepo)?;
    let scope = match scope.as_str() {
        "workdir" => git::SelfReviewScope::Workdir,
        "base" => git::SelfReviewScope::Base,
        other => {
            return Err(AppError::Backend(format!(
                "self_review_diff: invalid scope '{other}' (expected 'workdir' or 'base')"
            )));
        }
    };
    git::self_review_diff(&path, scope, base_ref.as_deref())
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn git_diff_stats(
    state: State<'_, AppState>,
    base_ref: String,
    head_ref: String,
) -> Result<git::DiffStats, AppError> {
    let path = state
        .active
        .lock()
        .as_ref()
        .map(|a| a.path.clone())
        .ok_or(AppError::NoActiveRepo)?;
    git::diff_stats(&path, &base_ref, &head_ref)
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn git_diff_files(
    state: State<'_, AppState>,
    base_ref: String,
    head_ref: String,
) -> Result<Vec<git::ChangedFile>, AppError> {
    let path = state
        .active
        .lock()
        .as_ref()
        .map(|a| a.path.clone())
        .ok_or(AppError::NoActiveRepo)?;
    git::diff_files(&path, &base_ref, &head_ref)
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn repo_overview(
    state: tauri::State<'_, AppState>,
    owner: String,
    repo: String,
) -> Result<serde_json::Value, AppError> {
    let token = state.require_token()?;
    let rows = state.api.repo_overview(&token, &owner, &repo).await?;
    Ok(rows)
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
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

/// Push a branch to the primary remote with the user's own git credentials
/// (ADR-0016). A reusable primitive; `workspace_publish` below pushes inline,
/// but this exposes a standalone push for other call sites.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn git_push(state: State<'_, AppState>, branch: String) -> Result<git::PushOutcome, AppError> {
    let repo = active_repo_path(&state)?;
    git::push(&repo, &branch)
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn open_in_finder(path: PathBuf) -> Result<(), AppError> {
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|e| AppError::Backend(format!("open_in_finder_failed: {e}")))
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn open_url(url: String) -> Result<(), AppError> {
    tauri_plugin_opener::open_url(&url, None::<&str>)
        .map_err(|e| AppError::Backend(format!("open_url_failed: {e}")))
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
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

    // Persist the token so the next launch skips sign-in (ADR-0013). Disk is a
    // write-through mirror of the in-memory token; if the write fails we fail
    // loud rather than leave a signed-in session that silently won't survive
    // restart.
    state.sessions.save(&session.session_token)?;
    *state.auth.lock() = Some(AuthSession {
        token: session.session_token,
    });
    Ok(session.user)
}

/// Validate the persisted session token at boot (ADR-0013).
///
/// Returns the signed-in `User` when a stored token still resolves via
/// `auth_me`, `None` when there is no token or the backend rejects it as
/// unauthenticated (dead session → cleared from memory and disk so the app
/// falls back to signed-out). Any other backend failure is surfaced verbatim.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn auth_bootstrap(
    state: tauri::State<'_, AppState>,
) -> Result<Option<api::User>, AppError> {
    let Some(token) = state.auth.lock().as_ref().map(|a| a.token.clone()) else {
        return Ok(None);
    };
    match state.api.auth_me(&token).await {
        Ok(user) => Ok(Some(user)),
        Err(api::Error::Unauthenticated) => {
            // Dead session: drop it everywhere so we don't show signed-in UI
            // that would fail on the first real backend call.
            *state.auth.lock() = None;
            state.sessions.clear()?;
            Ok(None)
        }
        Err(other) => Err(other.into()),
    }
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn auth_sign_in_cancel(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    if let Some(handle) = state.auth_in_flight.lock().take() {
        handle.abort();
    }
    Ok(())
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn auth_me(state: tauri::State<'_, AppState>) -> Result<api::User, AppError> {
    let token = state.require_token()?;
    let user = state.api.auth_me(&token).await?;
    Ok(user)
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn auth_logout(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let token = state.require_token()?;
    let result = state.api.logout(&token).await;
    // Clear locally regardless of the server's response — the user asked to
    // sign out. Drop the persisted copy too (ADR-0013) so the next launch
    // doesn't resurrect the session.
    *state.auth.lock() = None;
    state.sessions.clear()?;
    result.map_err(Into::into)
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn workspace_create(
    state: tauri::State<'_, AppState>,
    repo_owner: String,
    repo_name: String,
    head_ref: String,
    base_ref: String,
    title: String,
) -> Result<serde_json::Value, AppError> {
    let token = state.require_token()?;
    let ws = state
        .api
        .workspace_create(
            &token,
            &repo_owner,
            &repo_name,
            &head_ref,
            &base_ref,
            &title,
        )
        .await?;
    Ok(ws)
}

/// Publish a workspace to GitHub: push its branch with the user's own git
/// credentials (ADR-0016), then open or adopt its PR via the backend.
///
/// `already_published` short-circuits to a push-only "Push update" — the PR
/// already exists, so we re-push the branch and skip `open-pr`. The push is
/// idempotent (a no-op push still exits 0), so a first publish and a repeat
/// "Push update" take the same code path up to the branch on `already_published`.
/// Fail loud (CLAUDE.md): a push or `open-pr` failure surfaces verbatim via
/// `AppError` and no PR state changes silently — the push must succeed before we
/// ask the backend to open the PR (else GitHub 422s on a missing branch).
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn workspace_publish(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
    head_ref: String,
    title: String,
    body: Option<String>,
    already_published: bool,
) -> Result<serde_json::Value, AppError> {
    let token = state.require_token()?;
    let repo = active_repo_path(&state)?;
    // Sync subprocess git, called directly: brief network I/O on a user-initiated
    // action (the webview shows a spinner), and the multi-threaded runtime keeps
    // other work moving while this worker blocks.
    git::push(&repo, &head_ref)?;
    if already_published {
        return Ok(serde_json::json!({ "pushed": true }));
    }
    let v = state
        .api
        .open_pr(&token, &workspace_id, &title, body.as_deref(), false)
        .await?;
    Ok(v)
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn workspace_delete(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<(), AppError> {
    let token = state.require_token()?;
    state.api.workspace_delete(&token, &workspace_id).await?;
    Ok(())
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn storyline_get(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<api::StorylineDto, AppError> {
    let token = state.require_token()?;
    let dto = state.api.storyline_get(&token, &workspace_id).await?;
    Ok(dto)
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn storyline_update(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
    etag: String,
    files: Vec<api::StorylineFileWrite>,
) -> Result<api::StorylineDto, AppError> {
    let token = state.require_token()?;
    let dto = state
        .api
        .storyline_update(&token, &workspace_id, &etag, &files)
        .await?;
    Ok(dto)
}

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn github_prs(
    state: tauri::State<'_, AppState>,
    role: String,
) -> Result<Vec<api::GithubPrSearchItem>, AppError> {
    let token = state.require_token()?;
    let items = state.api.github_prs(&token, &role).await?;
    Ok(items)
}

/// The GitHub file object for one path in a PR (patch + status + counts), read
/// via the backend (ADR-0001). The reviewer storyline viewer calls this per
/// step — the reviewer may not have the branch checked out, so the diff comes
/// from the PR on GitHub rather than the local working tree.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_file_diff(
    state: tauri::State<'_, AppState>,
    owner: String,
    repo: String,
    pr_number: i64,
    file_path: String,
) -> Result<serde_json::Value, AppError> {
    let token = state.require_token()?;
    let diff = state
        .api
        .pr_file_diff(&token, &owner, &repo, pr_number, &file_path)
        .await?;
    Ok(diff)
}

// --- Self-Review Debrief (cycle 1: local agent↔author loop; ADR-0011) ---
//
// These read/write the shared SQLite store the `stage` CLI authors into, keyed
// by the active repo + its current branch. Auth-free and local: no Stage token,
// no GitHub. `StageError` flows into `AppError` (errors.rs) preserving the
// message verbatim for the client's banner.

/// The stored Debrief for the active repo + branch, or `None` if the agent
/// hasn't authored one.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_debrief_get(state: State<'_, AppState>) -> Result<Option<Debrief>, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    Ok(store.get_debrief(&key)?)
}

/// Review notes for the active repo + branch (optionally filtered by `status`),
/// each carrying its `replies` thread and a computed `outdated` flag.
/// `outdated` is derived against the current Debrief's base (falling back to the
/// repo default branch) — the same `DiffLineIndex` computation as the CLI's
/// `notes` arm so the app and agent agree (ADR-0012), never stored (the
/// **Stale step** pattern, at line granularity).
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_notes_list(
    state: State<'_, AppState>,
    status: Option<NoteStatus>,
) -> Result<Vec<ReviewNoteView>, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    let notes = store.list_notes(&key, status)?;
    let base = match store.get_debrief(&key)? {
        Some(debrief) => debrief.base,
        None => default_base(&path)?,
    };
    let index = DiffLineIndex::from_base_diff(&path, &base)?;
    Ok(notes
        .into_iter()
        .map(|n| {
            let outdated = index.is_outdated(&n.anchor);
            n.into_view(outdated)
        })
        .collect())
}

/// Create an `open` Review note. `anchor` is `None` for general (un-anchored)
/// feedback. The UUID is minted here (the app is the only note author; the
/// store stays uuid-free).
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_note_create(
    state: State<'_, AppState>,
    anchor: Option<NoteAnchor>,
    body: String,
) -> Result<ReviewNote, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    let id = uuid::Uuid::new_v4().to_string();
    Ok(store.create_note(&key, &id, anchor.as_ref(), &body)?)
}

/// Author action: append an author reply to a note's thread. Re-raises an
/// addressed/resolved note to `open`. Fails loud on an unknown id.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_note_reply(
    state: State<'_, AppState>,
    id: String,
    body: String,
) -> Result<ReviewNote, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    Ok(store.add_author_reply(&key, &id, &body)?)
}

/// Author action: close a note (`resolved`). Fails loud on an unknown id.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_note_resolve(
    state: State<'_, AppState>,
    id: String,
) -> Result<ReviewNote, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    Ok(store.resolve_note(&key, &id)?)
}

/// Author action: reopen a note (`open`). Fails loud on an unknown id.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_note_reopen(
    state: State<'_, AppState>,
    id: String,
) -> Result<ReviewNote, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    Ok(store.reopen_note(&key, &id)?)
}

/// Author action: permanently delete a note and its thread. Fails loud on an
/// unknown id.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_note_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    Ok(store.delete_note(&key, &id)?)
}
