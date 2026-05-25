pub mod api;
mod commands;
mod errors;
mod git;
mod recents;
mod state;
mod watcher;

use std::sync::Arc;

use parking_lot::Mutex;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

use crate::recents::RecentsStore;
use crate::state::AppState;

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,stage_client_lib=debug")),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("app_data_dir resolves on supported platforms");
            std::fs::create_dir_all(&data_dir)?;

            let recents = RecentsStore::open(&data_dir)?;
            app.manage(AppState {
                active: Mutex::new(None),
                recents: Arc::new(recents),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::set_active_repo,
            commands::get_active_repo,
            commands::list_recent_repos,
            commands::forget_recent_repo,
            commands::git_current_branch,
            commands::repo_summary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
