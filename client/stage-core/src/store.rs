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

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::chapter::Chapter;
use crate::domain::{
    Debrief, NoteAnchor, NoteReply, NoteStatus, ReplyAuthor, Review, SelfReviewNote, Side,
};
use crate::error::StageError;
use crate::repo_key::RepoKey;
use crate::storyline::StorylineStep;
use crate::viewed::ViewedMark;

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
                "SELECT base, chapters_json, head_sha, seen_at, created_at, updated_at \
                 FROM debrief \
                 WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
                params![key.repo_owner, key.repo_name, key.branch],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<i64>>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, i64>(5)?,
                    ))
                },
            )
            .optional()?;

        let Some((base, chapters_json, head_sha, seen_at, created_at, updated_at)) = row else {
            return Ok(None);
        };
        let chapters: Vec<Chapter> = serde_json::from_str(&chapters_json)?;
        Ok(Some(Debrief {
            base,
            chapters,
            head_sha,
            seen_at,
            created_at,
            updated_at,
        }))
    }

    /// Upsert the Debrief for `key` — the agent's full account, replaced whole
    /// on every pass. `created_at` is preserved across regenerations;
    /// `updated_at` is bumped. `head_sha` is the branch head the account
    /// describes: rewriting at the **same** head keeps `seen_at` (intro edits
    /// don't un-see), rewriting at a **new** head clears it, so the freshness
    /// chip flips back to `new`.
    pub fn set_debrief(
        &self,
        key: &RepoKey,
        base: &str,
        chapters: Vec<Chapter>,
        head_sha: &str,
    ) -> Result<Debrief, StageError> {
        let chapters_json = serde_json::to_string(&chapters)?;
        let now = now_epoch();
        let existing = self.get_debrief(key)?;
        let created_at = existing.as_ref().map(|h| h.created_at).unwrap_or(now);
        let seen_at = existing
            .filter(|h| h.head_sha == head_sha)
            .and_then(|h| h.seen_at);

        self.conn.execute(
            "INSERT INTO debrief \
                (repo_owner, repo_name, branch, base, chapters_json, head_sha, seen_at, \
                 created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
             ON CONFLICT(repo_owner, repo_name, branch) DO UPDATE SET \
                base = excluded.base, \
                chapters_json = excluded.chapters_json, \
                head_sha = excluded.head_sha, \
                seen_at = excluded.seen_at, \
                updated_at = excluded.updated_at",
            params![
                key.repo_owner,
                key.repo_name,
                key.branch,
                base,
                chapters_json,
                head_sha,
                seen_at,
                created_at,
                now
            ],
        )?;

        Ok(Debrief {
            base: base.to_string(),
            chapters,
            head_sha: head_sha.to_string(),
            seen_at,
            created_at,
            updated_at: now,
        })
    }

    /// Record that the author opened the Debrief for `key` (sets `seen_at` to
    /// now; idempotent — re-opening refreshes the timestamp). Returns the
    /// updated Debrief, or `None` when there is none to mark.
    pub fn mark_debrief_seen(&self, key: &RepoKey) -> Result<Option<Debrief>, StageError> {
        let now = now_epoch();
        let changed = self.conn.execute(
            "UPDATE debrief SET seen_at = ?4 \
             WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
            params![key.repo_owner, key.repo_name, key.branch, now],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.get_debrief(key)
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

    /// Freshness inputs of every stored Debrief for a repo, keyed by branch:
    /// `(head_sha, seen_at)` — what [`crate::domain::Debrief::freshness`]
    /// derives from, without deserializing chapter bodies per branch.
    pub fn list_debrief_freshness_inputs(
        &self,
        repo_owner: &str,
        repo_name: &str,
    ) -> Result<std::collections::HashMap<String, (String, Option<i64>)>, StageError> {
        let mut stmt = self.conn.prepare(
            "SELECT branch, head_sha, seen_at FROM debrief \
             WHERE repo_owner = ?1 AND repo_name = ?2",
        )?;
        let rows = stmt
            .query_map(params![repo_owner, repo_name], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?),
                ))
            })?
            .collect::<Result<std::collections::HashMap<_, _>, _>>()?;
        Ok(rows)
    }

    // --- Self-Review viewed marks + done state (v6-light L2; F2/F2b/F3) -----

    /// Upsert a viewed mark, anchored to `blob_oid` (the post-image the author
    /// saw — see [`crate::viewed`]). Re-marking refreshes both anchor and time.
    pub fn set_viewed(&self, key: &RepoKey, file: &str, blob_oid: &str) -> Result<(), StageError> {
        self.conn.execute(
            "INSERT INTO self_review_viewed \
                 (repo_owner, repo_name, branch, file, blob_oid, viewed_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT (repo_owner, repo_name, branch, file) \
             DO UPDATE SET blob_oid = excluded.blob_oid, viewed_at = excluded.viewed_at",
            params![
                key.repo_owner,
                key.repo_name,
                key.branch,
                file,
                blob_oid,
                now_epoch()
            ],
        )?;
        Ok(())
    }

    /// Remove one viewed mark. Idempotent.
    pub fn unset_viewed(&self, key: &RepoKey, file: &str) -> Result<(), StageError> {
        self.conn.execute(
            "DELETE FROM self_review_viewed \
             WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3 AND file = ?4",
            params![key.repo_owner, key.repo_name, key.branch, file],
        )?;
        Ok(())
    }

    /// Remove every viewed mark for a branch ("Clear viewed").
    pub fn clear_viewed(&self, key: &RepoKey) -> Result<(), StageError> {
        self.conn.execute(
            "DELETE FROM self_review_viewed \
             WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
            params![key.repo_owner, key.repo_name, key.branch],
        )?;
        Ok(())
    }

    /// All stored viewed marks for a branch — anchors included, validity is
    /// the caller's derivation (`crate::viewed`).
    pub fn list_viewed(&self, key: &RepoKey) -> Result<Vec<ViewedMark>, StageError> {
        let mut stmt = self.conn.prepare(
            "SELECT file, blob_oid, viewed_at FROM self_review_viewed \
             WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3 \
             ORDER BY file",
        )?;
        let marks = stmt
            .query_map(params![key.repo_owner, key.repo_name, key.branch], |r| {
                Ok(ViewedMark {
                    file: r.get(0)?,
                    blob_oid: r.get(1)?,
                    viewed_at: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(marks)
    }

    /// All stored viewed marks for a repo, keyed by branch — one query for the
    /// overview assembly instead of a per-branch round-trip.
    pub fn list_viewed_by_branch(
        &self,
        repo_owner: &str,
        repo_name: &str,
    ) -> Result<std::collections::HashMap<String, Vec<ViewedMark>>, StageError> {
        let mut stmt = self.conn.prepare(
            "SELECT branch, file, blob_oid, viewed_at FROM self_review_viewed \
             WHERE repo_owner = ?1 AND repo_name = ?2 \
             ORDER BY branch, file",
        )?;
        let mut out: std::collections::HashMap<String, Vec<ViewedMark>> =
            std::collections::HashMap::new();
        let rows = stmt.query_map(params![repo_owner, repo_name], |r| {
            Ok((
                r.get::<_, String>(0)?,
                ViewedMark {
                    file: r.get(1)?,
                    blob_oid: r.get(2)?,
                    viewed_at: r.get(3)?,
                },
            ))
        })?;
        for row in rows {
            let (branch, mark) = row?;
            out.entry(branch).or_default().push(mark);
        }
        Ok(out)
    }

    /// Note counts for a repo, keyed by branch — one query for the overview
    /// assembly, the note-side twin of [`Store::list_viewed_by_branch`]. Every
    /// note counts regardless of status: a resolved note is still proof the
    /// author started reviewing this branch.
    pub fn count_notes_by_branch(
        &self,
        repo_owner: &str,
        repo_name: &str,
    ) -> Result<std::collections::HashMap<String, u32>, StageError> {
        let mut stmt = self.conn.prepare(
            "SELECT branch, COUNT(*) FROM review_note \
             WHERE repo_owner = ?1 AND repo_name = ?2 \
             GROUP BY branch",
        )?;
        let rows = stmt.query_map(params![repo_owner, repo_name], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<std::collections::HashMap<_, _>>>()?)
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
        let uncommitted = anchor.is_some_and(|a| a.uncommitted);
        self.conn.execute(
            "INSERT INTO review_note \
                (id, repo_owner, repo_name, branch, file, line_start, line_end, side, \
                 uncommitted, body, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
            params![
                id,
                key.repo_owner,
                key.repo_name,
                key.branch,
                file,
                line_start,
                line_end,
                side,
                uncommitted,
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
                    created_at, updated_at, uncommitted FROM review_note \
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
                        created_at, updated_at, uncommitted FROM review_note \
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

    /// Choose/change the draft's Base branch (GAP-2, #92). The author may retarget
    /// the change against a different base before (re-)publishing; the value is
    /// the ref used for the diff and serialized into `review.toml` at Publish
    /// (e.g. `"origin/main"` — the remote-tracking ref is preferred over a stale
    /// local copy, ADR-0016/0018). Fails loud if no draft exists for `key`.
    pub fn set_review_base_ref(&self, key: &RepoKey, base_ref: &str) -> Result<Review, StageError> {
        let now = now_epoch();
        let changed = self.conn.execute(
            "UPDATE review_draft SET base_ref = ?1, updated_at = ?2 \
             WHERE repo_owner = ?3 AND repo_name = ?4 AND branch = ?5",
            params![base_ref, now, key.repo_owner, key.repo_name, key.branch],
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

    /// Record the GitHub PR number on the draft once it has been published
    /// (PUB-1/PUB-3, milestone D). Idempotent — re-publishing to the same PR sets
    /// the same value. This mirrors the `pr_number` committed into `review.toml`;
    /// the committed `.stage` stays authoritative post-publish, the store row just
    /// remembers "this branch's draft has an open PR" for this machine. Fails loud
    /// if no draft exists for `key`.
    pub fn set_review_pr_number(
        &self,
        key: &RepoKey,
        pr_number: u32,
    ) -> Result<Review, StageError> {
        let now = now_epoch();
        let changed = self.conn.execute(
            "UPDATE review_draft SET pr_number = ?1, updated_at = ?2 \
             WHERE repo_owner = ?3 AND repo_name = ?4 AND branch = ?5",
            params![pr_number, now, key.repo_owner, key.repo_name, key.branch],
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
        // Cascade the draft's storyline steps (milestone B) — there's no SQL
        // foreign key (the link is code-enforced, like note↔reply), so delete
        // them explicitly. Without this, discard-then-recreate on the same
        // (repo, branch) would resurrect the old, orphaned steps.
        self.conn.execute(
            "DELETE FROM review_draft_step \
             WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
            params![key.repo_owner, key.repo_name, key.branch],
        )?;
        let removed = self.conn.execute(
            "DELETE FROM review_draft WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
            params![key.repo_owner, key.repo_name, key.branch],
        )?;
        Ok(removed > 0)
    }

    // --- Pre-publish draft storyline steps (ADR-0022 §1, milestone B) --------
    //
    // The draft's ordered steps (SL-1..3). They live here, beside the draft
    // Review row, until Publish serializes them into `.stage/<branch>/steps/`
    // (milestone D). Single-writer / single-machine (ADR-0022 §2): composing
    // requires the Ready-to-share draft, and every op is scoped to one
    // (repo, branch) — a step on one branch is invisible to another. Step ids
    // are store-minted (`st_<hex>`) like reply ids: a step's id is an internal
    // handle for reorder/edit/remove, not a public identity, so the store mints
    // it via `randomblob` rather than taking a uuid dependency. Order semantics
    // here are by `order_index`, not the committed `NNN_` filename prefix — that
    // mapping happens only at Publish.

    /// Append a step to the draft storyline (SL-1 #65 / SL-2 #66). `order` is the
    /// next slot (current max + 1, or 0 when empty), so a fresh add lands last.
    ///
    /// Fails loud (CLAUDE.md) if there is no Ready-to-share draft for `key`
    /// (composing requires the draft — there's no implicit draft creation) or if
    /// a step already anchors `anchor` (v1 is one step per file). Diff-membership
    /// of `anchor` is validated a layer up in [`crate::storyline::add_step`],
    /// which has the repo path; the store enforces only what it can see.
    pub fn add_storyline_step(
        &self,
        key: &RepoKey,
        anchor: &str,
        title: Option<&str>,
        intro: &str,
    ) -> Result<StorylineStep, StageError> {
        if self.get_review_draft(key)?.is_none() {
            return Err(StageError::Invalid(format!(
                "no storyline draft for branch '{}' — mark the change Ready to share first",
                key.branch
            )));
        }
        if self.storyline_step_id_by_anchor(key, anchor)?.is_some() {
            return Err(StageError::Invalid(format!(
                "the storyline already has a step for '{anchor}'"
            )));
        }
        let now = now_epoch();
        let next_order: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(order_index) + 1, 0) FROM review_draft_step \
             WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3",
            params![key.repo_owner, key.repo_name, key.branch],
            |r| r.get(0),
        )?;
        let id: String = self.conn.query_row(
            "INSERT INTO review_draft_step \
                (id, repo_owner, repo_name, branch, anchor, title, intro, order_index, \
                 created_at, updated_at) \
             VALUES ('st_' || lower(hex(randomblob(8))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) \
             RETURNING id",
            params![
                key.repo_owner,
                key.repo_name,
                key.branch,
                anchor,
                title,
                intro,
                next_order,
                now,
            ],
            |r| r.get(0),
        )?;
        self.get_storyline_step(key, &id)?
            .ok_or_else(|| StageError::Invalid("storyline step vanished after insert".into()))
    }

    /// The draft storyline steps for `key`, ascending by `order_index` (id breaks
    /// ties for a stable order). Empty when nothing has been composed yet.
    pub fn list_storyline_steps(&self, key: &RepoKey) -> Result<Vec<StorylineStep>, StageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, anchor, title, intro, order_index, created_at, updated_at \
             FROM review_draft_step \
             WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3 \
             ORDER BY order_index, id",
        )?;
        let steps = stmt
            .query_map(
                params![key.repo_owner, key.repo_name, key.branch],
                storyline_step_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(steps)
    }

    /// A single draft step by id (within `key`'s scope), or `None`.
    pub fn get_storyline_step(
        &self,
        key: &RepoKey,
        id: &str,
    ) -> Result<Option<StorylineStep>, StageError> {
        let step = self
            .conn
            .query_row(
                "SELECT id, anchor, title, intro, order_index, created_at, updated_at \
                 FROM review_draft_step \
                 WHERE id = ?1 AND repo_owner = ?2 AND repo_name = ?3 AND branch = ?4",
                params![id, key.repo_owner, key.repo_name, key.branch],
                storyline_step_from_row,
            )
            .optional()?;
        Ok(step)
    }

    /// Edit a step's `title` and `intro` (SL-2 #66 / SL-3 #67). Replaces both
    /// editable fields outright — `title = None` clears the heading. The `anchor`
    /// and `order` are unchanged (reorder owns order). Fails loud on an unknown id.
    pub fn edit_storyline_step(
        &self,
        key: &RepoKey,
        id: &str,
        title: Option<&str>,
        intro: &str,
    ) -> Result<StorylineStep, StageError> {
        let now = now_epoch();
        let changed = self.conn.execute(
            "UPDATE review_draft_step SET title = ?1, intro = ?2, updated_at = ?3 \
             WHERE id = ?4 AND repo_owner = ?5 AND repo_name = ?6 AND branch = ?7",
            params![
                title,
                intro,
                now,
                id,
                key.repo_owner,
                key.repo_name,
                key.branch,
            ],
        )?;
        if changed == 0 {
            return Err(StageError::Invalid(format!(
                "no storyline step with id '{id}'"
            )));
        }
        self.get_storyline_step(key, id)?
            .ok_or_else(|| StageError::Invalid("storyline step vanished after update".into()))
    }

    /// Remove a step from the draft storyline (SL-3 #67). Fails loud on an unknown
    /// id. Leaves a gap in `order_index` (harmless — `list` sorts); a later
    /// [`Store::reorder_storyline_steps`] compacts the order.
    pub fn remove_storyline_step(&self, key: &RepoKey, id: &str) -> Result<(), StageError> {
        let removed = self.conn.execute(
            "DELETE FROM review_draft_step \
             WHERE id = ?1 AND repo_owner = ?2 AND repo_name = ?3 AND branch = ?4",
            params![id, key.repo_owner, key.repo_name, key.branch],
        )?;
        if removed == 0 {
            return Err(StageError::Invalid(format!(
                "no storyline step with id '{id}'"
            )));
        }
        Ok(())
    }

    /// Reorder the draft storyline to exactly `ordered_ids` (SL-3 #67). Rewrites
    /// each step's `order_index` to its position in the list (0-based, compact).
    ///
    /// Fails loud unless `ordered_ids` is a permutation of the draft's current
    /// step ids — a partial or unknown set is rejected wholesale (no silent
    /// drop/duplicate), per CLAUDE.md fail-loud. Runs in a transaction so a
    /// rejected reorder leaves the existing order intact.
    pub fn reorder_storyline_steps(
        &self,
        key: &RepoKey,
        ordered_ids: &[String],
    ) -> Result<Vec<StorylineStep>, StageError> {
        let current: HashSet<String> = self
            .list_storyline_steps(key)?
            .into_iter()
            .map(|s| s.id)
            .collect();
        let requested: HashSet<&String> = ordered_ids.iter().collect();
        if current.len() != ordered_ids.len() || requested.len() != ordered_ids.len() {
            return Err(StageError::Invalid(format!(
                "reorder must list each of the {} storyline step(s) exactly once (got {})",
                current.len(),
                ordered_ids.len()
            )));
        }
        if ordered_ids.iter().any(|id| !current.contains(id)) {
            return Err(StageError::Invalid(
                "reorder lists a step id that isn't in this storyline".into(),
            ));
        }

        let now = now_epoch();
        // `unchecked_transaction` takes `&self` (every other Store method does
        // too); safe here as we never hold two transactions on this connection.
        let tx = self.conn.unchecked_transaction()?;
        for (position, id) in ordered_ids.iter().enumerate() {
            tx.execute(
                "UPDATE review_draft_step SET order_index = ?1, updated_at = ?2 \
                 WHERE id = ?3 AND repo_owner = ?4 AND repo_name = ?5 AND branch = ?6",
                params![
                    position as i64,
                    now,
                    id,
                    key.repo_owner,
                    key.repo_name,
                    key.branch,
                ],
            )?;
        }
        tx.commit()?;
        self.list_storyline_steps(key)
    }

    /// The id of the step anchoring `anchor` in `key`'s draft, if any (the
    /// one-step-per-file guard for [`Store::add_storyline_step`]).
    fn storyline_step_id_by_anchor(
        &self,
        key: &RepoKey,
        anchor: &str,
    ) -> Result<Option<String>, StageError> {
        let id = self
            .conn
            .query_row(
                "SELECT id FROM review_draft_step \
                 WHERE repo_owner = ?1 AND repo_name = ?2 AND branch = ?3 AND anchor = ?4",
                params![key.repo_owner, key.repo_name, key.branch, anchor],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        Ok(id)
    }

    /// Every pre-publish draft Review in `(repo_owner, repo_name)`, newest first.
    /// This is the local-store half of the dashboard scan (DB-1 #84): one row per
    /// branch the author hit "Ready to share" on, *on this machine* (drafts are
    /// strictly per-machine — ADR-0022 §3). Unlike [`Store::get_review_draft`]
    /// this spans branches, so the dashboard sees every in-progress Review at once.
    pub fn list_review_drafts(
        &self,
        repo_owner: &str,
        repo_name: &str,
    ) -> Result<Vec<Review>, StageError> {
        let mut stmt = self.conn.prepare(
            "SELECT title, base_ref, head_ref, pr_number, created_at, updated_at \
             FROM review_draft \
             WHERE repo_owner = ?1 AND repo_name = ?2 \
             ORDER BY updated_at DESC",
        )?;
        let drafts = stmt
            .query_map(params![repo_owner, repo_name], |r| {
                Ok(Review {
                    title: r.get(0)?,
                    base_ref: r.get(1)?,
                    head_ref: r.get(2)?,
                    pr_number: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(drafts)
    }
}

/// Map a `review_note` row to a [`SelfReviewNote`] **without** its thread — callers
/// hydrate `replies` via [`Store::hydrate`]. Column order:
/// `id, file, line_start, line_end, side, body, status, created_at, updated_at,
/// uncommitted`. A bad `status`/`side` string is a loud failure, never a silent
/// default.
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
    let uncommitted: bool = r.get(9)?;
    let anchor = file.map(|file| NoteAnchor {
        file,
        line_start,
        line_end,
        side,
        uncommitted,
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

/// Map a `review_draft_step` row to a [`StorylineStep`]. Column order:
/// `id, anchor, title, intro, order_index, created_at, updated_at`.
fn storyline_step_from_row(r: &rusqlite::Row) -> rusqlite::Result<StorylineStep> {
    Ok(StorylineStep {
        id: r.get(0)?,
        anchor: r.get(1)?,
        title: r.get(2)?,
        intro: r.get(3)?,
        order: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
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
    // v5 — Pre-publish draft storyline steps (ADR-0022 §1, milestone B). The
    // draft Review's ordered steps (SL-1..3): one row per step, scoped to the
    // same (repo_owner, repo_name, branch) as its draft. `anchor` is a repo-
    // relative file in the change's diff; `title` is optional; `intro` is the
    // markdown body; `order_index` is the ascending presentation order (mapped to
    // the committed `NNN_` filename prefix only at Publish). Ids are store-minted
    // (`st_<hex>`). No FK to review_draft — the link is code-enforced (scope
    // columns + the draft-exists guard in `add_storyline_step`), matching the
    // note↔reply convention above; `discard_review_draft` leaves orphan steps
    // only if a draft is discarded, which the lifecycle handles at that layer.
    "CREATE TABLE IF NOT EXISTS review_draft_step (
        id          TEXT    NOT NULL PRIMARY KEY,
        repo_owner  TEXT    NOT NULL,
        repo_name   TEXT    NOT NULL,
        branch      TEXT    NOT NULL,
        anchor      TEXT    NOT NULL,
        title       TEXT,
        intro       TEXT    NOT NULL,
        order_index INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS review_draft_step_scope
        ON review_draft_step (repo_owner, repo_name, branch, order_index);",
    // v6 — Debriefs become Chapters (ADR-0025, v6-light L1): `chapters_json`
    // replaces `steps_json`, plus the freshness inputs `head_sha` (branch head
    // at write time) and nullable `seen_at` (author opened it; cleared by a
    // rewrite at a new head). Existing per-file-steps rows are **dropped, not
    // converted** — the deliberate ADR-0025 hard break. A Debrief is an
    // ephemeral per-machine agent artifact, overwritten on every agent pass and
    // regenerated by re-running the self-review-debrief skill, so discarding
    // beats both a permanent legacy reader and failing the whole store open.
    "DROP TABLE IF EXISTS debrief;
    CREATE TABLE debrief (
        repo_owner    TEXT    NOT NULL,
        repo_name     TEXT    NOT NULL,
        branch        TEXT    NOT NULL,
        base          TEXT    NOT NULL,
        chapters_json TEXT    NOT NULL,
        head_sha      TEXT    NOT NULL,
        seen_at       INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (repo_owner, repo_name, branch)
    ) WITHOUT ROWID;",
    // v7 — Self-Review viewed marks + done state (v6-light L2; flags F2/F2b/F3).
    // Viewed marks migrate here from the webview-only plugin-store so the
    // engine (overview rows) and later the CLI can read them. `blob_oid` is the
    // content anchor (the post-image the author saw); validity is derived at
    // read time against the file's current post-image — stale rows are ignored,
    // never pruned (content-addressed like git: undoing the edit restores the
    // mark). `self_review_done` mirrors the debrief-freshness pattern: the
    // stored `head_sha` is compared with the branch's current head at read
    // time; a moved head invalidates it. Neither table stores a derived flag.
    "CREATE TABLE IF NOT EXISTS self_review_viewed (
        repo_owner TEXT    NOT NULL,
        repo_name  TEXT    NOT NULL,
        branch     TEXT    NOT NULL,
        file       TEXT    NOT NULL,
        blob_oid   TEXT    NOT NULL,
        viewed_at  INTEGER NOT NULL,
        PRIMARY KEY (repo_owner, repo_name, branch, file)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS self_review_done (
        repo_owner TEXT    NOT NULL,
        repo_name  TEXT    NOT NULL,
        branch     TEXT    NOT NULL,
        head_sha   TEXT    NOT NULL,
        done_at    INTEGER NOT NULL,
        PRIMARY KEY (repo_owner, repo_name, branch)
    ) WITHOUT ROWID;",
    // v8 — "Mark reviewed" removed (v6-light L7, flag F3 rescinded): the
    // explicit per-branch done state never got a clear contract (what sets it,
    // what invalidates it, how it differs from all-files-viewed), so the
    // feature is out until full v6 defines it properly. The table drops with
    // it — the state is cheap to re-derive by re-marking if the feature
    // returns. Viewed marks (`self_review_viewed`) are untouched.
    "DROP TABLE IF EXISTS self_review_done;",
    // v9 — Review notes carry the Self-Review *section* they were left in: the
    // committed diff, or the uncommitted working-tree section. The two render
    // the same path at different line numbers, so without this a note left on
    // an uncommitted edit would also surface — at the wrong lines — on the
    // committed block, and `outdated` would be computed against the diff it
    // does not belong to. Existing rows are committed-section notes, which is
    // exactly what the default says.
    "ALTER TABLE review_note ADD COLUMN uncommitted INTEGER NOT NULL DEFAULT 0;",
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
    use crate::domain::DebriefFreshness;

    fn key() -> RepoKey {
        RepoKey {
            repo_owner: "octo".into(),
            repo_name: "stage".into(),
            branch: "feat/x".into(),
        }
    }

    fn chapter(title: &str, files: &[&str]) -> Chapter {
        Chapter {
            title: title.into(),
            intro: format!("what changed in {title}"),
            files: files.iter().map(|f| f.to_string()).collect(),
        }
    }

    const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn viewed_marks_round_trip_and_clear() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("debrief.sqlite3")).unwrap();
        let k = key();

        store.set_viewed(&k, "src/a.rs", SHA_A).unwrap();
        store.set_viewed(&k, "src/b.rs", SHA_B).unwrap();
        let marks = store.list_viewed(&k).unwrap();
        assert_eq!(
            marks
                .iter()
                .map(|m| (m.file.as_str(), m.blob_oid.as_str()))
                .collect::<Vec<_>>(),
            vec![("src/a.rs", SHA_A), ("src/b.rs", SHA_B)]
        );

        // Re-marking rebinds the anchor (upsert, no duplicate row).
        store.set_viewed(&k, "src/a.rs", SHA_B).unwrap();
        let marks = store.list_viewed(&k).unwrap();
        assert_eq!(marks.len(), 2);
        assert_eq!(marks[0].blob_oid, SHA_B);

        store.unset_viewed(&k, "src/a.rs").unwrap();
        assert_eq!(store.list_viewed(&k).unwrap().len(), 1);

        store.clear_viewed(&k).unwrap();
        assert!(store.list_viewed(&k).unwrap().is_empty());
    }

    #[test]
    fn viewed_marks_scope_by_branch_and_group_repo_wide() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("debrief.sqlite3")).unwrap();
        let k1 = key();
        let k2 = RepoKey {
            branch: "feat/y".into(),
            ..key()
        };

        store.set_viewed(&k1, "src/a.rs", SHA_A).unwrap();
        store.set_viewed(&k2, "src/a.rs", SHA_B).unwrap();

        assert_eq!(store.list_viewed(&k1).unwrap()[0].blob_oid, SHA_A);
        let by_branch = store
            .list_viewed_by_branch(&k1.repo_owner, &k1.repo_name)
            .unwrap();
        assert_eq!(by_branch.len(), 2);
        assert_eq!(by_branch["feat/x"][0].blob_oid, SHA_A);
        assert_eq!(by_branch["feat/y"][0].blob_oid, SHA_B);
    }

    #[test]
    fn debrief_freshness_inputs_list_repo_wide() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("debrief.sqlite3")).unwrap();
        let k = key();
        store
            .set_debrief(&k, "main", vec![chapter("Core", &["src/a.rs"])], SHA_A)
            .unwrap();
        store.mark_debrief_seen(&k).unwrap();

        let inputs = store
            .list_debrief_freshness_inputs(&k.repo_owner, &k.repo_name)
            .unwrap();
        let (head, seen) = &inputs["feat/x"];
        assert_eq!(head, SHA_A);
        assert!(seen.is_some());
    }

    #[test]
    fn debrief_round_trips_chapters_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("debrief.sqlite3")).unwrap();
        let k = key();

        assert!(store.get_debrief(&k).unwrap().is_none());

        let chapters = vec![
            chapter("Core state", &["state.rs", "flow.rs"]),
            chapter("Steps", &["payment.rs"]),
        ];
        let saved = store
            .set_debrief(&k, "main", chapters.clone(), SHA_A)
            .unwrap();
        assert_eq!(saved.base, "main");
        assert_eq!(saved.head_sha, SHA_A);
        assert_eq!(saved.seen_at, None);

        let got = store.get_debrief(&k).unwrap().expect("debrief present");
        assert_eq!(got.chapters, chapters);
        assert_eq!(got.created_at, saved.created_at);
    }

    #[test]
    fn set_preserves_created_at_and_clear_removes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("debrief.sqlite3")).unwrap();
        let k = key();

        let first = store
            .set_debrief(&k, "main", vec![chapter("A", &["a.rs"])], SHA_A)
            .unwrap();
        let second = store
            .set_debrief(
                &k,
                "develop",
                vec![chapter("A", &["a.rs"]), chapter("C", &["c.rs"])],
                SHA_A,
            )
            .unwrap();

        // Regenerating keeps the original created_at and updates the base.
        assert_eq!(second.created_at, first.created_at);
        assert_eq!(second.base, "develop");
        assert_eq!(store.get_debrief(&k).unwrap().unwrap().chapters.len(), 2);

        assert!(store.clear_debrief(&k).unwrap());
        assert!(!store.clear_debrief(&k).unwrap()); // idempotent
        assert!(store.get_debrief(&k).unwrap().is_none());
    }

    #[test]
    fn seen_survives_same_head_rewrite_and_resets_on_new_head() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("debrief.sqlite3")).unwrap();
        let k = key();

        // Unmarked store → nothing to mark.
        assert!(store.mark_debrief_seen(&k).unwrap().is_none());

        store
            .set_debrief(&k, "main", vec![chapter("A", &["a.rs"])], SHA_A)
            .unwrap();
        let seen = store
            .mark_debrief_seen(&k)
            .unwrap()
            .expect("debrief present");
        assert!(seen.seen_at.is_some());

        // Rewrite at the SAME head: intro edits don't un-see.
        let same = store
            .set_debrief(&k, "main", vec![chapter("A2", &["a.rs"])], SHA_A)
            .unwrap();
        assert_eq!(same.seen_at, seen.seen_at);

        // Rewrite at a NEW head: seen resets → freshness flips back to new.
        let moved = store
            .set_debrief(&k, "main", vec![chapter("A3", &["a.rs"])], SHA_B)
            .unwrap();
        assert_eq!(moved.seen_at, None);
    }

    #[test]
    fn freshness_derives_new_seen_outdated() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("debrief.sqlite3")).unwrap();
        let k = key();

        let fresh = store
            .set_debrief(&k, "main", vec![chapter("A", &["a.rs"])], SHA_A)
            .unwrap();
        assert_eq!(fresh.freshness(SHA_A), DebriefFreshness::New);

        let seen = store.mark_debrief_seen(&k).unwrap().unwrap();
        assert_eq!(seen.freshness(SHA_A), DebriefFreshness::Seen);
        // Outdated wins over seen: the branch head moved past the record.
        assert_eq!(seen.freshness(SHA_B), DebriefFreshness::Outdated);
    }

    #[test]
    fn distinct_keys_are_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("debrief.sqlite3")).unwrap();
        let mut other = key();
        other.branch = "main".into();

        store
            .set_debrief(&key(), "main", vec![chapter("A", &["a.rs"])], SHA_A)
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
                .set_debrief(&k, "main", vec![chapter("A", &["a.rs"])], SHA_A)
                .unwrap();
        }
        // Re-open: migrations already applied, data survives.
        let store = Store::open(&path).unwrap();
        assert_eq!(store.get_debrief(&k).unwrap().unwrap().base, "main");
    }

    #[test]
    fn v6_migration_drops_legacy_steps_debriefs() {
        // A store created at schema v5 with a legacy per-file-steps row: after
        // the v6 migration the row is gone (ADR-0025 hard break — dropped, not
        // converted) and the chapters shape works.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("debrief.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            // Replay migrations v1..v5 only, as an old binary would have.
            for statement in &MIGRATIONS[..5] {
                conn.execute_batch(statement).unwrap();
            }
            conn.pragma_update(None, "user_version", 5).unwrap();
            conn.execute(
                "INSERT INTO debrief \
                    (repo_owner, repo_name, branch, base, steps_json, created_at, updated_at) \
                 VALUES ('octo', 'stage', 'feat/x', 'main', \
                    '[{\"file\":\"a.rs\",\"intro\":\"legacy\",\"order\":0}]', 1, 1)",
                [],
            )
            .unwrap();
        }

        let store = Store::open(&path).unwrap();
        let k = key();
        assert!(store.get_debrief(&k).unwrap().is_none(), "legacy dropped");
        store
            .set_debrief(&k, "main", vec![chapter("A", &["a.rs"])], SHA_A)
            .unwrap();
        assert_eq!(store.get_debrief(&k).unwrap().unwrap().chapters.len(), 1);
    }

    fn anchor(file: &str) -> NoteAnchor {
        NoteAnchor {
            file: file.into(),
            line_start: Some(1),
            line_end: Some(3),
            side: Some(Side::Right),
            uncommitted: false,
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
    fn note_anchor_carries_its_self_review_section() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.sqlite3")).unwrap();
        let k = key();
        let mut uncommitted = anchor("a.rs");
        uncommitted.uncommitted = true;

        store
            .create_note(&k, "n1", Some(&anchor("a.rs")), "committed note")
            .unwrap();
        store
            .create_note(&k, "n2", Some(&uncommitted), "working-tree note")
            .unwrap();

        // Same path, two sections — the section round-trips, so the reader can
        // tell which block each note belongs to.
        let committed = store.get_note(&k, "n1").unwrap().unwrap();
        assert!(!committed.anchor.unwrap().uncommitted);
        let working = store.get_note(&k, "n2").unwrap().unwrap();
        let a = working.anchor.unwrap();
        assert_eq!(a.file, "a.rs");
        assert!(a.uncommitted);
    }

    #[test]
    fn migration_v9_reads_pre_section_notes_as_committed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.sqlite3");
        // Hand-build a v8 store (every migration up to, but not including, the
        // `uncommitted` column) and insert a note the old way.
        {
            let conn = Connection::open(&path).unwrap();
            for statement in &MIGRATIONS[..8] {
                conn.execute_batch(statement).unwrap();
            }
            conn.execute(
                "INSERT INTO review_note \
                    (id, repo_owner, repo_name, branch, file, line_start, line_end, side, \
                     body, status, created_at, updated_at) \
                 VALUES ('n1','octo','stage','feat/x','a.rs',1,3,'right','rename it','open',100,200)",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 8i64).unwrap();
        }

        // A note written before the section existed *was* a committed-diff note.
        let store = Store::open(&path).unwrap();
        let note = store
            .get_note(&key(), "n1")
            .unwrap()
            .expect("note survived");
        assert!(!note.anchor.unwrap().uncommitted);
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
    fn list_review_drafts_is_scoped_to_the_repo() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("drafts.sqlite3")).unwrap();
        let mk = |repo: &str, branch: &str| RepoKey {
            repo_owner: "octo".into(),
            repo_name: repo.into(),
            branch: branch.into(),
        };
        let a = mk("stage", "feat/a");
        let b = mk("stage", "feat/b");
        let elsewhere = mk("other", "feat/c");

        // No drafts yet → an empty list, never an error (the dashboard scan of a
        // repo with no in-progress Reviews is a normal, quiet result).
        assert!(store
            .list_review_drafts("octo", "stage")
            .unwrap()
            .is_empty());

        store.create_review_draft(&a, "A", "origin/main").unwrap();
        store.create_review_draft(&b, "B", "origin/main").unwrap();
        store
            .create_review_draft(&elsewhere, "C", "origin/main")
            .unwrap();

        let drafts = store.list_review_drafts("octo", "stage").unwrap();
        // Scoped to the (owner, repo): the other repo's draft is excluded.
        assert_eq!(drafts.len(), 2, "only (octo, stage) drafts");
        let branches: std::collections::HashSet<&str> =
            drafts.iter().map(|d| d.head_ref.as_str()).collect();
        assert_eq!(
            branches,
            std::collections::HashSet::from(["feat/a", "feat/b"]),
        );
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

    // --- Draft storyline steps (milestone B) --------------------------------

    /// A store with a Ready-to-share draft for `key`, ready for step composition.
    fn store_with_draft() -> (tempfile::TempDir, Store, RepoKey) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.sqlite3")).unwrap();
        let k = key();
        store
            .create_review_draft(&k, "Ship the thing", "origin/main")
            .unwrap();
        (dir, store, k)
    }

    #[test]
    fn storyline_step_crud_and_append_order() {
        let (_dir, store, k) = store_with_draft();
        assert!(store.list_storyline_steps(&k).unwrap().is_empty());

        // Add appends in call order; ids are store-minted and distinct.
        let s1 = store
            .add_storyline_step(&k, "a.rs", Some("Rename"), "did a")
            .unwrap();
        let s2 = store.add_storyline_step(&k, "b.rs", None, "did b").unwrap();
        assert!(s1.id.starts_with("st_") && s2.id.starts_with("st_"));
        assert_ne!(s1.id, s2.id);
        assert_eq!(s1.title.as_deref(), Some("Rename"));
        assert_eq!(s2.title, None);
        assert!(s1.order < s2.order, "second add lands after the first");

        // List is ascending by order.
        let steps = store.list_storyline_steps(&k).unwrap();
        assert_eq!(
            steps.iter().map(|s| s.anchor.as_str()).collect::<Vec<_>>(),
            vec!["a.rs", "b.rs"],
        );

        // Edit replaces title + intro; clearing the title with None works.
        let edited = store
            .edit_storyline_step(&k, &s1.id, None, "did a, better")
            .unwrap();
        assert_eq!(edited.title, None);
        assert_eq!(edited.intro, "did a, better");
        assert_eq!(edited.anchor, "a.rs", "edit leaves the anchor untouched");
        assert!(edited.updated_at >= s1.updated_at);

        // Remove drops the step.
        store.remove_storyline_step(&k, &s2.id).unwrap();
        let steps = store.list_storyline_steps(&k).unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].id, s1.id);
    }

    #[test]
    fn storyline_reorder_rewrites_order_and_rejects_non_permutations() {
        let (_dir, store, k) = store_with_draft();
        let a = store.add_storyline_step(&k, "a.rs", None, "a").unwrap();
        let b = store.add_storyline_step(&k, "b.rs", None, "b").unwrap();
        let c = store.add_storyline_step(&k, "c.rs", None, "c").unwrap();

        // Reverse the order; list reflects the new arrangement.
        let reordered = store
            .reorder_storyline_steps(&k, &[c.id.clone(), b.id.clone(), a.id.clone()])
            .unwrap();
        assert_eq!(
            reordered
                .iter()
                .map(|s| s.anchor.as_str())
                .collect::<Vec<_>>(),
            vec!["c.rs", "b.rs", "a.rs"],
        );
        // Order indices are compacted to 0,1,2.
        assert_eq!(
            reordered.iter().map(|s| s.order).collect::<Vec<_>>(),
            vec![0, 1, 2],
        );

        // A partial list (missing a step) is rejected wholesale — no silent drop.
        let err = store
            .reorder_storyline_steps(&k, &[a.id.clone(), b.id.clone()])
            .unwrap_err();
        assert!(err.to_string().contains("exactly once"), "{err}");

        // A duplicate id is rejected (would otherwise drop a step).
        let err = store
            .reorder_storyline_steps(&k, &[a.id.clone(), a.id.clone(), b.id.clone()])
            .unwrap_err();
        assert!(err.to_string().contains("exactly once"), "{err}");

        // An unknown id is rejected.
        let err = store
            .reorder_storyline_steps(&k, &[a.id, b.id, "st_ghost".into()])
            .unwrap_err();
        assert!(err.to_string().contains("isn't in this storyline"), "{err}");

        // The rejected reorders left the order intact (transaction rollback / no-op).
        assert_eq!(
            store
                .list_storyline_steps(&k)
                .unwrap()
                .iter()
                .map(|s| s.anchor.as_str())
                .collect::<Vec<_>>(),
            vec!["c.rs", "b.rs", "a.rs"],
        );
    }

    #[test]
    fn composing_requires_a_ready_to_share_draft() {
        // No draft for this branch → add fails loud (single-writer: the draft is
        // the only home for a pre-publish storyline).
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.sqlite3")).unwrap();
        let k = key();
        assert!(store.get_review_draft(&k).unwrap().is_none());
        let err = store.add_storyline_step(&k, "a.rs", None, "x").unwrap_err();
        assert!(err.to_string().contains("Ready to share"), "{err}");
        // …and with no draft there are simply no steps (not an error).
        assert!(store.list_storyline_steps(&k).unwrap().is_empty());
    }

    #[test]
    fn one_step_per_file_and_unknown_ids_fail_loud() {
        let (_dir, store, k) = store_with_draft();
        store.add_storyline_step(&k, "a.rs", None, "a").unwrap();

        // v1: one step per file — a second step on the same anchor is rejected.
        let err = store
            .add_storyline_step(&k, "a.rs", None, "again")
            .unwrap_err();
        assert!(err.to_string().contains("already has a step"), "{err}");

        // Edit / remove on an unknown id fail loud, never silently no-op.
        assert!(store
            .edit_storyline_step(&k, "st_ghost", None, "x")
            .is_err());
        assert!(store.remove_storyline_step(&k, "st_ghost").is_err());
        assert!(store.get_storyline_step(&k, "st_ghost").unwrap().is_none());
    }

    #[test]
    fn storyline_steps_are_scoped_per_branch() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("h.sqlite3")).unwrap();
        let k = key(); // feat/x
        let mut other = key();
        other.branch = "main".into();
        store
            .create_review_draft(&k, "on feat/x", "origin/main")
            .unwrap();
        store
            .create_review_draft(&other, "on main", "origin/main")
            .unwrap();

        store.add_storyline_step(&k, "a.rs", None, "a").unwrap();
        // The other branch's draft has its own (empty) storyline; the same anchor
        // is free there (one-step-per-file is per-branch, not global).
        assert!(store.list_storyline_steps(&other).unwrap().is_empty());
        store
            .add_storyline_step(&other, "a.rs", None, "a on main")
            .unwrap();
        assert_eq!(store.list_storyline_steps(&k).unwrap().len(), 1);
        assert_eq!(store.list_storyline_steps(&other).unwrap().len(), 1);
    }

    #[test]
    fn discarding_a_draft_cascades_its_storyline_steps() {
        let (_dir, store, k) = store_with_draft();
        store.add_storyline_step(&k, "a.rs", None, "a").unwrap();
        store.add_storyline_step(&k, "b.rs", None, "b").unwrap();
        assert_eq!(store.list_storyline_steps(&k).unwrap().len(), 2);

        // Discard removes the draft AND its steps — no orphans survive.
        assert!(store.discard_review_draft(&k).unwrap());
        assert!(store.list_storyline_steps(&k).unwrap().is_empty());

        // Re-entering Ready-to-share starts from a clean storyline, not the old steps.
        store
            .create_review_draft(&k, "again", "origin/main")
            .unwrap();
        assert!(store.list_storyline_steps(&k).unwrap().is_empty());
    }

    #[test]
    fn storyline_step_table_is_added_to_a_pre_v5_store() {
        // A store migrated only through v4 (no review_draft_step) must gain it on
        // the next open, without disturbing existing data.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            for m in &MIGRATIONS[..4] {
                conn.execute_batch(m).unwrap();
            }
            conn.pragma_update(None, "user_version", 4i64).unwrap();
        }
        let store = Store::open(&path).unwrap();
        let k = key();
        store
            .create_review_draft(&k, "post-migration", "origin/main")
            .unwrap();
        let s = store
            .add_storyline_step(&k, "a.rs", Some("t"), "i")
            .unwrap();
        assert_eq!(s.anchor, "a.rs");
        assert_eq!(store.list_storyline_steps(&k).unwrap().len(), 1);
    }
}
