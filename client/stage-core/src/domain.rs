//! Handoff domain types — see `CONTEXT.md` (**Handoff**) and ADR-0011.
//!
//! Timestamps are epoch **seconds** (UTC) to match the client's existing
//! convention (`git.rs::BranchInfo.updated_at`); the webview does the
//! formatting.

use serde::{Deserialize, Serialize};

/// One step of a [`Handoff`]: an agent-authored intro anchored to a single
/// file in the Base-scope diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffStep {
    /// Repo-relative path of a file present in the Base-scope diff.
    pub file: String,
    /// Agent-authored markdown explaining what the agent did to this file.
    pub intro: String,
    /// Presentation order, ascending. Defaulted to the array index on input.
    pub order: u32,
}

/// A stored Handoff: the agent's ordered, annotated account of its own
/// Base-scope changes, produced for the author to review locally.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    /// Base branch the diff was composed against (e.g. `"main"`).
    pub base: String,
    /// Steps in presentation order.
    pub steps: Vec<HandoffStep>,
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
pub struct HandoffInput {
    pub base: String,
    pub steps: Vec<HandoffStepInput>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HandoffStepInput {
    pub file: String,
    pub intro: String,
    #[serde(default)]
    pub order: Option<u32>,
}

impl HandoffInput {
    /// Resolve the input into concrete steps, defaulting each missing `order`
    /// to its position in the array.
    pub fn into_steps(self) -> Vec<HandoffStep> {
        self.steps
            .into_iter()
            .enumerate()
            .map(|(i, s)| HandoffStep {
                file: s.file,
                intro: s.intro,
                order: s.order.unwrap_or(i as u32),
            })
            .collect()
    }
}
