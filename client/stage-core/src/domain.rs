//! Debrief domain types — see `CONTEXT.md` (**Debrief**) and ADR-0011.
//!
//! Timestamps are epoch **seconds** (UTC) to match the client's existing
//! convention (`git.rs::BranchInfo.updated_at`); the webview does the
//! formatting.

use serde::{Deserialize, Serialize};

/// One step of a [`Debrief`]: an agent-authored intro anchored to a single
/// file in the Base-scope diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DebriefStep {
    /// Repo-relative path of a file present in the Base-scope diff.
    pub file: String,
    /// Agent-authored markdown explaining what the agent did to this file.
    pub intro: String,
    /// Presentation order, ascending. Defaulted to the array index on input.
    pub order: u32,
}

/// A stored Debrief: the agent's ordered, annotated account of its own
/// Base-scope changes, produced for the author to review locally.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Debrief {
    /// Base branch the diff was composed against (e.g. `"main"`).
    pub base: String,
    /// Steps in presentation order.
    pub steps: Vec<DebriefStep>,
    /// First-written time, epoch seconds. Preserved across regenerations.
    pub created_at: i64,
    /// Last-written time, epoch seconds.
    pub updated_at: i64,
}

/// The stdin payload accepted by `stage self-review set`.
///
/// `{ "base": "main", "steps": [{ "file": "...", "intro": "md", "order": 0 }] }`
/// — `order` is optional; when omitted it defaults to the array index.
#[derive(Debug, Clone, Deserialize)]
pub struct DebriefInput {
    pub base: String,
    pub steps: Vec<DebriefStepInput>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DebriefStepInput {
    pub file: String,
    pub intro: String,
    #[serde(default)]
    pub order: Option<u32>,
}

impl DebriefInput {
    /// Resolve the input into concrete steps, defaulting each missing `order`
    /// to its position in the array.
    pub fn into_steps(self) -> Vec<DebriefStep> {
        self.steps
            .into_iter()
            .enumerate()
            .map(|(i, s)| DebriefStep {
                file: s.file,
                intro: s.intro,
                order: s.order.unwrap_or(i as u32),
            })
            .collect()
    }
}

/// Lifecycle of a [`ReviewNote`]: `open` (author left it) → `addressed` (agent
/// replied) → `resolved` (author closed it, terminal). An author reply on an
/// addressed note re-raises it to `open`; the author may also reopen explicitly
/// (ADR-0012).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
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

/// Where a [`ReviewNote`] is anchored in the diff: a file path, optionally a
/// line range on a given [`Side`]. Anchored to the *diff location*, not a
/// Debrief step, so it survives the agent regenerating the Debrief. A note may
/// have no anchor at all (general feedback) — see [`ReviewNote::anchor`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteAnchor {
    pub file: String,
    #[serde(default)]
    pub line_start: Option<u32>,
    #[serde(default)]
    pub line_end: Option<u32>,
    /// Which diff side the line range targets; `None` for a file-level anchor.
    #[serde(default)]
    pub side: Option<Side>,
}

/// Who authored a thread entry on a [`ReviewNote`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
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

/// A follow-up entry on a [`ReviewNote`]'s thread, after the opening `body`.
/// Either party can append: an agent reply marks the note `addressed`; an
/// author reply on an addressed note re-raises it to `open` (see ADR-0012).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteReply {
    /// App-minted UUID.
    pub id: String,
    pub author: ReplyAuthor,
    pub body: String,
    pub created_at: i64,
}

/// The author's annotation on a diff location, made during Self-Review. A
/// threaded conversation: the opening author `body` plus `replies` from either
/// party. The agent reads outstanding notes, revises, and replies — closing the
/// local author↔agent loop (ADR-0012).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewNote {
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
    pub created_at: i64,
    pub updated_at: i64,
}

impl ReviewNote {
    /// Pair the note with a computed `outdated` flag for emission.
    pub fn into_view(self, outdated: bool) -> ReviewNoteView {
        ReviewNoteView {
            outdated,
            note: self,
        }
    }
}

/// A [`ReviewNote`] plus its computed `outdated` flag. `outdated` is never
/// stored — it's derived from whether the note's anchor still matches the
/// current Base diff: file gone, or (line-anchored) its line range on its side
/// is gone. Anchorless notes are never outdated. The **Stale step** pattern,
/// at line granularity (ADR-0012); see [`crate::diff::DiffLineIndex`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewNoteView {
    #[serde(flatten)]
    pub note: ReviewNote,
    pub outdated: bool,
}
