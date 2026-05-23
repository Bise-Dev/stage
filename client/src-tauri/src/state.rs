use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::recents::RecentsStore;
use crate::watcher::WatcherHandle;

pub struct AppState {
    pub active: Mutex<Option<ActiveRepo>>,
    pub recents: Arc<RecentsStore>,
}

pub struct ActiveRepo {
    pub path: PathBuf,
    #[allow(dead_code)]
    pub watcher: WatcherHandle,
}
