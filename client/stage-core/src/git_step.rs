//! One git command a confirmed action will run, as the confirmation shows it.
//!
//! ADR-0027 requires every Stage-initiated git mutation to sit behind "an
//! explicit confirmation that lists the exact git commands". That listing is
//! the same object whatever the action is — a switch's stash/checkout/pop, a
//! push — so the type lives here rather than inside the first module that
//! needed it ([`crate::switch`], which owned it as `SwitchStep`).
//!
//! The webview renders these through one `GitStepList`, so a new action needs
//! a [`GitStepKind`] variant and its steps, not a second dialog.
//!
//! **These strings are display only.** Execution builds its own argv from the
//! plan's typed fields and never re-parses `command`, so a step can be quoted
//! for a human to read and copy without that quoting reaching a shell — there
//! is no shell in the path at all (see [`crate::git_cli`]).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What a planned git step does — drives the step-dot colour in the UI, and
/// nothing else. Kinds are named for the git verb, not for the action that
/// happens to use them: a `Push` step is a push whether it publishes a branch
/// or updates one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum GitStepKind {
    Stash,
    Checkout,
    Pop,
    Push,
}

/// One git command a plan will run, with the human note rendered above it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitStep {
    pub kind: GitStepKind,
    /// The command line, verbatim (display only — execution builds its own argv).
    pub command: String,
    /// Human note rendered above the command ("set aside 3 uncommitted files").
    pub note: String,
}

impl GitStep {
    /// Build a step. Keeps the two `String` allocations off every call site.
    pub fn new(kind: GitStepKind, command: impl Into<String>, note: impl Into<String>) -> Self {
        Self {
            kind,
            command: command.into(),
            note: note.into(),
        }
    }
}

/// The noun a count of `n` takes — `"file"` at 1, `"files"` otherwise.
///
/// Separate from [`plural`] because some notes put words between the number and
/// the noun ("set aside 2 uncommitted files"), so they need the agreement
/// without the count glued to it.
pub(crate) fn plural_noun<'a>(n: u32, singular: &'a str, plural: &'a str) -> &'a str {
    if n == 1 {
        singular
    } else {
        plural
    }
}

/// `"1 file"` / `"3 files"` — the count and its noun, agreeing.
pub(crate) fn plural(n: u32, singular: &str, plural: &str) -> String {
    format!("{n} {}", plural_noun(n, singular, plural))
}
