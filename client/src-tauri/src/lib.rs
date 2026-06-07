#[cfg(debug_assertions)]
pub mod activity_log;
pub mod api;
mod commands;
mod errors;
mod git;
pub mod oauth;
mod recents;
mod repo_activation;
mod session;
mod state;
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
use crate::session::SessionStore;
use crate::state::{AppState, AuthSession, OpenIntent, OpenMode};

/// Parse a `stage open <repo-root>` invocation out of a process argv (the
/// program name is `argv[0]`). Returns the open-intent, or `None` for a plain
/// launch (dock/Finder). Shared by cold start (`setup`) and the warm-start
/// single-instance callback (ADR-0014).
fn parse_open_intent(argv: &[String]) -> Option<OpenIntent> {
    let mut it = argv.iter().skip(1);
    while let Some(arg) = it.next() {
        if arg == "open" {
            // The next token is the canonical repo root the CLI resolved.
            return it.next().map(|p| OpenIntent {
                repo: PathBuf::from(p),
                mode: OpenMode::SelfReview,
            });
        }
    }
    None
}

pub fn run() {
    // Base console logging (unchanged). In debug we additionally fan events into
    // the dev-only Activity log ring via a second layer; both are scoped by
    // their own filter so the fmt layer keeps its existing verbosity.
    let fmt_layer = tracing_subscriber::fmt::layer().with_filter(
        EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info,stage_client_lib=debug")),
    );

    #[cfg(debug_assertions)]
    let activity_log = Arc::new(activity_log::ActivityLog::new());

    let subscriber = tracing_subscriber::registry().with(fmt_layer);
    // The ring layer captures DEBUG+ from our crate only — that's where the
    // http/git/cmd/rust pills come from; dependency noise stays out.
    #[cfg(debug_assertions)]
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
            #[cfg(debug_assertions)]
            activity_log.set_app(app.handle().clone());

            let data_dir = app
                .path()
                .app_data_dir()
                .expect("app_data_dir resolves on supported platforms");
            std::fs::create_dir_all(&data_dir)?;

            let recents = RecentsStore::open(&data_dir)?;
            let sessions = SessionStore::open(&data_dir)?;
            // Seed the runtime token from disk (ADR-0013). It's validated lazily
            // via `auth_bootstrap` (auth_me); a dead token is cleared there.
            let initial_token = sessions.token();

            let backend_url = app
                .config()
                .plugins
                .0
                .get("stage")
                .and_then(|v| v.get("backendUrl"))
                .and_then(|v| v.as_str())
                .unwrap_or("http://localhost:8000")
                .to_string();

            let github_app_client_id = app
                .config()
                .plugins
                .0
                .get("stage")
                .and_then(|v| v.get("githubAppClientId"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    std::io::Error::other(
                        "plugins.stage.githubAppClientId not set in tauri.conf.json",
                    )
                })?
                .to_string();

            let api_client = api::Client::new(&backend_url)
                .map_err(|e| std::io::Error::other(format!("api client: {e}")))?;

            // Cold start: this process *is* the primary, so parse our own argv
            // for a `stage open` request (ADR-0014). Warm starts arrive via the
            // single-instance callback above instead.
            let pending_open = parse_open_intent(&std::env::args().collect::<Vec<_>>());

            app.manage(AppState {
                active: Mutex::new(None),
                recents: Arc::new(recents),
                sessions: Arc::new(sessions),
                api: api_client,
                auth: Mutex::new(initial_token.map(|token| AuthSession { token })),
                auth_in_flight: Mutex::new(None),
                github_app_client_id,
                pending_open: Mutex::new(pending_open),
                #[cfg(debug_assertions)]
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
            commands::repo_worktrees,
            commands::set_focused_worktree,
            commands::git_diff_stats,
            commands::git_diff_files,
            commands::self_review_diff,
            commands::self_review_base_options,
            commands::repo_overview,
            commands::workspace_create,
            commands::workspace_publish,
            commands::workspace_delete,
            commands::storyline_get,
            commands::storyline_update,
            commands::git_fetch,
            commands::git_push,
            commands::open_in_finder,
            commands::open_url,
            commands::auth_sign_in,
            commands::auth_sign_in_cancel,
            commands::auth_me,
            commands::auth_bootstrap,
            commands::auth_logout,
            commands::github_prs,
            commands::pr_file_diff,
            commands::self_review_debrief_get,
            commands::self_review_notes_list,
            commands::self_review_note_create,
            commands::self_review_note_reply,
            commands::self_review_note_resolve,
            commands::self_review_note_reopen,
            commands::self_review_note_delete,
            #[cfg(debug_assertions)]
            activity_log::activity_log_snapshot,
            #[cfg(debug_assertions)]
            activity_log::activity_log_push,
            #[cfg(debug_assertions)]
            activity_log::activity_log_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
