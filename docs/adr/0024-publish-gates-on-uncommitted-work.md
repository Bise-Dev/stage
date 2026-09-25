# Publish gates on uncommitted work; Stage may author a commit-all as the chosen disposition

**Status:** accepted
**Date:** 2026-07-26

An early dogfooded publish shipped a code-less PR: the implementation existed only as staged, uncommitted working-tree changes, and `publish_review` happily made its scoped `.stage` commit, pushed, and opened a PR containing none of the actual change — with no warning anywhere. We decided Publish must not run silently over a dirty tree: the engine (`stage-core`) refuses to publish when the working tree differs from `HEAD` (staged, unstaged-tracked, or untracked non-ignored paths; Stage's own `.stage/<branch>/` writes excluded) unless the `PublishRequest` carries an explicit author-chosen **disposition** — **commit everything** (`git add -A` semantics, author-editable message pre-filled from the PR title), **publish without it**, or cancel.

The commit-all disposition is the one place Stage authors a commit of the author's code. Everywhere else Stage is strictly observe-only over the author's work (its only commits are scoped `.stage` commits; it never creates, checks out, or mutates worktrees) — this is a deliberate, narrowly-scoped exception, taken only on an explicit per-publish click, because the most common dirty-at-publish case *is* "the change is the uncommitted work" and sending the author away to a terminal mid-publish is the kind of friction that gets the warning dismissed instead of acted on.

## Considered options

- **Warn-only (UI banner, publish proceeds)** — rejected: the failure mode is silent-by-inattention, and CLAUDE.md's fail-loud rule treats a quietly wrong PR as worse than a stopped one.
- **Hard block until clean** — rejected: publishing with deliberate local-only scratch edits (debug prints, local config) is legitimate; the committed branch can be the complete change.
- **Silent auto-commit** — rejected outright: Stage committing author code without an explicit choice violates "humans always have the last word".
- **UI-only gate** — rejected: enforcement lives in Rust (`publish_review`) so no entry path (app, CLI, future callers) can publish a dirty tree without a disposition; the webview only renders the choice (ADR-0022 §7).

## Consequences

- After a commit-all disposition, the committed diff has changed, so readiness (including step staleness, which also gates Publish — see CONTEXT.md *Ready to publish*) is re-assessed **after** the commit; a step staled by the new commit fails the publish loudly rather than shipping junk.
- The disposition is per-publish and never remembered — there is no "always publish anyway" setting to rot.
