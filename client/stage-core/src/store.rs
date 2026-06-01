//! The local Handoff store: one SQLite database shared by two writers (the
//! `stage` CLI and the desktop app). SQLite — not a flat file — precisely
//! because of that second writer.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::{Handoff, HandoffStep};
use crate::error::StageError;
use crate::repo_key::RepoKey;

/// Env override for the store location — handy for tests and for pointing the
/// CLI and app at the same dev DB. When unset, [`default_store_path`] is used.
pub const STORE_PATH_ENV: &str = "STAGE_STORE_PATH";

/// On-disk location of the shared Handoff store.
///
/// Deliberately **not** Tauri's `app_data_dir()` (identifier
/// `dev.stage.client`): the `stage` CLI runs outside Tauri and must derive the
/// *same* path independently, so both writers route through this one function.
/// On macOS this resolves to `~/Library/Application Support/dev.stage.stage/`.
pub fn default_store_path() -> Result<PathBuf, StageError> {
    if let Some(p) = std::env::var_os(STORE_PATH_ENV) {
        return Ok(PathBuf::from(p));
    }
    let dirs =
        directories::ProjectDirs::from("dev", "stage", "stage").ok_or(StageError::NoDataDir)?;
    Ok(dirs.data_dir().join("handoff.sqlite3"))
}

/// A handle to the shared store. Cheap to open; holds one SQLite connection.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open (creating the file and parent dirs if needed) the store at `path`,
    /// applying any pending migrations.
    pub fn open(path: &Path) -> Result<Self, StageError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        configure(&conn)?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    /// Open the store at the default shared location ([`default_store_path`]).
    pub fn open_default() -> Result<Self, StageError> {
        Self::open(&default_store_path()?)
    }

    /// The stored Handoff for `key`, or `None` if the agent hasn't written one.
    pub fn get_handoff(&self, key: &RepoKey) -> Result<Option<Handoff>, StageError> {
        let row = self
            .conn
            .query_row(
                "SELECT base, steps_json, created_at, updated_at FROM handoff \
                 WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
                params![key.repo_owner, key.repo_name, key.branch],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?;

        let Some((base, steps_json, created_at, updated_at)) = row else {
            return Ok(None);
        };
        let steps: Vec<HandoffStep> = serde_json::from_str(&steps_json)?;
        Ok(Some(Handoff {
            base,
            steps,
            created_at,
            updated_at,
        }))
    }

    /// Upsert the Handoff for `key`. Steps are stored in ascending `order`.
    /// `created_at` is preserved across regenerations; `updated_at` is bumped.
    pub fn set_handoff(
        &self,
        key: &RepoKey,
        base: &str,
        mut steps: Vec<HandoffStep>,
    ) -> Result<Handoff, StageError> {
        steps.sort_by_key(|s| s.order);
        let steps_json = serde_json::to_string(&steps)?;
        let now = now_epoch();
        let created_at = self.get_handoff(key)?.map(|h| h.created_at).unwrap_or(now);

        self.conn.execute(
            "INSERT INTO handoff \
                (repo_owner, repo_name, branch, base, steps_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(repo_owner, repo_name, branch) DO UPDATE SET \
                base = excluded.base, \
                steps_json = excluded.steps_json, \
                updated_at = excluded.updated_at",
            params![
                key.repo_owner,
                key.repo_name,
                key.branch,
                base,
                steps_json,
                created_at,
                now
            ],
        )?;

        Ok(Handoff {
            base: base.to_string(),
            steps,
            created_at,
            updated_at: now,
        })
    }

    /// Delete the Handoff for `key`. Returns whether a row was removed.
    pub fn clear_handoff(&self, key: &RepoKey) -> Result<bool, StageError> {
        let removed = self.conn.execute(
            "DELETE FROM handoff WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
            params![key.repo_owner, key.repo_name, key.branch],
        )?;
        Ok(removed > 0)
    }
}

/// Connection-level pragmas. WAL lets the desktop app read while the CLI
/// writes; `busy_timeout` makes the loser of a write race wait rather than
/// fail instantly — both matter for a two-writer store.
fn configure(conn: &Connection) -> Result<(), StageError> {
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(())
}

/// Ordered, forward-only schema migrations. The DB's `user_version` tracks how
/// many have been applied. Statements use `IF NOT EXISTS` so a re-run after an
/// interrupted migration is a no-op rather than a hard failure.
const MIGRATIONS: &[&str] = &[
    // v1 — Handoff, one row per (repo_owner, repo_name, branch). Steps live as a
    // JSON array (a Handoff is small and always read/written whole).
    "CREATE TABLE IF NOT EXISTS handoff (
        repo_owner TEXT    NOT NULL,
        repo_name  TEXT    NOT NULL,
        branch     TEXT    NOT NULL,
        base       TEXT    NOT NULL,
        steps_json TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repo_owner, repo_name, branch)
    ) WITHOUT ROWID;",
];

fn migrate(conn: &Connection) -> Result<(), StageError> {
    let mut applied: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, statement) in MIGRATIONS.iter().enumerate() {
        let target = i as i64 + 1;
        if applied >= target {
            continue;
        }
        conn.execute_batch(statement)?;
        conn.pragma_update(None, "user_version", target)?;
        applied = target;
    }
    Ok(())
}

/// Epoch seconds (UTC). The clock predating 1970 is not a recoverable runtime
/// condition, so we panic loudly rather than invent a timestamp.
fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the unix epoch")
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::HandoffStep;

    fn key() -> RepoKey {
        RepoKey {
            repo_owner: "octo".into(),
            repo_name: "stage".into(),
            branch: "feat/x".into(),
        }
    }

    fn step(file: &str, order: u32) -> HandoffStep {
        HandoffStep {
            file: file.into(),
            intro: format!("did stuff to {file}"),
            order,
        }
    }

    #[test]
    fn handoff_round_trips_and_orders_steps() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("handoff.sqlite3")).unwrap();
        let k = key();

        assert!(store.get_handoff(&k).unwrap().is_none());

        // Set with out-of-order steps; expect them sorted by `order` on read.
        let saved = store
            .set_handoff(&k, "main", vec![step("b.rs", 1), step("a.rs", 0)])
            .unwrap();
        assert_eq!(saved.base, "main");

        let got = store.get_handoff(&k).unwrap().expect("handoff present");
        assert_eq!(
            got.steps
                .iter()
                .map(|s| s.file.as_str())
                .collect::<Vec<_>>(),
            vec!["a.rs", "b.rs"],
        );
        assert_eq!(got.created_at, saved.created_at);
    }

    #[test]
    fn set_preserves_created_at_and_clear_removes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("handoff.sqlite3")).unwrap();
        let k = key();

        let first = store
            .set_handoff(&k, "main", vec![step("a.rs", 0)])
            .unwrap();
        let second = store
            .set_handoff(&k, "develop", vec![step("a.rs", 0), step("c.rs", 1)])
            .unwrap();

        // Regenerating keeps the original created_at and updates the base.
        assert_eq!(second.created_at, first.created_at);
        assert_eq!(second.base, "develop");
        assert_eq!(store.get_handoff(&k).unwrap().unwrap().steps.len(), 2);

        assert!(store.clear_handoff(&k).unwrap());
        assert!(!store.clear_handoff(&k).unwrap()); // idempotent
        assert!(store.get_handoff(&k).unwrap().is_none());
    }

    #[test]
    fn distinct_keys_are_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("handoff.sqlite3")).unwrap();
        let mut other = key();
        other.branch = "main".into();

        store
            .set_handoff(&key(), "main", vec![step("a.rs", 0)])
            .unwrap();
        assert!(store.get_handoff(&other).unwrap().is_none());
    }

    #[test]
    fn reopening_an_existing_store_is_a_noop_migration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("handoff.sqlite3");
        let k = key();
        {
            let store = Store::open(&path).unwrap();
            store
                .set_handoff(&k, "main", vec![step("a.rs", 0)])
                .unwrap();
        }
        // Re-open: migrations already applied, data survives.
        let store = Store::open(&path).unwrap();
        assert_eq!(store.get_handoff(&k).unwrap().unwrap().base, "main");
    }
}
