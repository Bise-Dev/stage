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
/// revised and replied) → `resolved` (author closed it). The author may reopen
/// an addressed note back to `open`.
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

/// Where a [`ReviewNote`] is anchored in the diff: a file path, optionally a
/// line range. Anchored to the *diff location*, not a Debrief step, so it
/// survives the agent regenerating the Debrief.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteAnchor {
    pub file: String,
    #[serde(default)]
    pub line_start: Option<u32>,
    #[serde(default)]
    pub line_end: Option<u32>,
}

/// A piece of the author's feedback on a Debrief. The agent reads outstanding
/// notes, revises, and replies — closing the local author↔agent loop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewNote {
    /// App-minted UUID.
    pub id: String,
    pub anchor: NoteAnchor,
    /// The author's note text.
    pub body: String,
    pub status: NoteStatus,
    /// The agent's reply, set when it moves the note to `addressed`.
    pub agent_reply: Option<String>,
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
/// stored — it's derived from whether the note's anchored file is still in the
/// current Base diff (the **Stale step** pattern, at file granularity).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewNoteView {
    #[serde(flatten)]
    pub note: ReviewNote,
    pub outdated: bool,
}
