//! `stage-core` — the Tauri-independent core shared by the `stage` CLI and the
//! Stage desktop app: the local Debrief store, its domain types, the repo-key
//! derivation that locates a repo+branch's Debrief, and the credential-free
//! GitHub adapter ([`github`]).
//!
//! No Tauri — the CLI links this crate but never compiles Tauri, which is why
//! the core lives here. GitHub is reached by shelling out to the user's local
//! `gh`/`git` (ADR-0022 §5); Stage itself holds **no stored credential**.

pub mod base;
pub mod dashboard;
pub mod diff;
pub mod domain;
pub mod error;
pub mod github;
pub mod pr;
pub mod repo_key;
pub mod review_folder;
pub mod staleness;
pub mod store;
pub mod storyline;
pub mod worktree;

pub use base::{base_options, BaseOptions, LocalDefault};
pub use dashboard::{
    assemble_dashboard, DashboardRow, DashboardView, ReviewRole, ReviewSignal, ReviewStatus,
};
pub use diff::DiffLineIndex;
pub use domain::{
    Debrief, DebriefInput, DebriefStep, NoteAnchor, NoteReply, NoteStatus, ReplyAuthor, Review,
    SelfReviewNote, SelfReviewNoteView, Side,
};
pub use error::StageError;
pub use github::{GhAuthor, GhPullRequest, GitHub, GitHubUser, PrFilter};
pub use pr::{
    CheckResult, CheckStatus, DraftLineComment, IssueComment, LineComment, MergeMethod, PrActivity,
    ReviewSummary, SubmittedVerdict, Verdict,
};
pub use repo_key::{repo_key_from_cwd, repo_root_from_cwd, slug_from_remote, RepoKey};
pub use review_folder::{
    find_review, read_review_at, resync_folder, review_committed_for_branch, review_dir,
    scoped_commit, stage_root, write_review, ReviewMeta, ReviewStep, StageReview,
};
pub use staleness::{assess_step_staleness, StaleReason, StepStaleness};
pub use store::{default_store_path, Store, STORE_PATH_ENV};
pub use storyline::{
    add_step, assemble_preview, committed_diff_file_set, preview, StorylinePreview, StorylineStep,
    StorylineStepView,
};
pub use worktree::{list_worktrees, repo_common_dir, WorktreeInfo};
