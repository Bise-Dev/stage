//! Derived review status vocabulary (WS-5 #63) — shared by the unified
//! overview ([`crate::overview`]) and anything else that names a Review's
//! state. Everything here is **computed from real state** (a local draft, the
//! PR's `state`, its `reviewDecision`) and **never stored**: there is no manual
//! "archive", and reopening a PR restores the active status automatically.

use serde::Serialize;
use ts_rs::TS;

use crate::github::GhPullRequest;

/// The derived status of a Review (WS-5 #63). Pre-publish: [`Draft`] or
/// [`ReadyToPublish`] (CONTEXT.md *Review status*). Published: the PR's GitHub
/// state / review decision.
///
/// [`Draft`]: ReviewStatus::Draft
/// [`ReadyToPublish`]: ReviewStatus::ReadyToPublish
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ReviewStatus {
    /// A pre-publish local draft (Ready-to-share); no PR exists yet.
    Draft,
    /// A pre-publish draft whose storyline gates green (PUB-2 #73): ≥1 step,
    /// every step with an intro — "the moment the last intro is written"
    /// (CONTEXT.md *Ready to publish*). Computed, never stored.
    ReadyToPublish,
    /// PR open, no review decision yet.
    Open,
    /// PR open, a reviewer approved.
    Approved,
    /// PR open, a reviewer requested changes.
    ChangesRequested,
    /// PR merged.
    Merged,
    /// PR closed without merging.
    Closed,
}

/// Whether an entry is mine or waiting on my review (DB-1 #84 / DB-3 #86).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ReviewRole {
    /// I opened it (or it's my local draft/branch).
    Author,
    /// My review was requested — surfaced even if the author skipped Stage (DB-3).
    Reviewer,
}

/// The at-a-glance signal for a row (DB-2 #85): diff size + comment volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewSignal {
    pub added: u32,
    pub removed: u32,
    pub comments: u32,
}

/// Derive a PR's status (WS-5) from gh's `state` + `reviewDecision`. Merged/closed
/// win over any review decision; an open PR reflects its decision, else `Open`.
pub(crate) fn status_from_pr(pr: &GhPullRequest) -> ReviewStatus {
    match pr.state.as_str() {
        "MERGED" => ReviewStatus::Merged,
        "CLOSED" => ReviewStatus::Closed,
        // "OPEN" (and any unexpected state): reflect the review decision.
        _ => match pr.review_decision.as_str() {
            "APPROVED" => ReviewStatus::Approved,
            "CHANGES_REQUESTED" => ReviewStatus::ChangesRequested,
            // "" (none) or "REVIEW_REQUIRED": open, awaiting a verdict.
            _ => ReviewStatus::Open,
        },
    }
}

/// A closed/merged PR is archived (DB-5) — derived from status, never stored.
pub(crate) fn is_archived(status: ReviewStatus) -> bool {
    matches!(status, ReviewStatus::Merged | ReviewStatus::Closed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_derivation_covers_each_state() {
        let mk = |state: &str, decision: &str| GhPullRequest {
            number: 1,
            title: "t".into(),
            state: state.into(),
            url: "u".into(),
            head_ref_name: "b".into(),
            base_ref_name: "main".into(),
            is_draft: false,
            additions: 0,
            deletions: 0,
            review_decision: decision.into(),
            author: crate::github::GhAuthor { login: "me".into() },
            comments: 0,
            updated_at: String::new(),
        };
        assert_eq!(status_from_pr(&mk("MERGED", "")), ReviewStatus::Merged);
        assert_eq!(status_from_pr(&mk("CLOSED", "")), ReviewStatus::Closed);
        assert_eq!(
            status_from_pr(&mk("OPEN", "APPROVED")),
            ReviewStatus::Approved
        );
        assert_eq!(
            status_from_pr(&mk("OPEN", "CHANGES_REQUESTED")),
            ReviewStatus::ChangesRequested
        );
        assert_eq!(
            status_from_pr(&mk("OPEN", "REVIEW_REQUIRED")),
            ReviewStatus::Open
        );
        assert_eq!(status_from_pr(&mk("OPEN", "")), ReviewStatus::Open);
        // Merged/closed win even if a decision is present.
        assert_eq!(
            status_from_pr(&mk("MERGED", "APPROVED")),
            ReviewStatus::Merged
        );

        assert!(is_archived(ReviewStatus::Merged));
        assert!(is_archived(ReviewStatus::Closed));
        assert!(!is_archived(ReviewStatus::Approved));
        assert!(!is_archived(ReviewStatus::Draft));
        assert!(!is_archived(ReviewStatus::ReadyToPublish));
    }
}
