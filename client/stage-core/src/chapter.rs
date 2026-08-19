//! The **Chapter** — the storyline's narrative unit (ADR-0025, CONTEXT.md
//! "Chapter"): a titled, author-ordered group of changed files carrying **one**
//! intro. Files inside a chapter have no per-file title or intro.
//!
//! Deliberately neutral (not Debrief-specific): the Debrief adopts this shape
//! now (v6-light L1) and the Storyline adopts the same type when `.stage`
//! format v2 lands (full v6 step 3), so the Debrief can seed a Storyline 1:1.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A titled, ordered group of changed files with one markdown intro.
///
/// Order is positional: chapters are stored and emitted in presentation order,
/// and `files` is the author-/agent-chosen order within the chapter. No
/// numeric `order` field — a Chapter never exists outside its ordered list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Chapter {
    /// Human title of the narrative unit (e.g. "Core state").
    pub title: String,
    /// One markdown intro for the whole chapter — what changed and why.
    pub intro: String,
    /// Repo-relative paths of the files this chapter narrates, in
    /// presentation order. Paths use `/` separators (git's own convention).
    pub files: Vec<String>,
}
