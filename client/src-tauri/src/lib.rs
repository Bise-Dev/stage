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
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("app_data_dir resolves on supported platforms");
            std::fs::create_dir_all(&data_dir)?;

            let recents = RecentsStore::open(&data_dir)?;

            // Read backend URL from tauri.conf.json -> plugins.stage.backendUrl.
            // PluginConfig wraps a HashMap<String, JsonValue>; access via the
            // public `.0` field. Fall back to localhost for the dev loop.
            let backend_url = app
                .config()
                .plugins
                .0
                .get("stage")
                .and_then(|v| v.get("backendUrl"))
                .and_then(|v| v.as_str())
                .unwrap_or("http://localhost:8000")
                .to_string();
            let api = api::Client::new(&backend_url)
                .map_err(|e| std::io::Error::other(format!("api client: {e}")))?;
            tracing::info!(backend_url = %backend_url, "api client initialized");

            app.manage(AppState {
                active: Mutex::new(None),
                recents: Arc::new(recents),
                api,
                auth: Mutex::new(None),
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
