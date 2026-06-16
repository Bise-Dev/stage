//! The local store: one SQLite database shared by two writers (the `stage` CLI
//! and the desktop app). SQLite — not a flat file — precisely because of that
//! second writer.
//!
//! It holds the **private, pre-publish** half of Stage's state (ADR-0019 §3, the
//! two-stores split at "Ready to share"): the Debrief, the Self-Review notes,
//! and the per-machine **draft Review** ([`Store::create_review_draft`]). The
//! *published* storyline + metadata live elsewhere — committed under
//! `.stage/<branch>/` (see [`crate::review_folder`], written at Publish in
//! milestone D). Consequence: an unpublished draft is strictly per-machine.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::{
    Debrief, DebriefStep, NoteAnchor, NoteReply, NoteStatus, ReplyAuthor, Review, SelfReviewNote,
    Side,
};
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

    /// Branch names that have a stored Debrief for the repo identified by
    /// `(repo_owner, repo_name)`, newest first. Repo-scoped and branch-agnostic
    /// (owner/name are repo-wide — origin-derived or the common-dir slug), so the
    /// branch list can flag which branches carry a Debrief in one query rather
    /// than a `get_debrief` round-trip per branch.
    pub fn list_debrief_branches(
        &self,
        repo_owner: &str,
        repo_name: &str,
    ) -> Result<Vec<String>, StageError> {
        let mut stmt = self.conn.prepare(
            "SELECT branch FROM debrief \
             WHERE repo_owner = ?1 AND repo_name = ?2 \
             ORDER BY updated_at DESC",
        )?;
        let branches = stmt
            .query_map(params![repo_owner, repo_name], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(branches)
    }

    /// Delete the Debrief for `key`. Returns whether a row was removed.
    pub fn clear_debrief(&self, key: &RepoKey) -> Result<bool, StageError> {
        let removed = self.conn.execute(
            "DELETE FROM debrief WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
            params![key.repo_owner, key.repo_name, key.branch],
        )?;
        Ok(removed > 0)
    }

    /// Create an `open` Self-Review note with the given app-minted `id`. The desktop
    /// app mints the note UUID; the store does not, to avoid a uuid dependency
    /// here. `anchor` is `None` for general (un-anchored) feedback.
    pub fn create_note(
        &self,
        key: &RepoKey,
        id: &str,
        anchor: Option<&NoteAnchor>,
        body: &str,
    ) -> Result<SelfReviewNote, StageError> {
        let now = now_epoch();
        let file = anchor.map(|a| a.file.as_str());
        let line_start = anchor.and_then(|a| a.line_start);
        let line_end = anchor.and_then(|a| a.line_end);
        let side = anchor.and_then(|a| a.side).map(Side::as_str);
        self.conn.execute(
            "INSERT INTO review_note \
                (id, repo_owner, repo_name, branch, file, line_start, line_end, side, \
                 body, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
            params![
                id,
                key.repo_owner,
                key.repo_name,
                key.branch,
                file,
                line_start,
                line_end,
                side,
                body,
                NoteStatus::Open.as_str(),
                now,
            ],
        )?;
        self.get_note(key, id)?
            .ok_or_else(|| StageError::Invalid(format!("note {id} vanished after insert")))
    }

    /// Self-Review notes for `key`, optionally filtered by `status`, newest first.
    /// Each note's thread (`replies`) is hydrated from `review_note_reply`.
    pub fn list_notes(
        &self,
        key: &RepoKey,
        status: Option<NoteStatus>,
    ) -> Result<Vec<SelfReviewNote>, StageError> {
        let mut sql = String::from(
            "SELECT id, file, line_start, line_end, side, body, status, \
                    created_at, updated_at FROM review_note \
             WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
        );
        if status.is_some() {
            sql.push_str(" AND status = ?4");
        }
        sql.push_str(" ORDER BY created_at DESC, id");

        let mut stmt = self.conn.prepare(&sql)?;
        // `bare_note_from_row` is a fn item (Copy), so it can be passed to
        // whichever branch runs. A bad status string is a loud rusqlite error.
        let bare = if let Some(s) = status {
            stmt.query_map(
                params![key.repo_owner, key.repo_name, key.branch, s.as_str()],
                bare_note_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            stmt.query_map(
                params![key.repo_owner, key.repo_name, key.branch],
                bare_note_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };
        bare.into_iter().map(|n| self.hydrate(n)).collect()
    }

    /// A single Self-Review note by id (within `key`'s scope), or `None`. Thread
    /// hydrated.
    pub fn get_note(&self, key: &RepoKey, id: &str) -> Result<Option<SelfReviewNote>, StageError> {
        let bare = self
            .conn
            .query_row(
                "SELECT id, file, line_start, line_end, side, body, status, \
                        created_at, updated_at FROM review_note \
                 WHERE id = ?1 AND repo_owner = ?2 AND repo_name = ?3 AND branch = ?4",
                params![id, key.repo_owner, key.repo_name, key.branch],
                bare_note_from_row,
            )
            .optional()?;
        match bare {
            Some(n) => Ok(Some(self.hydrate(n)?)),
            None => Ok(None),
        }
    }

    /// Attach a note's thread (`replies`, oldest first) loaded from the
    /// `review_note_reply` table.
    fn hydrate(&self, mut note: SelfReviewNote) -> Result<SelfReviewNote, StageError> {
        // Order by insertion (`rowid`), not `id`: reply ids are random, and
        // `created_at` is second-granularity, so two replies in the same second
        // would otherwise sort non-deterministically. `rowid` is monotonic with
        // insertion, giving stable thread order.
        let mut stmt = self.conn.prepare(
            "SELECT id, author, body, created_at FROM review_note_reply \
             WHERE note_id = ?1 ORDER BY rowid",
        )?;
        note.replies = stmt
            .query_map(params![note.id], reply_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(note)
    }

    /// Agent action: append an agent reply to a note's thread, moving it to
    /// `addressed`. Allowed from `open` or `addressed` (re-reply); fails loud on
    /// a `resolved` or unknown note (CLAUDE.md fail-loud — the agent must not
    /// silently no-op).
    pub fn address_note(
        &self,
        key: &RepoKey,
        id: &str,
        reply: &str,
    ) -> Result<SelfReviewNote, StageError> {
        self.append_reply(key, id, ReplyAuthor::Agent, reply)
    }

    /// Author action: append an author reply to a note's thread. On an
    /// `addressed` or `resolved` note this re-raises it to `open` (the author is
    /// pushing back / reopening with a reason); on an `open` note it stays open.
    pub fn add_author_reply(
        &self,
        key: &RepoKey,
        id: &str,
        body: &str,
    ) -> Result<SelfReviewNote, StageError> {
        self.append_reply(key, id, ReplyAuthor::Author, body)
    }

    /// Append a thread entry and reconcile the note's status (ADR-0012):
    /// an `agent` reply → `addressed` (rejected on a `resolved` note); an
    /// `author` reply → `open`. Reply ids are store-minted (unlike note ids):
    /// a reply has no public identity, so the store mints it via `randomblob`
    /// rather than taking a uuid dependency.
    fn append_reply(
        &self,
        key: &RepoKey,
        id: &str,
        author: ReplyAuthor,
        body: &str,
    ) -> Result<SelfReviewNote, StageError> {
        let note = self
            .get_note(key, id)?
            .ok_or_else(|| StageError::Invalid(format!("no self-review note with id '{id}'")))?;
        if author == ReplyAuthor::Agent && note.status == NoteStatus::Resolved {
            return Err(StageError::Invalid(format!(
                "self-review note '{id}' is already resolved and cannot be addressed"
            )));
        }
        let next_status = match author {
            ReplyAuthor::Agent => NoteStatus::Addressed,
            ReplyAuthor::Author => NoteStatus::Open,
        };
        let now = now_epoch();
        self.conn.execute(
            "INSERT INTO review_note_reply (id, note_id, author, body, created_at) \
             VALUES ('r_' || lower(hex(randomblob(8))), ?1, ?2, ?3, ?4)",
            params![id, author.as_str(), body, now],
        )?;
        self.conn.execute(
            "UPDATE review_note SET status = ?1, updated_at = ?2 \
             WHERE id = ?3 AND repo_owner = ?4 AND repo_name = ?5 AND branch = ?6",
            params![
                next_status.as_str(),
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

    /// Author action: permanently delete a note and its thread. Fails loud on an
    /// unknown note. The thread is removed in the same transaction (the
    /// note↔reply relationship is code-enforced — no SQL foreign key, see
    /// MIGRATIONS).
    pub fn delete_note(&self, key: &RepoKey, id: &str) -> Result<(), StageError> {
        self.get_note(key, id)?
            .ok_or_else(|| StageError::Invalid(format!("no self-review note with id '{id}'")))?;
        self.conn.execute(
            "DELETE FROM review_note_reply WHERE note_id = ?1",
            params![id],
        )?;
        self.conn.execute(
            "DELETE FROM review_note \
             WHERE id = ?1 AND repo_owner = ?2 AND repo_name = ?3 AND branch = ?4",
            params![id, key.repo_owner, key.repo_name, key.branch],
        )?;
        Ok(())
    }

    /// Author action: close a note (`resolved`). Fails loud on an unknown note.
    pub fn resolve_note(&self, key: &RepoKey, id: &str) -> Result<SelfReviewNote, StageError> {
        self.set_note_status(key, id, NoteStatus::Resolved)
    }

    /// Author action: reopen a note (`open`). Fails loud on an unknown note.
    pub fn reopen_note(&self, key: &RepoKey, id: &str) -> Result<SelfReviewNote, StageError> {
        self.set_note_status(key, id, NoteStatus::Open)
    }

    fn set_note_status(
        &self,
        key: &RepoKey,
        id: &str,
        status: NoteStatus,
    ) -> Result<SelfReviewNote, StageError> {
        self.get_note(key, id)?
            .ok_or_else(|| StageError::Invalid(format!("no self-review note with id '{id}'")))?;
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

    // --- Pre-publish draft Review (ADR-0019 §3) ----------------------------
    //
    // The "Ready to share" transition creates one per-machine draft row per
    // (repo, branch); it is the private staging area before Publish serializes
    // it into `.stage/<branch>/` (milestone D). No lifecycle `state` is stored —
    // the row's existence *is* "draft", and post-publish state is derived
    // (ADR-0019 §7 / WS-5).

    /// The **Ready to share** transition (WS-2, #60): create the per-machine
    /// draft Review for `key`. `head_ref` is the current branch (`key.branch`);
    /// `pr_number` is unset until Publish.
    ///
    /// Fails loud if a draft already exists for `key` — "Ready to share" is a
    /// one-time transition, not an upsert (the caller reads the existing draft
    /// via [`Store::get_review_draft`] when re-entering the change).
    pub fn create_review_draft(
        &self,
        key: &RepoKey,
        title: &str,
        base_ref: &str,
    ) -> Result<Review, StageError> {
        if self.get_review_draft(key)?.is_some() {
            return Err(StageError::Invalid(format!(
                "a review draft already exists for branch '{}'",
                key.branch
            )));
        }
        let now = now_epoch();
        self.conn.execute(
            "INSERT INTO review_draft \
                (repo_owner, repo_name, branch, title, base_ref, head_ref, pr_number, \
                 created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?3, NULL, ?6, ?6)",
            params![
                key.repo_owner,
                key.repo_name,
                key.branch,
                title,
                base_ref,
                now,
            ],
        )?;
        self.get_review_draft(key)?
            .ok_or_else(|| StageError::Invalid("review draft vanished after insert".into()))
    }

    /// The draft Review for `key`, or `None` if "Ready to share" hasn't been
    /// triggered on this machine for this branch.
    pub fn get_review_draft(&self, key: &RepoKey) -> Result<Option<Review>, StageError> {
        let review = self
            .conn
            .query_row(
                "SELECT title, base_ref, head_ref, pr_number, created_at, updated_at \
                 FROM review_draft \
                 WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
                params![key.repo_owner, key.repo_name, key.branch],
                |r| {
                    Ok(Review {
                        title: r.get(0)?,
                        base_ref: r.get(1)?,
                        head_ref: r.get(2)?,
                        pr_number: r.get(3)?,
                        created_at: r.get(4)?,
                        updated_at: r.get(5)?,
                    })
                },
            )
            .optional()?;
        Ok(review)
    }

    /// Rename the draft Review (WS-3, #61) — the human-readable title only;
    /// independent of the branch and of any future PR title. Fails loud if no
    /// draft exists for `key`.
    pub fn set_review_title(&self, key: &RepoKey, title: &str) -> Result<Review, StageError> {
        let now = now_epoch();
        let changed = self.conn.execute(
            "UPDATE review_draft SET title = ?1, updated_at = ?2 \
             WHERE repo_owner = ?3 AND repo_name = ?4 AND branch = ?5",
            params![title, now, key.repo_owner, key.repo_name, key.branch],
        )?;
        if changed == 0 {
            return Err(StageError::Invalid(format!(
                "no review draft for branch '{}'",
                key.branch
            )));
        }
        self.get_review_draft(key)?
            .ok_or_else(|| StageError::Invalid("review draft vanished after update".into()))
    }

    /// Discard the draft Review (GAP-1, #91): pre-publish only — a draft is just
    /// a store row, so discarding deletes it. Returns whether a row was removed
    /// (idempotent, like [`Store::clear_debrief`]). An *open PR* is closed/merged
    /// on GitHub, never "discarded".
    pub fn discard_review_draft(&self, key: &RepoKey) -> Result<bool, StageError> {
        let removed = self.conn.execute(
            "DELETE FROM review_draft WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
            params![key.repo_owner, key.repo_name, key.branch],
        )?;
        Ok(removed > 0)
    }
}

/// Map a `review_note` row to a [`SelfReviewNote`] **without** its thread — callers
/// hydrate `replies` via [`Store::hydrate`]. Column order:
/// `id, file, line_start, line_end, side, body, status, created_at, updated_at`.
/// A bad `status`/`side` string is a loud failure, never a silent default.
fn bare_note_from_row(r: &rusqlite::Row) -> rusqlite::Result<SelfReviewNote> {
    let file: Option<String> = r.get(1)?;
    let line_start: Option<u32> = r.get(2)?;
    let line_end: Option<u32> = r.get(3)?;
    let side_str: Option<String> = r.get(4)?;
    let side = match side_str {
        Some(s) => Some(Side::from_db_str(&s).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                format!("unknown review_note.side '{s}'").into(),
            )
        })?),
        None => None,
    };
    let anchor = file.map(|file| NoteAnchor {
        file,
        line_start,
        line_end,
        side,
    });

    let status_str: String = r.get(6)?;
    let status = NoteStatus::from_db_str(&status_str).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            6,
            rusqlite::types::Type::Text,
            format!("unknown review_note.status '{status_str}'").into(),
        )
    })?;
    Ok(SelfReviewNote {
        id: r.get(0)?,
        anchor,
        body: r.get(5)?,
        status,
        replies: Vec::new(),
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

/// Map a `review_note_reply` row to a [`NoteReply`]. Column order:
/// `id, author, body, created_at`. A bad `author` string is a loud failure.
fn reply_from_row(r: &rusqlite::Row) -> rusqlite::Result<NoteReply> {
    let author_str: String = r.get(1)?;
    let author = ReplyAuthor::from_db_str(&author_str).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Text,
            format!("unknown review_note_reply.author '{author_str}'").into(),
        )
    })?;
    Ok(NoteReply {
        id: r.get(0)?,
        author,
        body: r.get(2)?,
        created_at: r.get(3)?,
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
    // v2 — Self-Review notes, keyed by app-minted UUID, scoped to a repo+branch.
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
    // v3 — Unify diff annotations into the Self-Review note (ADR-0012):
    //   * threads: a `review_note_reply` table replaces the single `agent_reply`
    //     column (existing replies backfilled as one `agent` entry each);
    //   * optional anchor: `file` becomes nullable (general feedback);
    //   * line side: a `side` column ('left'|'right', null for file-level).
    // The note↔reply link is code-enforced (no SQL foreign key) so this rebuild
    // of `review_note` needs no FK juggling and `delete_note` removes replies
    // explicitly.
    "CREATE TABLE IF NOT EXISTS review_note_reply (
        id         TEXT    NOT NULL PRIMARY KEY,
        note_id    TEXT    NOT NULL,
        author     TEXT    NOT NULL,
        body       TEXT    NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS review_note_reply_note
        ON review_note_reply (note_id, created_at);

    INSERT INTO review_note_reply (id, note_id, author, body, created_at)
        SELECT 'r_' || lower(hex(randomblob(8))), id, 'agent', agent_reply, updated_at
        FROM review_note
        WHERE agent_reply IS NOT NULL AND agent_reply <> '';

    CREATE TABLE review_note_v3 (
        id          TEXT    NOT NULL PRIMARY KEY,
        repo_owner  TEXT    NOT NULL,
        repo_name   TEXT    NOT NULL,
        branch      TEXT    NOT NULL,
        file        TEXT,
        line_start  INTEGER,
        line_end    INTEGER,
        side        TEXT,
        body        TEXT    NOT NULL,
        status      TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    INSERT INTO review_note_v3
        (id, repo_owner, repo_name, branch, file, line_start, line_end, side,
         body, status, created_at, updated_at)
        SELECT id, repo_owner, repo_name, branch, file, line_start, line_end, NULL,
               body, status, created_at, updated_at
        FROM review_note;
    DROP TABLE review_note;
    ALTER TABLE review_note_v3 RENAME TO review_note;
    CREATE INDEX IF NOT EXISTS review_note_scope
        ON review_note (repo_owner, repo_name, branch, status);",
    // v4 — Pre-publish draft Review (ADR-0019 §3, the renamed Workspace per §8).
    // One per-machine draft per (repo_owner, repo_name, branch), created at the
    // explicit "Ready to share" transition. `head_ref` mirrors `branch` (the
    // authoritative identity, WS-1); `pr_number` is NULL until Publish. No
    // lifecycle `state` column — Review state is derived, never stored (§7/WS-5).
    "CREATE TABLE IF NOT EXISTS review_draft (
        repo_owner TEXT    NOT NULL,
        repo_name  TEXT    NOT NULL,
        branch     TEXT    NOT NULL,
        title      TEXT    NOT NULL,
        base_ref   TEXT    NOT NULL,
        head_ref   TEXT    NOT NULL,
        pr_number  INTEGER,
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
            side: Some(Side::Right),
        }
    }

    #[test]
    fn note_lifecycle_open_addressed_resolved_reopened() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.sqlite3")).unwrap();
        let k = key();

        let note = store
            .create_note(&k, "n1", Some(&anchor("a.rs")), "please rename")
            .unwrap();
        assert_eq!(note.status, NoteStatus::Open);
        assert!(note.replies.is_empty());
        assert_eq!(note.anchor.as_ref().unwrap().side, Some(Side::Right));

        let addressed = store.address_note(&k, "n1", "renamed it").unwrap();
        assert_eq!(addressed.status, NoteStatus::Addressed);
        assert_eq!(addressed.replies.len(), 1);
        assert_eq!(addressed.replies[0].author, ReplyAuthor::Agent);
        assert_eq!(addressed.replies[0].body, "renamed it");

        // Re-addressing appends a *second* agent reply (threads accumulate now,
        // they don't overwrite — ADR-0012).
        let re = store.address_note(&k, "n1", "renamed again").unwrap();
        assert_eq!(re.replies.len(), 2);
        assert_eq!(re.replies[1].body, "renamed again");

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
    fn author_reply_re_raises_addressed_to_open() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.sqlite3")).unwrap();
        let k = key();

        store
            .create_note(&k, "n1", Some(&anchor("a.rs")), "rename this")
            .unwrap();
        store.address_note(&k, "n1", "done").unwrap();

        // Author pushes back on the agent's fix → note re-opens, thread grows.
        let reraised = store.add_author_reply(&k, "n1", "not quite").unwrap();
        assert_eq!(reraised.status, NoteStatus::Open);
        assert_eq!(reraised.replies.len(), 2);
        assert_eq!(reraised.replies[1].author, ReplyAuthor::Author);

        // An author reply on a resolved note reopens it.
        store.resolve_note(&k, "n1").unwrap();
        let reopened = store
            .add_author_reply(&k, "n1", "actually, also this")
            .unwrap();
        assert_eq!(reopened.status, NoteStatus::Open);
    }

    #[test]
    fn anchorless_note_round_trips_and_is_never_outdated() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.sqlite3")).unwrap();
        let k = key();

        let note = store
            .create_note(&k, "g1", None, "the overall approach is off")
            .unwrap();
        assert!(note.anchor.is_none());
        let got = store.get_note(&k, "g1").unwrap().unwrap();
        assert!(got.anchor.is_none());
        assert_eq!(got.body, "the overall approach is off");
    }

    #[test]
    fn delete_note_removes_note_and_thread() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.sqlite3")).unwrap();
        let k = key();
        store
            .create_note(&k, "n1", Some(&anchor("a.rs")), "x")
            .unwrap();
        store.address_note(&k, "n1", "fixed").unwrap();

        store.delete_note(&k, "n1").unwrap();
        assert!(store.get_note(&k, "n1").unwrap().is_none());
        // Deleting again fails loud (unknown note).
        assert!(store.delete_note(&k, "n1").is_err());
    }

    #[test]
    fn migration_v3_upgrades_a_v2_store_and_backfills_agent_reply() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.sqlite3");
        // Hand-build a v2 store: apply the v1 + v2 DDL, insert a note carrying
        // the old single `agent_reply` column, and stamp user_version = 2.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            conn.execute_batch(MIGRATIONS[1]).unwrap();
            conn.execute(
                "INSERT INTO review_note \
                    (id, repo_owner, repo_name, branch, file, line_start, line_end, \
                     body, status, agent_reply, created_at, updated_at) \
                 VALUES ('n1','octo','stage','feat/x','a.rs',1,3,'rename it','addressed','renamed it',100,200)",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 2i64).unwrap();
        }

        // Re-open through Store: migrate() applies v3 (table rebuild + backfill).
        let store = Store::open(&path).unwrap();
        let note = store
            .get_note(&key(), "n1")
            .unwrap()
            .expect("note survived migration");
        assert_eq!(note.status, NoteStatus::Addressed);
        let a = note.anchor.expect("anchor survived");
        assert_eq!(a.file, "a.rs");
        assert_eq!(a.line_start, Some(1));
        assert_eq!(a.side, None); // v2 rows had no side
                                  // The single legacy agent_reply is now one `agent` thread entry.
        assert_eq!(note.replies.len(), 1);
        assert_eq!(note.replies[0].author, ReplyAuthor::Agent);
        assert_eq!(note.replies[0].body, "renamed it");
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
        store
            .create_note(&k, "n1", Some(&anchor("a.rs")), "one")
            .unwrap();
        store
            .create_note(&k, "n2", Some(&anchor("b.rs")), "two")
            .unwrap();
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
        // The addressed note's thread is hydrated in the list view.
        assert_eq!(addressed[0].replies.len(), 1);

        let mut other = key();
        other.branch = "main".into();
        assert!(store.list_notes(&other, None).unwrap().is_empty());
    }

    #[test]
    fn review_draft_create_get_rename_discard() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.sqlite3")).unwrap();
        let k = key();

        // Nothing before "Ready to share".
        assert!(store.get_review_draft(&k).unwrap().is_none());

        // Ready to share (WS-2): creates the per-machine draft.
        let draft = store
            .create_review_draft(&k, "Ship the thing", "origin/main")
            .unwrap();
        assert_eq!(draft.title, "Ship the thing");
        assert_eq!(draft.base_ref, "origin/main");
        assert_eq!(draft.head_ref, k.branch); // head_ref mirrors the branch
        assert_eq!(draft.pr_number, None); // no PR pre-publish
        assert_eq!(draft.created_at, draft.updated_at);

        // Re-entering surfaces the same draft.
        let got = store.get_review_draft(&k).unwrap().expect("draft present");
        assert_eq!(got, draft);

        // "Ready to share" is one-time, not an upsert — a second create is loud.
        let err = store
            .create_review_draft(&k, "again", "origin/main")
            .unwrap_err();
        assert!(err.to_string().contains("already exists"), "{err}");

        // Rename the title (WS-3); base_ref and timestamps-of-creation persist.
        let renamed = store.set_review_title(&k, "Ship it properly").unwrap();
        assert_eq!(renamed.title, "Ship it properly");
        assert_eq!(renamed.created_at, draft.created_at);

        // Discard (GAP-1): deletes the row; idempotent second discard is false.
        assert!(store.discard_review_draft(&k).unwrap());
        assert!(!store.discard_review_draft(&k).unwrap());
        assert!(store.get_review_draft(&k).unwrap().is_none());

        // Renaming a discarded (absent) draft fails loud.
        assert!(store.set_review_title(&k, "ghost").is_err());
    }

    #[test]
    fn review_drafts_are_scoped_per_branch() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.sqlite3")).unwrap();
        let k = key(); // branch feat/x
        let mut other = key();
        other.branch = "main".into();

        store
            .create_review_draft(&k, "on feat/x", "origin/main")
            .unwrap();
        // A different branch has its own (absent) draft, and can create one.
        assert!(store.get_review_draft(&other).unwrap().is_none());
        store
            .create_review_draft(&other, "on main", "origin/main")
            .unwrap();
        assert_eq!(
            store.get_review_draft(&k).unwrap().unwrap().title,
            "on feat/x"
        );
        assert_eq!(
            store.get_review_draft(&other).unwrap().unwrap().title,
            "on main"
        );
        // Discarding one leaves the other.
        store.discard_review_draft(&k).unwrap();
        assert!(store.get_review_draft(&k).unwrap().is_none());
        assert!(store.get_review_draft(&other).unwrap().is_some());
    }

    #[test]
    fn review_draft_table_is_added_to_a_pre_v4_store() {
        // A store migrated only through v3 (no review_draft table) must gain it
        // on the next open, without disturbing existing data.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            for m in &MIGRATIONS[..3] {
                conn.execute_batch(m).unwrap();
            }
            conn.pragma_update(None, "user_version", 3i64).unwrap();
        }
        // Re-open through Store: migrate() applies v4 (review_draft).
        let store = Store::open(&path).unwrap();
        let k = key();
        let draft = store
            .create_review_draft(&k, "post-migration", "origin/main")
            .unwrap();
        assert_eq!(draft.title, "post-migration");
    }
}
