pub mod activity_log;
mod agent_sessions;
mod commands;
mod errors;
mod git;
mod recents;
mod repo_activation;
mod state;
mod sync;
mod watcher;

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use crate::recents::RecentsStore;
use crate::state::{AppState, OpenIntent, OpenMode};

/// Parse a `stage open <repo-root> [--review <owner>/<repo>#<n>]` invocation out
/// of a process argv (the program name is `argv[0]`). Returns the open-intent, or
/// `None` for a plain launch (dock/Finder). With `--review` the mode is
/// `Review` and `pr` carries the resolved PR (ADR-0022 §6); otherwise it is a
/// Self-Review open. Shared by cold start (`setup`) and the warm-start
/// single-instance callback (ADR-0014).
fn parse_open_intent(argv: &[String]) -> Option<OpenIntent> {
    let mut it = argv.iter().skip(1);
    while let Some(arg) = it.next() {
        if arg == "open" {
            // The next token is the canonical repo root the CLI resolved.
            let repo = PathBuf::from(it.next()?);
            // Optional `--review <owner>/<repo>#<number>` → read-only review mode.
            // The CLI emits the `owner/repo#n` shorthand `parse_pr_ref` accepts.
            let mut pr = None;
            let mut mode = OpenMode::SelfReview;
            while let Some(flag) = it.next() {
                if flag == "--review" {
                    if let Some(p) = it.next().and_then(|s| stage_core::parse_pr_ref(s).ok()) {
                        pr = Some(p);
                        mode = OpenMode::Review;
                    }
                }
            }
            return Some(OpenIntent { repo, mode, pr });
        }
    }
    None
}

pub fn run() {
    // Base console logging (unchanged). A second layer fans the same events
    // into the in-app Activity log ring — in release builds too, so the drawer
    // is a real diagnostic on a shipped app (⌘`). Both layers are scoped by
    // their own filter so the fmt layer keeps its existing verbosity.
    let fmt_layer = tracing_subscriber::fmt::layer().with_filter(
        EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info,stage_client_lib=debug")),
    );

    let activity_log = Arc::new(activity_log::ActivityLog::new());

    let subscriber = tracing_subscriber::registry().with(fmt_layer);
    // The ring layer captures DEBUG+ from our crate only — that's where the
    // http/git/cmd/rust pills come from; dependency noise stays out.
    let subscriber = subscriber.with(
        activity_log::ActivityLogLayer::new(activity_log.clone())
            .with_filter(EnvFilter::new("stage_client_lib=debug")),
    );
    let _ = subscriber.try_init();

    tauri::Builder::default()
        // Single-instance MUST be the first plugin (plugin docs): a second
        // `stage open` forwards its argv here instead of starting a new process.
        // We record the intent, surface the existing window, and push it live to
        // the webview (warm start; ADR-0014). Cold start is handled in `setup`.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let Some(intent) = parse_open_intent(&argv) else {
                return;
            };
            *app.state::<AppState>().pending_open.lock() = Some(intent.clone());
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            if let Err(e) = app.emit("open-intent", intent) {
                tracing::error!(err = %e, "open_intent_emit_failed");
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        // Custom app menu. Setting a menu replaces the OS default wholesale, so
        // we rebuild the standard macOS submenus (Edit/Window) to keep native
        // copy/paste/undo/quit working, and inject "Settings…" (⌘,) into the app
        // menu. The item emits `open-settings` to the webview, which routes to
        // the Settings view (the second entry point is the in-app RepoMenu).
        .menu(|handle| {
            let settings = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+Comma")
                .build(handle)?;
            let app_menu = SubmenuBuilder::new(handle, "Stage")
                .about(Some(AboutMetadata {
                    name: Some("Stage".into()),
                    ..Default::default()
                }))
                .separator()
                .item(&settings)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;
            MenuBuilder::new(handle)
                .items(&[&app_menu, &edit_menu, &window_menu])
                .build()
        })
        // The sync engine adapts its GitHub poll cadence to window focus
        // (~30s focused, minutes unfocused, an immediate poll on regain).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                use tauri::Manager;
                if let Some(active) = window
                    .app_handle()
                    .state::<AppState>()
                    .active
                    .lock()
                    .as_ref()
                {
                    active
                        .sync
                        .send(crate::sync::SyncMsg::WindowFocus(*focused));
                }
            }
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "settings" {
                // Fail-loud (CLAUDE.md): a failed emit means the menu item is
                // dead — log it rather than swallow.
                if let Err(e) = app.emit("open-settings", ()) {
                    tracing::error!(err = %e, "open_settings_emit_failed");
                }
            }
        })
        .setup(move |app| {
            // Stream new ring entries to the webview once the app handle exists.
            // Records before this point still land in the ring (always-on).
            activity_log.set_app(app.handle().clone());

            let data_dir = app
                .path()
                .app_data_dir()
                .expect("app_data_dir resolves on supported platforms");
            std::fs::create_dir_all(&data_dir)?;

            let recents = RecentsStore::open(&data_dir)?;

            // Cold start: this process *is* the primary, so parse our own argv
            // for a `stage open` request (ADR-0014). Warm starts arrive via the
            // single-instance callback above instead.
            let pending_open = parse_open_intent(&std::env::args().collect::<Vec<_>>());

            app.manage(AppState {
                active: Mutex::new(None),
                recents: Arc::new(recents),
                // Off until the webview seeds it from its persisted setting.
                auto_fetch_secs: Mutex::new(0),
                // Shared credential-free GitHub adapter (ADR-0022 §5): its `gh`
                // auth gate + `gh api user` identity resolve once and are reused by
                // every GitHub command. Stage holds no token of its own. `Arc` so
                // networked commands clone it into `spawn_blocking` and run `gh`/git
                // off the UI thread without re-running the auth gate (ADR-0023).
                github: Arc::new(stage_core::GitHub::new()),
                pending_open: Mutex::new(pending_open),
                activity_log,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::set_active_repo,
            commands::get_active_repo,
            commands::take_open_intent,
            commands::list_recent_repos,
            commands::forget_recent_repo,
            commands::git_current_branch,
            commands::repo_summary,
            commands::git_local_branches,
            commands::git_remote_branches,
            commands::repo_worktrees,
            commands::agent_sessions,
            commands::set_focused_worktree,
            commands::git_diff_stats,
            commands::git_diff_files,
            commands::storyline_diff,
            commands::self_review_diff,
            commands::self_review_base_options,
            commands::overview,
            commands::sync_status,
            commands::sync_now,
            commands::sync_watch_pr,
            commands::sync_unwatch_pr,
            commands::sync_set_auto_fetch,
            commands::storyline_staleness,
            commands::git_fetch,
            commands::open_in_finder,
            commands::open_url,
            commands::open_in_vscode,
            commands::self_review_debrief_get,
            commands::self_review_debrief_mark_seen,
            commands::repo_debrief_branches,
            commands::self_review_viewed_list,
            commands::self_review_viewed_set,
            commands::self_review_viewed_clear,
            commands::self_review_viewed_import_legacy,
            commands::self_review_notes_list,
            commands::self_review_note_create,
            commands::self_review_note_reply,
            commands::self_review_note_resolve,
            commands::self_review_note_reopen,
            commands::self_review_note_delete,
            commands::review_draft_get,
            commands::review_draft_create,
            commands::review_draft_set_title,
            commands::review_draft_set_base,
            commands::review_draft_discard,
            commands::storyline_steps,
            commands::storyline_step_add,
            commands::storyline_step_edit,
            commands::storyline_step_remove,
            commands::storyline_steps_reorder,
            commands::storyline_preview,
            commands::review_open,
            commands::review_checkout_branch,
            commands::branch_switch_plan,
            commands::branch_switch_execute,
            commands::branch_push_plan,
            commands::branch_push_execute,
            commands::branch_delete_plan,
            commands::branch_delete_execute,
            commands::branch_graph,
            commands::gh_identity,
            commands::build_info,
            commands::publish_readiness,
            commands::publish_uncommitted,
            commands::review_publish,
            commands::pr_activity,
            commands::pr_submit_verdict,
            commands::pr_comment_on_line,
            commands::pr_comment_on_file,
            commands::pr_merge,
            commands::pr_close,
            commands::pr_set_draft,
            commands::pr_discussion,
            commands::pr_start_thread,
            commands::pr_reply_thread,
            commands::pr_resolve_thread,
            commands::pr_reopen_thread,
            commands::pr_edit_comment,
            commands::pr_delete_comment,
            activity_log::activity_log_snapshot,
            activity_log::activity_log_push,
            activity_log::activity_log_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
