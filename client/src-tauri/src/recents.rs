use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::errors::AppError;

const MAX_ENTRIES: usize = 20;

#[derive(Clone, Serialize, Deserialize)]
pub struct RecentRepo {
    pub path: PathBuf,
    #[serde(rename = "lastOpenedAt")]
    pub last_opened_at: u64,
}

pub struct RecentsStore {
    file: PathBuf,
    entries: Mutex<Vec<RecentRepo>>,
}

impl RecentsStore {
    pub fn open(data_dir: &Path) -> Result<Self, AppError> {
        let file = data_dir.join("recents.json");
        let entries = if file.exists() {
            let raw = std::fs::read_to_string(&file)?;
            serde_json::from_str(&raw).unwrap_or_default()
        } else {
            Vec::new()
        };
        Ok(Self {
            file,
            entries: Mutex::new(entries),
        })
    }

    pub fn list(&self) -> Vec<RecentRepo> {
        self.entries.lock().clone()
    }

    pub fn touch(&self, path: &Path) -> Result<(), AppError> {
        let now = unix_now();
        let snapshot = {
            let mut entries = self.entries.lock();
            entries.retain(|r| r.path != path);
            entries.insert(
                0,
                RecentRepo {
                    path: path.to_path_buf(),
                    last_opened_at: now,
                },
            );
            if entries.len() > MAX_ENTRIES {
                entries.truncate(MAX_ENTRIES);
            }
            entries.clone()
        };
        persist(&self.file, &snapshot)
    }

    pub fn forget(&self, path: &Path) -> Result<(), AppError> {
        let snapshot = {
            let mut entries = self.entries.lock();
            entries.retain(|r| r.path != path);
            entries.clone()
        };
        persist(&self.file, &snapshot)
    }
}

fn persist(file: &Path, entries: &[RecentRepo]) -> Result<(), AppError> {
    let raw = serde_json::to_string_pretty(entries)?;
    std::fs::write(file, raw)?;
    Ok(())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
