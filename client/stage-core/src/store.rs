//! The local Debrief store: one SQLite database shared by two writers (the
//! `stage` CLI and the desktop app). SQLite — not a flat file — precisely
//! because of that second writer.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::{Debrief, DebriefStep, NoteAnchor, NoteStatus, ReviewNote};
use crate::error::StageError;
use crate::repo_key::RepoKey;

/// Env override for the store location — handy for tests and for pointing the
/// CLI and app at the same dev DB. When unset, [`default_store_path`] is used.
pub const STORE_PATH_ENV: &str = "STAGE_STORE_PATH";

/// On-disk location of the shared Debrief store.
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
    Ok(dirs.data_dir().join("debrief.sqlite3"))
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

    /// The stored Debrief for `key`, or `None` if the agent hasn't written one.
    pub fn get_debrief(&self, key: &RepoKey) -> Result<Option<Debrief>, StageError> {
        let row = self
            .conn
            .query_row(
                "SELECT base, steps_json, created_at, updated_at FROM debrief \
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
        let steps: Vec<DebriefStep> = serde_json::from_str(&steps_json)?;
        Ok(Some(Debrief {
            base,
            steps,
            created_at,
            updated_at,
        }))
    }

    /// Upsert the Debrief for `key`. Steps are stored in ascending `order`.
    /// `created_at` is preserved across regenerations; `updated_at` is bumped.
    pub fn set_debrief(
        &self,
        key: &RepoKey,
        base: &str,
        mut steps: Vec<DebriefStep>,
    ) -> Result<Debrief, StageError> {
        steps.sort_by_key(|s| s.order);
        let steps_json = serde_json::to_string(&steps)?;
        let now = now_epoch();
        let created_at = self.get_debrief(key)?.map(|h| h.created_at).unwrap_or(now);

        self.conn.execute(
            "INSERT INTO debrief \
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

        Ok(Debrief {
            base: base.to_string(),
            steps,
            created_at,
            updated_at: now,
        })
    }

    /// Delete the Debrief for `key`. Returns whether a row was removed.
    pub fn clear_debrief(&self, key: &RepoKey) -> Result<bool, StageError> {
        let removed = self.conn.execute(
            "DELETE FROM debrief WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
            params![key.repo_owner, key.repo_name, key.branch],
        )?;
        Ok(removed > 0)
    }

    /// Create an `open` Review note with the given app-minted `id`. The desktop
    /// app mints the UUID; the store does not, to avoid a uuid dependency here.
    pub fn create_note(
        &self,
        key: &RepoKey,
        id: &str,
        anchor: &NoteAnchor,
        body: &str,
    ) -> Result<ReviewNote, StageError> {
        let now = now_epoch();
        self.conn.execute(
            "INSERT INTO review_note \
                (id, repo_owner, repo_name, branch, file, line_start, line_end, \
                 body, status, agent_reply, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?10)",
            params![
                id,
                key.repo_owner,
                key.repo_name,
                key.branch,
                anchor.file,
                anchor.line_start,
                anchor.line_end,
                body,
                NoteStatus::Open.as_str(),
                now,
            ],
        )?;
        self.get_note(key, id)?
            .ok_or_else(|| StageError::Invalid(format!("note {id} vanished after insert")))
    }

    /// Review notes for `key`, optionally filtered by `status`, newest first.
    pub fn list_notes(
        &self,
        key: &RepoKey,
        status: Option<NoteStatus>,
    ) -> Result<Vec<ReviewNote>, StageError> {
        let mut sql = String::from(
            "SELECT id, file, line_start, line_end, body, status, agent_reply, \
                    created_at, updated_at FROM review_note \
             WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
        );
        if status.is_some() {
            sql.push_str(" AND status = ?4");
        }
        sql.push_str(" ORDER BY created_at DESC, id");

        let mut stmt = self.conn.prepare(&sql)?;
        // `note_from_row` is a fn item (Copy), so it can be passed to whichever
        // branch runs. A bad status string surfaces as a loud rusqlite error.
        let notes = if let Some(s) = status {
            stmt.query_map(
                params![key.repo_owner, key.repo_name, key.branch, s.as_str()],
                note_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            stmt.query_map(
                params![key.repo_owner, key.repo_name, key.branch],
                note_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(notes)
    }

    /// A single Review note by id (within `key`'s scope), or `None`.
    pub fn get_note(&self, key: &RepoKey, id: &str) -> Result<Option<ReviewNote>, StageError> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, file, line_start, line_end, body, status, agent_reply, \
                        created_at, updated_at FROM review_note \
                 WHERE id = ?1 AND repo_owner = ?2 AND repo_name = ?3 AND branch = ?4",
                params![id, key.repo_owner, key.repo_name, key.branch],
                note_from_row,
            )
            .optional()?)
    }

    /// Agent action: move a note to `addressed` with `reply`. Allowed from
    /// `open` or `addressed` (re-reply); fails loud on a `resolved` or unknown
    /// note (CLAUDE.md fail-loud — the agent must not silently no-op).
    pub fn address_note(
        &self,
        key: &RepoKey,
        id: &str,
        reply: &str,
    ) -> Result<ReviewNote, StageError> {
        let note = self
            .get_note(key, id)?
            .ok_or_else(|| StageError::Invalid(format!("no review note with id '{id}'")))?;
        if note.status == NoteStatus::Resolved {
            return Err(StageError::Invalid(format!(
                "review note '{id}' is already resolved and cannot be addressed"
            )));
        }
        let now = now_epoch();
        self.conn.execute(
            "UPDATE review_note SET status = ?1, agent_reply = ?2, updated_at = ?3 \
             WHERE id = ?4 AND repo_owner = ?5 AND repo_name = ?6 AND branch = ?7",
            params![
                NoteStatus::Addressed.as_str(),
                reply,
                now,
                id,
                key.repo_owner,
                key.repo_name,
                key.branch,
            ],
        )?;
        self.get_note(key, id)?
            .ok_or_else(|| StageError::Invalid(format!("note {id} vanished after update")))
    }

    /// Author action: close a note (`resolved`). Fails loud on an unknown note.
    pub fn resolve_note(&self, key: &RepoKey, id: &str) -> Result<ReviewNote, StageError> {
        self.set_note_status(key, id, NoteStatus::Resolved)
    }

    /// Author action: reopen a note (`open`). Fails loud on an unknown note.
    pub fn reopen_note(&self, key: &RepoKey, id: &str) -> Result<ReviewNote, StageError> {
        self.set_note_status(key, id, NoteStatus::Open)
    }

    fn set_note_status(
        &self,
        key: &RepoKey,
        id: &str,
        status: NoteStatus,
    ) -> Result<ReviewNote, StageError> {
        self.get_note(key, id)?
            .ok_or_else(|| StageError::Invalid(format!("no review note with id '{id}'")))?;
        let now = now_epoch();
        self.conn.execute(
            "UPDATE review_note SET status = ?1, updated_at = ?2 \
             WHERE id = ?3 AND repo_owner = ?4 AND repo_name = ?5 AND branch = ?6",
            params![
                status.as_str(),
                now,
                id,
                key.repo_owner,
                key.repo_name,
                key.branch,
            ],
        )?;
        self.get_note(key, id)?
            .ok_or_else(|| StageError::Invalid(format!("note {id} vanished after update")))
    }
}

/// Map a `review_note` row to a [`ReviewNote`]. A bad `status` string is a loud
/// failure (rusqlite error), never a silent default.
fn note_from_row(r: &rusqlite::Row) -> rusqlite::Result<ReviewNote> {
    let status_str: String = r.get(5)?;
    let status = NoteStatus::from_db_str(&status_str).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            5,
            rusqlite::types::Type::Text,
            format!("unknown review_note.status '{status_str}'").into(),
        )
    })?;
    Ok(ReviewNote {
        id: r.get(0)?,
        anchor: NoteAnchor {
            file: r.get(1)?,
            line_start: r.get(2)?,
            line_end: r.get(3)?,
        },
        body: r.get(4)?,
        status,
        agent_reply: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
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
    // v1 — Debrief, one row per (repo_owner, repo_name, branch). Steps live as a
    // JSON array (a Debrief is small and always read/written whole).
    "CREATE TABLE IF NOT EXISTS debrief (
        repo_owner TEXT    NOT NULL,
        repo_name  TEXT    NOT NULL,
        branch     TEXT    NOT NULL,
        base       TEXT    NOT NULL,
        steps_json TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repo_owner, repo_name, branch)
    ) WITHOUT ROWID;",
    // v2 — Review notes, keyed by app-minted UUID, scoped to a repo+branch.
    // Anchored to a diff location (file + optional line range), NOT a Debrief
    // step, so they survive Debrief regeneration. `outdated` is computed at read
    // time, never stored.
    "CREATE TABLE IF NOT EXISTS review_note (
        id          TEXT    NOT NULL PRIMARY KEY,
        repo_owner  TEXT    NOT NULL,
        repo_name   TEXT    NOT NULL,
        branch      TEXT    NOT NULL,
        file        TEXT    NOT NULL,
        line_start  INTEGER,
        line_end    INTEGER,
        body        TEXT    NOT NULL,
        status      TEXT    NOT NULL,
        agent_reply TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS review_note_scope
        ON review_note (repo_owner, repo_name, branch, status);",
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
    use crate::domain::DebriefStep;

    fn key() -> RepoKey {
        RepoKey {
            repo_owner: "octo".into(),
            repo_name: "stage".into(),
            branch: "feat/x".into(),
        }
    }

    fn step(file: &str, order: u32) -> DebriefStep {
        DebriefStep {
            file: file.into(),
            intro: format!("did stuff to {file}"),
            order,
        }
    }

    #[test]
    fn debrief_round_trips_and_orders_steps() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("debrief.sqlite3")).unwrap();
        let k = key();

        assert!(store.get_debrief(&k).unwrap().is_none());

        // Set with out-of-order steps; expect them sorted by `order` on read.
        let saved = store
            .set_debrief(&k, "main", vec![step("b.rs", 1), step("a.rs", 0)])
            .unwrap();
        assert_eq!(saved.base, "main");

        let got = store.get_debrief(&k).unwrap().expect("debrief present");
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
        let store = Store::open(&dir.path().join("debrief.sqlite3")).unwrap();
        let k = key();

        let first = store
            .set_debrief(&k, "main", vec![step("a.rs", 0)])
            .unwrap();
        let second = store
            .set_debrief(&k, "develop", vec![step("a.rs", 0), step("c.rs", 1)])
            .unwrap();

        // Regenerating keeps the original created_at and updates the base.
        assert_eq!(second.created_at, first.created_at);
        assert_eq!(second.base, "develop");
        assert_eq!(store.get_debrief(&k).unwrap().unwrap().steps.len(), 2);

        assert!(store.clear_debrief(&k).unwrap());
        assert!(!store.clear_debrief(&k).unwrap()); // idempotent
        assert!(store.get_debrief(&k).unwrap().is_none());
    }

    #[test]
    fn distinct_keys_are_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("debrief.sqlite3")).unwrap();
        let mut other = key();
        other.branch = "main".into();

        store
            .set_debrief(&key(), "main", vec![step("a.rs", 0)])
            .unwrap();
        assert!(store.get_debrief(&other).unwrap().is_none());
    }

    #[test]
    fn reopening_an_existing_store_is_a_noop_migration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("debrief.sqlite3");
        let k = key();
        {
            let store = Store::open(&path).unwrap();
            store
                .set_debrief(&k, "main", vec![step("a.rs", 0)])
                .unwrap();
        }
        // Re-open: migrations already applied, data survives.
        let store = Store::open(&path).unwrap();
        assert_eq!(store.get_debrief(&k).unwrap().unwrap().base, "main");
    }

    fn anchor(file: &str) -> NoteAnchor {
        NoteAnchor {
            file: file.into(),
            line_start: Some(1),
            line_end: Some(3),
        }
    }

    #[test]
    fn note_lifecycle_open_addressed_resolved_reopened() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.sqlite3")).unwrap();
        let k = key();

        let note = store
            .create_note(&k, "n1", &anchor("a.rs"), "please rename")
            .unwrap();
        assert_eq!(note.status, NoteStatus::Open);
        assert!(note.agent_reply.is_none());

        let addressed = store.address_note(&k, "n1", "renamed it").unwrap();
        assert_eq!(addressed.status, NoteStatus::Addressed);
        assert_eq!(addressed.agent_reply.as_deref(), Some("renamed it"));

        // Re-addressing an addressed note updates the reply (agent's 2nd pass).
        let re = store.address_note(&k, "n1", "renamed again").unwrap();
        assert_eq!(re.agent_reply.as_deref(), Some("renamed again"));

        let resolved = store.resolve_note(&k, "n1").unwrap();
        assert_eq!(resolved.status, NoteStatus::Resolved);

        // Addressing a resolved note is rejected loudly.
        let err = store.address_note(&k, "n1", "nope").unwrap_err();
        assert!(err.to_string().contains("resolved"), "{err}");

        assert_eq!(
            store.reopen_note(&k, "n1").unwrap().status,
            NoteStatus::Open
        );
    }

    #[test]
    fn address_and_resolve_reject_unknown_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.sqlite3")).unwrap();
        let k = key();
        assert!(store.address_note(&k, "ghost", "x").is_err());
        assert!(store.resolve_note(&k, "ghost").is_err());
        assert!(store.get_note(&k, "ghost").unwrap().is_none());
    }

    #[test]
    fn list_notes_filters_by_status_and_scopes_by_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.sqlite3")).unwrap();
        let k = key();
        store.create_note(&k, "n1", &anchor("a.rs"), "one").unwrap();
        store.create_note(&k, "n2", &anchor("b.rs"), "two").unwrap();
        store.address_note(&k, "n2", "done").unwrap();

        assert_eq!(store.list_notes(&k, None).unwrap().len(), 2);
        let open = store.list_notes(&k, Some(NoteStatus::Open)).unwrap();
        assert_eq!(
            open.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec!["n1"]
        );
        let addressed = store.list_notes(&k, Some(NoteStatus::Addressed)).unwrap();
        assert_eq!(
            addressed.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec!["n2"]
        );

        let mut other = key();
        other.branch = "main".into();
        assert!(store.list_notes(&other, None).unwrap().is_empty());
    }
}
