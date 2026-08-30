use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use stage_core::diff::{default_base, DiffLineIndex};
use stage_core::{
    repo_key_from_cwd, DebriefView, NoteAnchor, NoteStatus, Review, SelfReviewNote,
    SelfReviewNoteView, Store, StorylinePreview, StorylineStep,
};

use crate::errors::AppError;
use crate::git;
use crate::recents::RecentRepo;
use crate::state::{ActiveRepo, AppState, OpenIntent};
use crate::sync::{self, SyncMsg, SyncStatus};
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

/// Nudge the active repo's sync engine. A no-op without an active repo — the
/// nudge is best-effort freshness, never a correctness dependency.
fn nudge_sync(state: &State<'_, AppState>, msg: SyncMsg) {
    if let Some(active) = state.active.lock().as_ref() {
        active.sync.send(msg);
    }
}

/// A snapshot receiver for the active repo's sync engine.
fn sync_snapshot_rx(
    state: &State<'_, AppState>,
) -> Result<tokio::sync::watch::Receiver<sync::Snapshot>, AppError> {
    state
        .active
        .lock()
        .as_ref()
        .map(|a| a.sync.snapshot_rx())
        .ok_or(AppError::NoActiveRepo)
}

#[derive(Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct RepoInfo {
    pub path: PathBuf,
}

/// When this copy of Stage was built. There are no prebuilt releases — every
/// user builds the app themselves — so the version string alone says nothing
/// about how fresh an installed copy is; the build time does.
#[derive(Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct BuildInfo {
    /// The moment this binary was compiled, as Unix epoch seconds. Baked in by
    /// `src-tauri/build.rs`; a JSON number on the wire (see `Debrief`).
    #[ts(type = "number")]
    pub built_at: i64,
}

/// Report this binary's build time (the About section). The stamp is a
/// compile-time constant from `build.rs`, so there is nothing to fail here.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn build_info() -> BuildInfo {
    // `build.rs` writes this as decimal epoch seconds and fails the build on
    // anything else, so the parse is infallible in practice; a panic here would
    // mean the stamp was corrupted between compile and run.
    let built_at = env!("STAGE_BUILD_TIMESTAMP")
        .parse::<i64>()
        .expect("STAGE_BUILD_TIMESTAMP is stamped as epoch seconds by build.rs");
    BuildInfo { built_at }
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

    // The background sync engine owns this repo's overview snapshot + GitHub
    // poller; the watchers feed it. One engine at a time — replacing the
    // activation drops (aborts) the previous one.
    let engine = sync::spawn(
        app.clone(),
        Arc::clone(&state.github),
        activation.focused.clone(),
        *state.auto_fetch_secs.lock(),
    );

    // Watch the focused worktree (diff refresh). The focused path drives every
    // path-keyed command.
    let watcher = watcher::spawn(
        app.clone(),
        activation.focused.clone(),
        common_dir.clone(),
        engine.sender(),
    )?;

    *state.active.lock() = Some(ActiveRepo {
        path: activation.focused.clone(),
        common_dir,
        watcher,
        sync: engine,
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

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn git_remote_branches(state: State<'_, AppState>) -> Result<Vec<git::BranchInfo>, AppError> {
    let path = active_repo_path(&state)?;
    git::remote_branches(&path)
}

/// Diff a storyline's committed branch (`head_ref`) against its base — the diff
/// the PR will contain (`merge_base(base, head) → head`). Reads no working tree,
/// so it is independent of what is checked out (see `git::committed_diff`).
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn storyline_diff(
    state: State<'_, AppState>,
    base_ref: String,
    head_ref: String,
) -> Result<git::CommittedDiff, AppError> {
    let path = active_repo_path(&state)?;
    git::committed_diff(&path, &base_ref, &head_ref)
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

/// Live Claude Code sessions working in this repo's worktrees — the opt-in
/// branch-table pill (see `agent_sessions.rs`). The probe itself is
/// best-effort by design and never errors; only "no active repo" or a failed
/// worktree enumeration can fail this call.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn agent_sessions(
    state: State<'_, AppState>,
) -> Result<crate::agent_sessions::AgentSessionsView, AppError> {
    let path = active_repo_path(&state)?;
    let worktrees = stage_core::list_worktrees(&path)?;
    Ok(crate::agent_sessions::probe(&worktrees))
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

    // Re-spawn the engine on the newly focused worktree (its HEAD drives the
    // `is_current` flag and the draft keying). GitHub state re-polls promptly.
    let engine = sync::spawn(
        app.clone(),
        Arc::clone(&state.github),
        focused.clone(),
        *state.auto_fetch_secs.lock(),
    );
    let watcher = watcher::spawn(
        app.clone(),
        focused.clone(),
        common_dir.clone(),
        engine.sender(),
    )?;
    *state.active.lock() = Some(ActiveRepo {
        path: focused.clone(),
        common_dir,
        watcher,
        sync: engine,
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

/// Base-branch options for the active repo's Self-Review: the recommended ref
/// (the remote default when fetched), the remote default, the local default +
/// how far it is behind, and the last-fetch time. See ADR-0016 / `stage_core::base`.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_base_options(
    state: State<'_, AppState>,
) -> Result<stage_core::BaseOptions, AppError> {
    let path = active_repo_path(&state)?;
    Ok(stage_core::base_options(&path)?)
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

/// The unified per-repo overview (DB-1..5 #84–88 + the local branch list,
/// ADR-0022 §6/§7): local branches with worktree annotations, per-machine
/// drafts, published Reviews, and my GitHub PRs — one row list, every row's
/// state derived in Rust (TS only buckets and renders).
///
/// Served **from the sync engine's snapshot** — a microsecond read, never a
/// `gh` round-trip. GitHub rows are whatever the engine's last successful poll
/// merged (its degraded state is on [`SyncStatus`], surfaced as a chip, not a
/// failed overview); `github_included: false` still marks a session where
/// GitHub has never been consulted so local work needs no auth (ID-3 #56).
/// `include_archived` flips the DB-5 view filter. Async only to await the
/// engine's **first** pass right after activation.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn overview(
    state: State<'_, AppState>,
    include_archived: bool,
) -> Result<stage_core::OverviewView, AppError> {
    let mut rx = sync_snapshot_rx(&state)?;
    let snap = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        rx.wait_for(|s| s.overview.is_some() || s.status.local_error.is_some()),
    )
    .await
    .map_err(|_| {
        AppError::Backend("overview: timed out waiting for the sync engine's first pass".into())
    })?
    .map_err(|_| AppError::Backend("overview: the sync engine stopped".into()))?
    .clone();

    match snap.overview {
        Some(mut view) => {
            if !include_archived {
                // DB-5 #88: a *view* filter — the snapshot always carries all.
                view.rows.retain(|r| !r.archived);
            }
            Ok(view)
        }
        // First assembly failed: fail loud with the engine's verbatim cause.
        None => {
            Err(AppError::Backend(snap.status.local_error.unwrap_or_else(
                || "overview: no snapshot available".to_string(),
            )))
        }
    }
}

// --- Sync engine surface (freshness status + nudges) --------------------------

/// The sync engine's current status — freshness timestamps, degraded state,
/// the watched PR. The same payload rides on every `sync-updated` event; this
/// command seeds a screen's initial render.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn sync_status(state: State<'_, AppState>) -> Result<SyncStatus, AppError> {
    Ok(sync_snapshot_rx(&state)?.borrow().status.clone())
}

/// Sync now: re-assemble local state and poll GitHub immediately (the manual
/// Fetch action, focus-independent). Returns immediately; results arrive via
/// `sync-updated`.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn sync_now(state: State<'_, AppState>) -> Result<(), AppError> {
    nudge_sync(&state, SyncMsg::LocalChanged);
    nudge_sync(&state, SyncMsg::PollGithubNow);
    Ok(())
}

/// Local Review opened `pr_number` — deep-poll its activity on the poll cadence
/// and push `sync-updated {scope: "pr"}` when it changes.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn sync_watch_pr(state: State<'_, AppState>, pr_number: u32) -> Result<(), AppError> {
    nudge_sync(&state, SyncMsg::WatchPr(pr_number));
    Ok(())
}

/// Local Review closed — stop deep-polling.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn sync_unwatch_pr(state: State<'_, AppState>) -> Result<(), AppError> {
    nudge_sync(&state, SyncMsg::UnwatchPr);
    Ok(())
}

/// Set the background `git fetch` cadence (seconds; 0 = off). Persisted on app
/// state so a repo switch re-seeds the new engine with it.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn sync_set_auto_fetch(state: State<'_, AppState>, seconds: u32) -> Result<(), AppError> {
    *state.auto_fetch_secs.lock() = seconds;
    nudge_sync(&state, SyncMsg::SetAutoFetch(seconds));
    Ok(())
}

/// The unified storyline-staleness check (ST-1 #89) for the active repo+branch:
/// each step's anchor vs. the current committed diff, with a per-step reason.
/// Resolves the Review from the committed `.stage/<branch>/` once published, else
/// the pre-publish draft + its Debrief steps; an empty list means there is no
/// storyline to check. Computed in Rust — nothing auto-fixes (ADR-0022 §7).
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn storyline_staleness(
    state: State<'_, AppState>,
) -> Result<Vec<stage_core::StepStaleness>, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let repo_root = stage_core::repo_root_from_cwd(&path)?;

    // The committed `.stage/<branch>/` folder is authoritative once published;
    // before publish, fall back to the draft + its Debrief steps. No Review for
    // this branch → nothing to check (an empty list, not a failure).
    let resolved = if let Some((_, review)) = stage_core::find_review(&repo_root, &key.branch)? {
        let anchors = review
            .steps
            .into_iter()
            .map(|s| s.anchor)
            .collect::<Vec<_>>();
        Some((review.meta.base_ref, review.meta.head_ref, anchors))
    } else {
        let store = Store::open_default()?;
        match store.get_review_draft(&key)? {
            Some(draft) => {
                let anchors = store
                    .get_debrief(&key)?
                    .map(|d| {
                        d.chapters
                            .into_iter()
                            .flat_map(|c| c.files)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                Some((draft.base_ref, draft.head_ref, anchors))
            }
            None => None,
        }
    };

    let Some((base_ref, head_ref, anchors)) = resolved else {
        return Ok(Vec::new());
    };
    Ok(stage_core::assess_step_staleness(
        &repo_root, &base_ref, &head_ref, &anchors,
    )?)
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

#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn open_in_finder(path: PathBuf) -> Result<(), AppError> {
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|e| AppError::Backend(format!("open_in_finder_failed: {e}")))
}

/// Open a path — in practice a worktree directory — in Visual Studio Code.
///
/// macOS goes through `open -a` rather than the `code` CLI: a GUI-launched app
/// inherits a minimal PATH, and `code` only lands on PATH for login shells that
/// ran VS Code's "Install 'code' command". Elsewhere `code` is the route there
/// is. Either way the exit status is checked and a failure is raised, so a
/// missing editor reaches the author's banner instead of looking like a dead
/// menu entry (CLAUDE.md fail-loud).
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn open_in_vscode(path: PathBuf) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg("-a").arg("Visual Studio Code").arg(&path);
        c
    };
    #[cfg(not(target_os = "macos"))]
    let mut cmd = {
        let mut c = std::process::Command::new("code");
        c.arg(&path);
        c
    };

    let output = cmd.output().map_err(|e| {
        tracing::error!(err = %e, path = %path.display(), "open_in_vscode_spawn_failed");
        AppError::Backend(format!(
            "Couldn't open {} in VS Code — {e}. Is Visual Studio Code installed?",
            path.display()
        ))
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        tracing::error!(
            path = %path.display(),
            status = %output.status,
            stderr = %stderr,
            "open_in_vscode_failed"
        );
        return Err(AppError::Backend(format!(
            "Couldn't open {} in VS Code — {}",
            path.display(),
            if stderr.is_empty() {
                "the editor exited with an error. Is Visual Studio Code installed?".to_string()
            } else {
                stderr
            }
        )));
    }
    Ok(())
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

// --- Self-Review Debrief (cycle 1: local agent↔author loop; ADR-0011) ---
//
// These read/write the shared SQLite store the `stage` CLI authors into, keyed
// by the active repo + its current branch. Auth-free and local: no Stage token,
// no GitHub. `StageError` flows into `AppError` (errors.rs) preserving the
// message verbatim for the client's banner.

/// The stored Debrief for the active repo + branch (with its derived
/// freshness chip — new/seen/outdated against the branch's current head), or
/// `None` if the agent hasn't authored one.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_debrief_get(
    state: State<'_, AppState>,
) -> Result<Option<DebriefView>, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    let Some(debrief) = store.get_debrief(&key)? else {
        return Ok(None);
    };
    let freshness = debrief.freshness(&stage_core::branch_head_sha(&path, &key.branch)?);
    Ok(Some(debrief.into_view(freshness)))
}

/// Record that the author opened the Debrief (freshness `new` → `seen`).
/// Idempotent; `None` when there is no Debrief to mark.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_debrief_mark_seen(
    state: State<'_, AppState>,
) -> Result<Option<DebriefView>, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    let Some(debrief) = store.mark_debrief_seen(&key)? else {
        return Ok(None);
    };
    let freshness = debrief.freshness(&stage_core::branch_head_sha(&path, &key.branch)?);
    Ok(Some(debrief.into_view(freshness)))
}

/// Branch names that have a stored Debrief for the active repo. Branch-agnostic:
/// keyed on the repo's (owner, name) identity (repo-wide), so the branch list can
/// flag which branches carry a Debrief in one call rather than per-branch. A
/// Debrief is a branch property, so detached worktrees (no branch) never match.
/// Auth-free + local, like the other Debrief commands.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn repo_debrief_branches(state: State<'_, AppState>) -> Result<Vec<String>, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    Ok(store.list_debrief_branches(&key.repo_owner, &key.repo_name)?)
}

// --- Self-Review viewed marks + done state (v6-light L2; F2/F2b/F3) ---------
//
// Viewed marks live in the shared SQLite store, content-anchored to the
// post-image blob the author saw (`stage_core::viewed`). The active repo path
// doubles as the working tree to hash from when `branch` is the checked-out
// branch there; any other branch anchors at its tip.

/// The store key + optional working tree for a viewed-mark command. The
/// working tree only counts for the branch actually checked out at the active
/// repo path — other branches hash against their tip.
fn viewed_ctx(
    state: &State<'_, AppState>,
    branch: &str,
) -> Result<(PathBuf, stage_core::RepoKey, Option<PathBuf>), AppError> {
    let path = active_repo_path(state)?;
    let current = repo_key_from_cwd(&path)?;
    let worktree = (branch == current.branch).then(|| path.clone());
    let key = stage_core::RepoKey {
        branch: branch.to_string(),
        ..current
    };
    Ok((path, key, worktree))
}

/// The currently-valid viewed files for a branch: stored marks whose content
/// anchor still matches the file's post-image (F2b — an edited file counts as
/// unviewed again). Stale marks are ignored, not deleted.
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_viewed_list(
    state: State<'_, AppState>,
    branch: String,
) -> Result<Vec<String>, AppError> {
    let (path, key, worktree) = viewed_ctx(&state, &branch)?;
    let store = Store::open_default()?;
    let repo = git2::Repository::discover(&path)
        .map_err(|e| AppError::Backend(format!("viewed_list: not a repository: {e}")))?;
    let mut valid = Vec::new();
    for mark in store.list_viewed(&key)? {
        let current =
            stage_core::current_post_image_oid(&repo, worktree.as_deref(), &branch, &mark.file)?;
        if current == mark.blob_oid {
            valid.push(mark.file);
        }
    }
    Ok(valid)
}

/// Set or clear one viewed mark. Marking anchors to the file's current
/// post-image (what the author is looking at right now).
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_viewed_set(
    state: State<'_, AppState>,
    branch: String,
    file: String,
    viewed: bool,
) -> Result<(), AppError> {
    let (path, key, worktree) = viewed_ctx(&state, &branch)?;
    let store = Store::open_default()?;
    if viewed {
        let repo = git2::Repository::discover(&path)
            .map_err(|e| AppError::Backend(format!("viewed_set: not a repository: {e}")))?;
        let oid = stage_core::current_post_image_oid(&repo, worktree.as_deref(), &branch, &file)?;
        store.set_viewed(&key, &file, &oid)?;
    } else {
        store.unset_viewed(&key, &file)?;
    }
    // The FS watcher can't see the SQLite store move — nudge the snapshot so
    // the overview's viewed-progress pill tracks the marks.
    nudge_sync(&state, SyncMsg::LocalChanged);
    Ok(())
}

/// Remove every viewed mark for a branch ("Clear viewed").
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_viewed_clear(
    state: State<'_, AppState>,
    branch: String,
) -> Result<(), AppError> {
    let (_path, key, _worktree) = viewed_ctx(&state, &branch)?;
    let store = Store::open_default()?;
    store.clear_viewed(&key)?;
    nudge_sync(&state, SyncMsg::LocalChanged);
    Ok(())
}

/// One-time import of the legacy webview-store viewed marks (F2 migration).
/// Each file is stamped with its *current* post-image OID — "viewed as of
/// now". Returns the number imported; the webview clears its legacy source
/// only on success (a failed import must stay retryable).
#[tauri::command]
// `pill = "cmd"` tags this span so the dev Activity-log layer records one row
// per invocation with its duration (debug builds only). `skip_all` keeps the
// non-Debug args (State/AppHandle) out of the span. See `activity_log.rs`.
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn self_review_viewed_import_legacy(
    state: State<'_, AppState>,
    marks_by_branch: std::collections::HashMap<String, Vec<String>>,
) -> Result<u32, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    let imported = stage_core::import_legacy_viewed(
        &store,
        &path,
        &key.repo_owner,
        &key.repo_name,
        &key.branch,
        &marks_by_branch,
    )?;
    tracing::info!(imported, "viewed_import_legacy_done");
    nudge_sync(&state, SyncMsg::LocalChanged);
    Ok(imported)
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
) -> Result<Vec<SelfReviewNoteView>, AppError> {
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
) -> Result<SelfReviewNote, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    let id = uuid::Uuid::new_v4().to_string();
    let note = store.create_note(&key, &id, anchor.as_ref(), &body)?;
    // Same reason as `self_review_viewed_set`: the FS watcher can't be relied
    // on to see the SQLite store move, and the note count drives the overview's
    // "self-review · started" pill — nudge so the row reflects it immediately.
    nudge_sync(&state, SyncMsg::LocalChanged);
    Ok(note)
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
) -> Result<SelfReviewNote, AppError> {
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
) -> Result<SelfReviewNote, AppError> {
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
) -> Result<SelfReviewNote, AppError> {
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
    store.delete_note(&key, &id)?;
    // Deleting the last note drops the row back to "not started" — same
    // snapshot nudge as `self_review_note_create`.
    nudge_sync(&state, SyncMsg::LocalChanged);
    Ok(())
}

// --- Draft Review + storyline (local, no auth — ADR-0022 §1/§3, milestone B) -
//
// The author's local, pre-publish storyline lives entirely in the SQLite store,
// keyed by the active repo + branch (same `repo_key_from_cwd` keying the Debrief
// commands use). No `gh`, no network, no sign-in (ID-3 #56): `gh` is only invoked
// when a GitHub action is taken (Publish, milestone D). Single-writer (ADR-0022
// §2): the store is the only home for a pre-publish storyline, so composing
// requires the Ready-to-share draft to exist — these commands fail loud (the
// `StageError` message surfaces verbatim in the client banner) rather than
// inventing one.

/// The draft Review for the active repo + branch, or `None` if "Ready to share"
/// hasn't been triggered on this machine for this branch (WS-2 #60).
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn review_draft_get(state: State<'_, AppState>) -> Result<Option<Review>, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    Ok(store.get_review_draft(&key)?)
}

/// The **Ready to share** transition (WS-2 #60): create the per-machine draft
/// Review for the active repo + branch. `base_ref` is the comparison/PR-target
/// branch (the picker seeds it from `self_review_base_options`). Fails loud if a
/// draft already exists — "Ready to share" is one-time, not an upsert.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn review_draft_create(
    state: State<'_, AppState>,
    title: String,
    base_ref: String,
) -> Result<Review, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    let review = store.create_review_draft(&key, &title, &base_ref)?;
    // Skip the store watcher's debounce so the new draft row lands promptly.
    nudge_sync(&state, SyncMsg::LocalChanged);
    Ok(review)
}

/// Rename the draft Review (WS-3 #61) — the human-readable title only. Fails loud
/// if no draft exists.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn review_draft_set_title(
    state: State<'_, AppState>,
    title: String,
) -> Result<Review, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    let review = store.set_review_title(&key, &title)?;
    nudge_sync(&state, SyncMsg::LocalChanged);
    Ok(review)
}

/// Discard the draft Review (GAP-1 #91): pre-publish only — deletes the draft row
/// and its storyline steps cascade out of view. Idempotent (returns whether a row
/// was removed). An *open PR* is closed/merged on GitHub, never "discarded".
///
/// `branch: None` targets the focused worktree's branch; `Some` overrides it so
/// the overview can discard a draft for a branch that isn't checked out here
/// (e.g. its worktree was removed) — otherwise abandoned prep would linger with
/// no way to clear it (#91's whole point).
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn review_draft_discard(
    state: State<'_, AppState>,
    branch: Option<String>,
) -> Result<bool, AppError> {
    let path = active_repo_path(&state)?;
    let mut key = repo_key_from_cwd(&path)?;
    if let Some(branch) = branch {
        key.branch = branch;
    }
    let store = Store::open_default()?;
    let removed = store.discard_review_draft(&key)?;
    nudge_sync(&state, SyncMsg::LocalChanged);
    Ok(removed)
}

/// Change the draft Review's base (target) branch pre-publish (GAP-2 #92). The
/// composer's base picker calls this; once published the base is the PR's merge
/// target and is changed on GitHub, not here. Fails loud if no draft exists.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn review_draft_set_base(
    state: State<'_, AppState>,
    base_ref: String,
) -> Result<Review, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    let review = store.set_review_base_ref(&key, &base_ref)?;
    nudge_sync(&state, SyncMsg::LocalChanged);
    Ok(review)
}

/// The draft storyline steps for the active repo + branch, in author order
/// (SL-1 #65). Empty when nothing has been composed yet.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn storyline_steps(state: State<'_, AppState>) -> Result<Vec<StorylineStep>, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    Ok(store.list_storyline_steps(&key)?)
}

/// Compose a step (SL-1 #65 / SL-2 #66): append a step anchored to `anchor` with
/// `intro` (markdown) and an optional `title`. Fails loud if `anchor` isn't a file
/// in the committed diff, if a step already anchors it, or if there's no draft.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn storyline_step_add(
    state: State<'_, AppState>,
    anchor: String,
    title: Option<String>,
    intro: String,
) -> Result<StorylineStep, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    Ok(stage_core::storyline::add_step(
        &store,
        &path,
        &key,
        &anchor,
        title.as_deref(),
        &intro,
    )?)
}

/// Edit a step's `title` and `intro` (SL-2 #66 / SL-3 #67). `title: null` clears
/// the heading. The anchor and order are untouched. Fails loud on an unknown id.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn storyline_step_edit(
    state: State<'_, AppState>,
    id: String,
    title: Option<String>,
    intro: String,
) -> Result<StorylineStep, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    Ok(store.edit_storyline_step(&key, &id, title.as_deref(), &intro)?)
}

/// Remove a step from the draft storyline (SL-3 #67). Fails loud on an unknown id.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn storyline_step_remove(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    Ok(store.remove_storyline_step(&key, &id)?)
}

/// Reorder the draft storyline to exactly `ordered_ids` (SL-3 #67). Fails loud
/// unless the list is a permutation of the current step ids (no silent drop).
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn storyline_steps_reorder(
    state: State<'_, AppState>,
    ordered_ids: Vec<String>,
) -> Result<Vec<StorylineStep>, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    Ok(store.reorder_storyline_steps(&key, &ordered_ids)?)
}

/// The author-side local storyline **preview** (SL-4 #68 author side + GAP-4
/// #94): the full committed tree-to-tree diff, the ordered steps (each with a
/// computed `stale` flag), and the un-anchored diff paths still reachable as an
/// overlay. All derived state is computed in Rust (ADR-0022 §7). Fails loud if
/// there's no Ready-to-share draft.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn storyline_preview(state: State<'_, AppState>) -> Result<StorylinePreview, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    Ok(stage_core::storyline::preview(&store, &path, &key)?)
}

/// Open `pr` for review against the active repo's clone, **read-only**
/// (ADR-0022 §6, milestone F): resolve the PR via `gh`, fetch its head, and
/// render the tree-to-tree diff + the author's storyline read from the committed
/// `.stage/<branch>/` — no working-tree mutation. The view-ready
/// [`stage_core::ReviewerEntry`] is computed entirely in Rust; the webview only
/// renders it (ADR-0022 §7). Async (ADR-0023): the blocking `gh`/`git` work runs
/// in `spawn_blocking`, off the UI thread, while the webview shows a spinner.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn review_open(
    state: State<'_, AppState>,
    pr: stage_core::PrRef,
) -> Result<stage_core::ReviewerEntry, AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<stage_core::ReviewerEntry, AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        Ok(stage_core::open_review(&github, &repo_root, &pr)?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("review_open_join_error: {e}")))?
}

/// Check out the PR's `branch` in the active repo (`git checkout -B`) — **the
/// lone working-tree mutation the reviewer flow performs** (ADR-0022 §6), so the
/// reviewer can build/run. The webview gates this behind an explicit "Check out
/// this branch" confirmation; everything else stays read-only. Fail loud (git's
/// stderr verbatim) on a dirty tree or a missing fetched head.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn review_checkout_branch(
    state: State<'_, AppState>,
    pr: stage_core::PrRef,
    branch: String,
) -> Result<(), AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        stage_core::checkout_pr_branch(&github, &repo_root, &pr, &branch)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Backend(format!("review_checkout_branch_join_error: {e}")))?
}

// --- Explicit branch switch (v6-light L3, ADR-0027 as amended) ----------------
//
// The one user-initiated working-tree switch. Strictly two-phase: `plan` lists
// the exact git commands for the confirmation dialog; `execute` re-derives and
// runs them. Both run in `spawn_blocking` (ADR-0023) — they shell out to git.

/// Plan a switch of the focused worktree to `branch`: the exact steps that
/// would run, or the structured "checked out elsewhere" outcome the UI answers
/// with a "focus that worktree" affordance. Mutates nothing.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn branch_switch_plan(
    state: State<'_, AppState>,
    branch: String,
) -> Result<stage_core::SwitchPlanOutcome, AppError> {
    let path = active_repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<_, AppError> {
        Ok(stage_core::switch_plan(&path, &branch)?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("branch_switch_plan_join_error: {e}")))?
}

/// Execute a confirmed switch (stash → checkout → pop, per the plan the user
/// approved). Fail loud with git's verbatim stderr; a pop conflict leaves the
/// stash entry intact and the error names it. Nudges the sync engine — HEAD
/// moved, so every snapshot input changed.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn branch_switch_execute(
    state: State<'_, AppState>,
    branch: String,
) -> Result<stage_core::SwitchOutcome, AppError> {
    let path = active_repo_path(&state)?;
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<_, AppError> {
        Ok(stage_core::switch_execute(&path, &branch)?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("branch_switch_execute_join_error: {e}")))?;
    // Nudge even when the pop failed loudly — the checkout may still have
    // happened, and the snapshot must reflect the tree as it now is.
    nudge_sync(&state, SyncMsg::LocalChanged);
    result
}

// --- Explicit branch push (ADR-0029) ------------------------------------------
//
// The standalone counterpart to the switch pair above, and the same two-phase
// shape: `plan` inspects and lists the exact git command for the confirmation,
// `execute` re-derives it and runs it. Both in `spawn_blocking` (ADR-0023) —
// planning reads refs off disk, and the push itself is network I/O over the
// user's own git credentials.

/// Plan the push of `branch`: the exact command that would run, or the
/// structured "nothing to push" / "diverged" state the UI reports instead of
/// offering a confirm. Mutates nothing and touches no network — the counts come
/// from refs on disk, so they are as fresh as the last fetch.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn branch_push_plan(
    state: State<'_, AppState>,
    branch: String,
) -> Result<stage_core::PushPlanOutcome, AppError> {
    let path = active_repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<_, AppError> {
        Ok(stage_core::push_plan(&path, &branch)?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("branch_push_plan_join_error: {e}")))?
}

/// Execute a confirmed push. Fails loud with git's verbatim stderr (a rejected
/// non-fast-forward, a protected branch, a missing credential). On success the
/// remote moved, so re-poll GitHub — a PR's head, checks and mergeability all
/// just changed.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn branch_push_execute(
    state: State<'_, AppState>,
    branch: String,
) -> Result<stage_core::PushOutcome, AppError> {
    let path = active_repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<_, AppError> {
        Ok(stage_core::push_execute(&path, &branch)?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("branch_push_execute_join_error: {e}")))?
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}

// --- Branch graph (v6-light L6) ------------------------------------------------

/// Assemble the branch graph: bounded commit topology with lane geometry,
/// computed fresh per call (no sync-engine integration in light — the view
/// recomputes on open and on `sync-updated`). Read-only; runs off the UI
/// thread (ADR-0023) — the walk is blocking git I/O.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn branch_graph(
    state: State<'_, AppState>,
) -> Result<stage_core::BranchGraphView, AppError> {
    let path = active_repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<_, AppError> {
        Ok(stage_core::branch_graph(&path)?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("branch_graph_join_error: {e}")))?
}

// --- Identity (ADR-0022 §5, milestone C) -------------------------------------
//
// Stage holds no account/session/token. "Who am I" is just the `gh` token owner,
// resolved via `gh api user` and cached for the adapter's lifetime. The webview
// reads this to label the active user; there is no sign-in.

/// The `gh` token owner (ADR-0022 §5) — Stage's whole identity model: no Stage
/// account, no session, just the local `gh`'s authenticated user. Fails loud with
/// `gh`'s real message when `gh` is absent or unauthenticated (no broker fallback).
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn gh_identity(state: State<'_, AppState>) -> Result<stage_core::GitHubUser, AppError> {
    let github = Arc::clone(&state.github);
    // First call runs `gh auth status` + `gh api user` (network); cached after.
    // Keep even that one-time hit off the UI thread (ADR-0023).
    tauri::async_runtime::spawn_blocking(move || -> Result<stage_core::GitHubUser, AppError> {
        Ok(github.current_user()?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("gh_identity_join_error: {e}")))?
}

// --- Publish (PUB-1..7, ADR-0022 §3/§7, milestone D) -------------------------
//
// The one-action publish: serialize the local draft storyline into
// `.stage/<branch>/`, scoped-commit, push with the user's own git credentials,
// and create/update/reopen the PR via `gh` (auto-posting the single "Open in
// Stage" comment on first create). All lifecycle transitions are computed in Rust
// (ADR-0022 §7); the gate and every gh/git failure fail loud (StageError →
// AppError, message verbatim). The several back-to-back gh/git network ops run
// in `spawn_blocking`, off the UI thread (ADR-0023); the webview shows a spinner.

/// Whether the active repo+branch's draft storyline is ready to publish (PUB-2
/// #73): **≥1 step and every step has a non-empty intro**. Computed from the
/// draft's storyline, never stored; `review_publish` enforces the same rule.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn publish_readiness(
    state: State<'_, AppState>,
) -> Result<stage_core::PublishReadiness, AppError> {
    let path = active_repo_path(&state)?;
    let key = repo_key_from_cwd(&path)?;
    let store = Store::open_default()?;
    let steps = store.list_storyline_steps(&key)?;
    Ok(stage_core::assess_publish_readiness(&steps))
}

/// The uncommitted working-tree changes Publish would leave out of the PR
/// (ADR-0024): staged, unstaged-tracked, and untracked (non-ignored) paths,
/// `.stage/` excluded. The publish modal lists these so the author picks an
/// explicit disposition; `review_publish` enforces the same rule in the engine.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub fn publish_uncommitted(
    state: State<'_, AppState>,
) -> Result<Vec<stage_core::UncommittedFile>, AppError> {
    let path = active_repo_path(&state)?;
    let repo_root = stage_core::repo_root_from_cwd(&path)?;
    Ok(stage_core::assess_uncommitted_work(&repo_root)?)
}

/// Publish (or re-publish) the active repo+branch's draft Review to GitHub
/// (PUB-1 #72): write the storyline into `.stage/<branch>/`, scoped-commit, push,
/// and create/update/reopen the PR via `gh`. The PR title/body/base come from
/// `req`; the Review title + draft state come from the local store. Fails loud on
/// a not-ready draft (same gate as `publish_readiness`) or any gh/git failure.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn review_publish(
    state: State<'_, AppState>,
    req: stage_core::PublishRequest,
) -> Result<stage_core::PublishOutcome, AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<stage_core::PublishOutcome, AppError> {
        let key = repo_key_from_cwd(&path)?;
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        let store = Store::open_default()?;
        Ok(stage_core::publish_review(
            &store, &github, &repo_root, &key, &req,
        )?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("review_publish_join_error: {e}")))?
    // A successful GitHub write: re-poll so the overview reflects it promptly.
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}

// --- Native GitHub review & verdict (RW-1..5, ADR-0022 §4/§8, milestone E) ----
//
// The reviewer's write-through to GitHub via the user's own `gh` (no backend).
// All operate on the active repo's clone (`repo_root`) — the clone `stage open`
// resolved for the PR — and a bare PR number; `gh` resolves owner/repo from the
// repo's remote. Verdict/comment writes fail loud with `gh`'s message verbatim.

/// Read everything the reviewer needs about a PR's existing activity in one shot
/// (RW-4): state, verdict decision, reviews, conversation + line comments, checks.
///
/// `prefer_cached: true` serves the sync engine's deep-poll cache when it holds
/// this PR (the event-driven reload path — the engine literally just fetched
/// it). `false` always re-fetches (mount, and after the viewer's own writes,
/// where serving a pre-write cache would hide their action) and feeds the
/// result back to the engine so its change detection has the newest baseline.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_activity(
    state: State<'_, AppState>,
    pr_number: u32,
    prefer_cached: bool,
) -> Result<stage_core::PrActivity, AppError> {
    if prefer_cached {
        if let Ok(rx) = sync_snapshot_rx(&state) {
            let cached = rx.borrow().pr.clone();
            if let Some(entry) = cached {
                // The sanity bound keeps a long-dormant cache from serving (the
                // engine polls far more often than this while watching).
                if entry.number == pr_number
                    && entry.fetched_at.elapsed() < std::time::Duration::from_secs(60)
                {
                    return Ok(entry.activity);
                }
            }
        }
    }
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    let activity = tauri::async_runtime::spawn_blocking(
        move || -> Result<stage_core::PrActivity, AppError> {
            let repo_root = stage_core::repo_root_from_cwd(&path)?;
            Ok(github.read_pr_activity(&repo_root, pr_number)?)
        },
    )
    .await
    .map_err(|e| AppError::Backend(format!("pr_activity_join_error: {e}")))??;
    nudge_sync(
        &state,
        SyncMsg::PrFetched(pr_number, Box::new(activity.clone())),
    );
    Ok(activity)
}

/// Submit the overall review **verdict** (RW-3, ADR-0022 §8): `approve` /
/// `requestChanges` / `comment`, with a summary `body` and an optional batch of
/// line comments. `requestChanges`/`comment` require a non-empty body (enforced).
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_submit_verdict(
    state: State<'_, AppState>,
    pr_number: u32,
    verdict: stage_core::Verdict,
    body: String,
    comments: Vec<stage_core::DraftLineComment>,
) -> Result<stage_core::SubmittedVerdict, AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(
        move || -> Result<stage_core::SubmittedVerdict, AppError> {
            let repo_root = stage_core::repo_root_from_cwd(&path)?;
            Ok(github.submit_verdict(&repo_root, pr_number, verdict, &body, &comments)?)
        },
    )
    .await
    .map_err(|e| AppError::Backend(format!("pr_submit_verdict_join_error: {e}")))?
    // A successful GitHub write: re-poll so the overview reflects it promptly.
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}

/// Post a single inline review comment anchored to a diff line (RW-2).
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_comment_on_line(
    state: State<'_, AppState>,
    pr_number: u32,
    comment: stage_core::DraftLineComment,
) -> Result<stage_core::LineComment, AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<stage_core::LineComment, AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        Ok(github.comment_on_line(&repo_root, pr_number, &comment)?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("pr_comment_on_line_join_error: {e}")))?
    // A successful GitHub write: re-poll so the overview reflects it promptly.
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}

/// Post a file-level review comment (RW-2) — not anchored to a specific line.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_comment_on_file(
    state: State<'_, AppState>,
    pr_number: u32,
    path: String,
    body: String,
) -> Result<stage_core::LineComment, AppError> {
    let repo = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<stage_core::LineComment, AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&repo)?;
        Ok(github.comment_on_file(&repo_root, pr_number, &path, &body)?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("pr_comment_on_file_join_error: {e}")))?
    // A successful GitHub write: re-poll so the overview reflects it promptly.
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}

/// Merge the PR (RW-5) with the given method (`merge`/`squash`/`rebase`).
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_merge(
    state: State<'_, AppState>,
    pr_number: u32,
    method: stage_core::MergeMethod,
) -> Result<(), AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        github.merge_pr(&repo_root, pr_number, method)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Backend(format!("pr_merge_join_error: {e}")))?
    // A successful GitHub write: re-poll so the overview reflects it promptly.
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}

/// Close the PR without merging (RW-5).
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_close(state: State<'_, AppState>, pr_number: u32) -> Result<(), AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        github.close_pr(&repo_root, pr_number)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Backend(format!("pr_close_join_error: {e}")))?
    // A successful GitHub write: re-poll so the overview reflects it promptly.
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}

/// Flip the PR's draft status (RW-5): `true` → mark draft, `false` → ready.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_set_draft(
    state: State<'_, AppState>,
    pr_number: u32,
    draft: bool,
) -> Result<(), AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        github.set_pr_draft(&repo_root, pr_number, draft)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Backend(format!("pr_set_draft_join_error: {e}")))?
    // A successful GitHub write: re-poll so the overview reflects it promptly.
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}

// --- Per-step PR discussion (IC-1..3, ADR-0022 §4, milestone E) ---------------
//
// Step discussion is GitHub PR review threads, code-anchored to each step's diff
// location (IntroComment is removed, ADR-0022 §8). The reviewer/author read the
// threads grouped by storyline step (passing the steps' anchors, already known
// to the webview from the reviewer entry / draft storyline) and post/resolve via
// `gh`. Edit/delete/resolve capabilities are GitHub-computed per comment (IC-3).

/// The PR's review threads mapped onto the storyline (IC-1): each `step_anchor`
/// gets the threads anchored at its diff location; threads anchored elsewhere
/// land in `unanchored` (never dropped). `step_anchors` are the steps' diff paths
/// the webview already holds (from the reviewer entry or the draft storyline).
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_discussion(
    state: State<'_, AppState>,
    pr_number: u32,
    step_anchors: Vec<String>,
) -> Result<stage_core::PrDiscussion, AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<stage_core::PrDiscussion, AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        let threads = github.read_pr_threads(&repo_root, pr_number)?;
        Ok(stage_core::group_threads_by_step(&step_anchors, threads))
    })
    .await
    .map_err(|e| AppError::Backend(format!("pr_discussion_join_error: {e}")))?
}

/// Start a new code-anchored discussion thread on a step (IC-1): a line comment
/// when `line` is set, else a file-level comment. `anchor` is the step's diff path.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_start_thread(
    state: State<'_, AppState>,
    pr_number: u32,
    anchor: String,
    line: Option<u32>,
    side: Option<stage_core::Side>,
    body: String,
) -> Result<stage_core::LineComment, AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<stage_core::LineComment, AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        Ok(github.start_step_thread(&repo_root, pr_number, &anchor, line, side, &body)?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("pr_start_thread_join_error: {e}")))?
    // A successful GitHub write: re-poll so the overview reflects it promptly.
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}

/// Reply to an existing thread (IC-1), addressing its root comment id.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_reply_thread(
    state: State<'_, AppState>,
    pr_number: u32,
    in_reply_to: u64,
    body: String,
) -> Result<stage_core::ThreadComment, AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<stage_core::ThreadComment, AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        Ok(github.reply_to_thread(&repo_root, pr_number, in_reply_to, &body)?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("pr_reply_thread_join_error: {e}")))?
    // A successful GitHub write: re-poll so the overview reflects it promptly.
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}

/// Resolve a review thread (IC-2), by its GraphQL node id. Returns whether the
/// thread's resolution state changed.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_resolve_thread(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<bool, AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        Ok(github.resolve_thread(&repo_root, &thread_id)?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("pr_resolve_thread_join_error: {e}")))?
    // A successful GitHub write: re-poll so the overview reflects it promptly.
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}

/// Reopen a resolved review thread (IC-2), by its GraphQL node id.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_reopen_thread(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<bool, AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        Ok(github.reopen_thread(&repo_root, &thread_id)?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("pr_reopen_thread_join_error: {e}")))?
    // A successful GitHub write: re-poll so the overview reflects it promptly.
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}

/// Edit one's own thread comment (IC-3), by its REST comment id. GitHub enforces
/// authorship; the webview shows the affordance only when `viewerCanUpdate`.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_edit_comment(
    state: State<'_, AppState>,
    comment_id: u64,
    body: String,
) -> Result<stage_core::ThreadComment, AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<stage_core::ThreadComment, AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        Ok(github.edit_comment(&repo_root, comment_id, &body)?)
    })
    .await
    .map_err(|e| AppError::Backend(format!("pr_edit_comment_join_error: {e}")))?
    // A successful GitHub write: re-poll so the overview reflects it promptly.
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}

/// Delete one's own thread comment (IC-3), by its REST comment id. GitHub
/// enforces authorship; gated in the webview by `viewerCanDelete`.
#[tauri::command]
#[cfg_attr(debug_assertions, tracing::instrument(skip_all, fields(pill = "cmd")))]
pub async fn pr_delete_comment(
    state: State<'_, AppState>,
    comment_id: u64,
) -> Result<(), AppError> {
    let path = active_repo_path(&state)?;
    let github = Arc::clone(&state.github);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let repo_root = stage_core::repo_root_from_cwd(&path)?;
        github.delete_comment(&repo_root, comment_id)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Backend(format!("pr_delete_comment_join_error: {e}")))?
    // A successful GitHub write: re-poll so the overview reflects it promptly.
    .inspect(|_| nudge_sync(&state, SyncMsg::PollGithubNow))
}
