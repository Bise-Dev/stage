//! Debrief domain types — see `CONTEXT.md` (**Debrief**) and ADR-0011.
//!
//! Timestamps are epoch **seconds** (UTC) to match the client's existing
//! convention (`git.rs::BranchInfo.updated_at`); the webview does the
//! formatting.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One step of a [`Debrief`]: an agent-authored intro anchored to a single
/// file in the Base-scope diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Debrief {
    /// Base branch the diff was composed against (e.g. `"main"`).
    pub base: String,
    /// Steps in presentation order.
    pub steps: Vec<DebriefStep>,
    // `i64` epoch seconds cross the JSON IPC boundary as a JS `number`, so the
    // generated TS must say `number` (ts-rs defaults 64-bit ints to `bigint`).
    /// First-written time, epoch seconds. Preserved across regenerations.
    #[ts(type = "number")]
    pub created_at: i64,
    /// Last-written time, epoch seconds.
    #[ts(type = "number")]
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
