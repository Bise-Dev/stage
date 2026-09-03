//! Debrief domain types — see `CONTEXT.md` (**Debrief**) and ADR-0011.
//!
//! Timestamps are epoch **seconds** (UTC) to match the client's existing
//! convention (`git.rs::BranchInfo.updated_at`); the webview does the
//! formatting.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::chapter::Chapter;

/// A stored Debrief: the agent's ordered-Chapters account of its own branch
/// work (committed + uncommitted; no commit required), produced for the author
/// to review locally. Records the branch head SHA and write time so the UI can
/// present it as **new / seen / outdated** (ADR-0025; v6 decision record).
/// One Debrief per branch, overwritten on every agent pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Debrief {
    /// Base branch the diff was composed against (e.g. `"main"`).
    pub base: String,
    /// Chapters in presentation order (ADR-0025: title + one intro + files).
    pub chapters: Vec<Chapter>,
    /// Full SHA of the branch head at write time. A rewrite with a *new* head
    /// clears `seen_at`; the freshness chip derives from this (see
    /// [`Debrief::freshness`]).
    pub head_sha: String,
    /// When the author last opened this Debrief, epoch seconds; `None` until
    /// they do. Cleared whenever the agent rewrites at a new `head_sha`.
    // `i64` epoch seconds cross the JSON IPC boundary as a JS `number`, so the
    // generated TS must say `number` (ts-rs defaults 64-bit ints to `bigint`).
    #[ts(type = "number | null")]
    pub seen_at: Option<i64>,
    /// First-written time, epoch seconds. Preserved across regenerations.
    #[ts(type = "number")]
    pub created_at: i64,
    /// Last-written time, epoch seconds.
    #[ts(type = "number")]
    pub updated_at: i64,
}

/// Derived presentation state of a [`Debrief`] — computed at read time from
/// the stored `head_sha`/`seen_at` against the branch's *current* head, never
/// stored (the same derive-don't-store rule as `SelfReviewNoteView.outdated`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum DebriefFreshness {
    /// Written for the current head and not yet opened by the author.
    New,
    /// Written for the current head and the author has opened it.
    Seen,
    /// The branch head moved past the recorded SHA — the account may no
    /// longer match the code.
    Outdated,
}

impl DebriefFreshness {
    /// Derive the chip from the stored freshness inputs — the same rule
    /// wherever a Debrief is summarized (full read path or overview row).
    /// Outdated wins over seen: a stale account is stale whether or not the
    /// author read it.
    pub fn derive(
        recorded_head_sha: &str,
        seen_at: Option<i64>,
        current_head_sha: &str,
    ) -> DebriefFreshness {
        if recorded_head_sha != current_head_sha {
            DebriefFreshness::Outdated
        } else if seen_at.is_some() {
            DebriefFreshness::Seen
        } else {
            DebriefFreshness::New
        }
    }
}

impl Debrief {
    /// Derive the freshness chip given the branch's current head SHA.
    pub fn freshness(&self, current_head_sha: &str) -> DebriefFreshness {
        DebriefFreshness::derive(&self.head_sha, self.seen_at, current_head_sha)
    }

    /// Pair the Debrief with its derived freshness for emission.
    pub fn into_view(self, freshness: DebriefFreshness) -> DebriefView {
        DebriefView {
            freshness,
            debrief: self,
        }
    }
}

/// A [`Debrief`] plus its derived [`DebriefFreshness`] — the read-path shape
/// (mirrors [`SelfReviewNoteView`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DebriefView {
    #[serde(flatten)]
    #[ts(flatten)]
    pub debrief: Debrief,
    pub freshness: DebriefFreshness,
}

/// The stdin payload accepted by `stage self-review set` (chapters shape,
/// ADR-0025):
///
/// `{ "base": "main", "chapters": [{ "title": "…", "intro": "md", "files": ["…"] }] }`
///
/// The retired per-file `steps` shape is rejected loudly — see
/// [`DebriefInput::LEGACY_STEPS_ERROR`].
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DebriefInput {
    pub base: String,
    pub chapters: Vec<Chapter>,
}

impl DebriefInput {
    /// The actionable error for a payload in the retired `steps` shape.
    /// Surfaced when the JSON carries `steps` instead of `chapters`
    /// (ADR-0025's hard break, applied to the agent contract).
    pub const LEGACY_STEPS_ERROR: &'static str = "unsupported legacy debrief shape: this payload has per-file `steps`, but Debriefs are authored as `chapters` (title + one intro + ordered files) since ADR-0025. Re-read the self-review-debrief skill and send {\"base\": …, \"chapters\": [{\"title\": …, \"intro\": …, \"files\": […]}]}.";

    /// Parse the `stage self-review set` stdin document. A payload in the
    /// retired per-file `steps` shape gets [`Self::LEGACY_STEPS_ERROR`] instead
    /// of a generic serde failure, so the agent is pointed at the fix.
    pub fn from_json(raw: &str) -> Result<Self, crate::error::StageError> {
        let probe: serde_json::Value = serde_json::from_str(raw)?;
        if probe.get("steps").is_some() {
            return Err(crate::error::StageError::Invalid(
                Self::LEGACY_STEPS_ERROR.to_string(),
            ));
        }
        Ok(serde_json::from_str(raw)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debrief_input_parses_chapters() {
        let input = DebriefInput::from_json(
            r#"{"base":"main","chapters":[{"title":"A","intro":"md","files":["a.rs"]}]}"#,
        )
        .unwrap();
        assert_eq!(input.base, "main");
        assert_eq!(input.chapters.len(), 1);
        assert_eq!(input.chapters[0].files, vec!["a.rs"]);
    }

    #[test]
    fn debrief_input_rejects_legacy_steps_shape_loudly() {
        let err = DebriefInput::from_json(
            r#"{"base":"main","steps":[{"file":"a.rs","intro":"md","order":0}]}"#,
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("unsupported legacy debrief shape"),
            "got: {err}"
        );
    }
}

/// Lifecycle of a [`SelfReviewNote`]: `open` (author left it) → `addressed` (agent
/// replied) → `resolved` (author closed it, terminal). An author reply on an
/// addressed note re-raises it to `open`; the author may also reopen explicitly
/// (ADR-0012).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum NoteStatus {
    Open,
    Addressed,
    Resolved,
}

impl NoteStatus {
    /// The wire/string form stored in SQLite and emitted in JSON.
    pub fn as_str(self) -> &'static str {
        match self {
            NoteStatus::Open => "open",
            NoteStatus::Addressed => "addressed",
            NoteStatus::Resolved => "resolved",
        }
    }

    /// Parse the stored string form back into a status.
    pub fn from_db_str(s: &str) -> Option<Self> {
        match s {
            "open" => Some(NoteStatus::Open),
            "addressed" => Some(NoteStatus::Addressed),
            "resolved" => Some(NoteStatus::Resolved),
            _ => None,
        }
    }
}

/// Which side of the diff a line anchor targets: `left` = a deleted line (old
/// file), `right` = an added/context line (new file). Mirrors the webview's
/// `Side` and `@git-diff-view`'s `SplitSide`. Only meaningful with a line range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Side {
    Left,
    Right,
}

impl Side {
    /// The wire/string form stored in SQLite and emitted in JSON.
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Left => "left",
            Side::Right => "right",
        }
    }

    /// Parse the stored string form back into a side.
    pub fn from_db_str(s: &str) -> Option<Self> {
        match s {
            "left" => Some(Side::Left),
            "right" => Some(Side::Right),
            _ => None,
        }
    }
}

/// Where a [`SelfReviewNote`] is anchored in the diff: a file path, optionally a
/// line range on a given [`Side`]. Anchored to the *diff location*, not a
/// Debrief step, so it survives the agent regenerating the Debrief. A note may
/// have no anchor at all (general feedback) — see [`SelfReviewNote::anchor`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NoteAnchor {
    pub file: String,
    #[serde(default)]
    pub line_start: Option<u32>,
    #[serde(default)]
    pub line_end: Option<u32>,
    /// Which diff side the line range targets; `None` for a file-level anchor.
    #[serde(default)]
    pub side: Option<Side>,
    /// **Legacy** (pre-ADR-0030): which Self-Review *section* the anchor was
    /// left in — the committed diff (`false`) or the working-tree section
    /// (`true`). Self-Review no longer has two sections: "+ Uncommitted"
    /// widens the one diff, so every anchor written since is `false` and a
    /// note is identified by its path alone. The flag is still honoured on
    /// read, because it picks which diff `outdated` is computed against
    /// ([`crate::diff::notes_with_outdated`]) — a `true` anchor is checked
    /// against the working-tree diff, which is the stricter of the two.
    #[serde(default)]
    pub uncommitted: bool,
}

/// Who authored a thread entry on a [`SelfReviewNote`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ReplyAuthor {
    Author,
    Agent,
}

impl ReplyAuthor {
    /// The wire/string form stored in SQLite and emitted in JSON.
    pub fn as_str(self) -> &'static str {
        match self {
            ReplyAuthor::Author => "author",
            ReplyAuthor::Agent => "agent",
        }
    }

    /// Parse the stored string form back into an author.
    pub fn from_db_str(s: &str) -> Option<Self> {
        match s {
            "author" => Some(ReplyAuthor::Author),
            "agent" => Some(ReplyAuthor::Agent),
            _ => None,
        }
    }
}

/// A follow-up entry on a [`SelfReviewNote`]'s thread, after the opening `body`.
/// Either party can append: an agent reply marks the note `addressed`; an
/// author reply on an addressed note re-raises it to `open` (see ADR-0012).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NoteReply {
    /// App-minted UUID.
    pub id: String,
    pub author: ReplyAuthor,
    pub body: String,
    #[ts(type = "number")] // epoch seconds; JSON number on the wire (see Debrief)
    pub created_at: i64,
}

/// A **Self-Review note**: the author's annotation on a diff location, made
/// during Self-Review — before any shareable Review artifact exists (ADR-0019
/// §8; the bare noun "Review" is reserved for that artifact). A threaded
/// conversation: the opening author `body` plus `replies` from either party. The
/// agent reads outstanding notes, revises, and replies — closing the local
/// author↔agent loop (ADR-0012).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SelfReviewNote {
    /// App-minted UUID.
    pub id: String,
    /// The diff location, or `None` for general (un-anchored) feedback.
    #[serde(default)]
    pub anchor: Option<NoteAnchor>,
    /// The author's opening note text.
    pub body: String,
    pub status: NoteStatus,
    /// Follow-up thread entries, oldest first.
    #[serde(default)]
    pub replies: Vec<NoteReply>,
    #[ts(type = "number")] // epoch seconds; JSON number on the wire (see Debrief)
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

impl SelfReviewNote {
    /// Pair the note with a computed `outdated` flag for emission.
    pub fn into_view(self, outdated: bool) -> SelfReviewNoteView {
        SelfReviewNoteView {
            outdated,
            note: self,
        }
    }
}

/// A [`SelfReviewNote`] plus its computed `outdated` flag. `outdated` is never
/// stored — it's derived from whether the note's anchor still matches the
/// current Base diff: file gone, or (line-anchored) its line range on its side
/// is gone. Anchorless notes are never outdated. The **Stale step** pattern,
/// at line granularity (ADR-0012); see [`crate::diff::DiffLineIndex`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SelfReviewNoteView {
    #[serde(flatten)]
    #[ts(flatten)]
    pub note: SelfReviewNote,
    pub outdated: bool,
}

/// A **Review** — the per-change artifact (the renamed Workspace, ADR-0019 §8).
///
/// This is the *pre-publish draft* shape: the per-machine row created at the
/// explicit "Ready to share" transition (WS-2, #60). It carries the metadata
/// that is later serialized into `.stage/<branch>/review.toml` at Publish
/// (milestone D) — see [`crate::review_folder::ReviewMeta`].
///
/// Deliberately stores **no** lifecycle `state`/`archived` field: per ADR-0019
/// §7 (WS-5, #63) Review state, staleness and the dashboard signal are *computed
/// in Rust at read time, never stored*. A row's mere presence in the draft table
/// means "pre-publish draft"; everything else is derived.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Review {
    /// Human-readable Review title (WS-3, #61). Independent of the branch name
    /// and of the GitHub PR title — no auto-sync.
    pub title: String,
    /// Branch the change is composed against (GAP-2, #92), e.g. `"origin/main"`.
    pub base_ref: String,
    /// The Review's authoritative identity: the feature branch it rides on
    /// (WS-1, #59). The folder name under `.stage/` is only a fast path.
    pub head_ref: String,
    /// The GitHub PR number once published; `None` for an unpublished draft
    /// (no PR exists yet). Set at Publish (milestone D).
    #[serde(default)]
    pub pr_number: Option<u32>,
    /// First-written time, epoch seconds. Preserved across edits.
    #[ts(type = "number")] // epoch seconds; JSON number on the wire (see Debrief)
    pub created_at: i64,
    /// Last-written time, epoch seconds.
    #[ts(type = "number")]
    pub updated_at: i64,
}
