//! `stage-core` — the Tauri-independent core shared by the `stage` CLI and the
//! Stage desktop app: the local Debrief store, its domain types, and the
//! repo-key derivation that locates a repo+branch's Debrief.
//!
//! No Tauri, no network, no credentials — see ADR-0011. The CLI links this
//! crate but never compiles Tauri, which is why the core lives here.

pub mod diff;
pub mod domain;
pub mod error;
pub mod repo_key;
pub mod store;

pub use diff::DiffLineIndex;
pub use domain::{
    Debrief, DebriefInput, DebriefStep, NoteAnchor, NoteReply, NoteStatus, ReplyAuthor, ReviewNote,
    ReviewNoteView, Side,
};
pub use error::StageError;
pub use repo_key::{repo_key_from_cwd, repo_root_from_cwd, slug_from_remote, RepoKey};
pub use store::{default_store_path, Store, STORE_PATH_ENV};
