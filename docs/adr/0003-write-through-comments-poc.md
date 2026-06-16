# ADR-0003 · Comments are write-through to github in the POC

**Status:** accepted
**Date:** 2026-05-23

## Context

A natural design would have the Stage backend persist `DraftReview` / `DraftComment` tables so reviewers can compose an offline batch of comments before submitting. Earlier spec versions (preserved in git history) described exactly this — a `category` enum, draft tables, a `publish-all` endpoint that flushes them into a github review.

That design has a real cost in the POC: it duplicates state github already provides natively (github's own "pending review" works the same way), the `category` field never makes it onto github, and a non-Stage reviewer (the most common case for an open-source repo) sees none of it.

## Decision

For the POC, the Stage backend does **not** store a `DraftReview` / `DraftComment` / `Comment` entity. The Local Client holds the pre-publish draft queue. When the user submits, the client posts to a Stage backend endpoint that **immediately** writes through to github as native github review activity and returns the github response.

Concretely, the backend exposes these PR-anchored write endpoints (shapes live in the backend code; run `just generate-schema` for an OpenAPI dump):

- `POST /api/v1/repos/<o>/<r>/pulls/<n>/comments/create/` — single issue or review comment
- `POST /api/v1/repos/<o>/<r>/pulls/<n>/review/create/` — batched review submission (multiple comments at once)
- `POST /api/v1/repos/<o>/<r>/pulls/<n>/actions/<action>/` — PR state changes (close / reopen / toggle-draft / merge)

## Considered alternatives

- **Drafts persisted backend-side** (the v2 spec). Rejected for the POC because it duplicates state github holds natively, the `category` field never reaches github, and non-Stage reviewers can't see the drafts anyway.
- **Github native pending review** (`POST /reviews` w/ empty `event` → `POST /reviews/{id}/comments`). Rejected for the POC for simplicity (one less concept) — kept as a roadmap candidate.

## Consequences

- No `DraftReview` / `DraftComment` migrations; the corresponding v2 plan tasks were dropped from POC scope.
- `IntroComment` is the only comment-shaped backend table (it has no github counterpart and lives entirely Stage-side).
- The "publish-all" UX still works: the client batches its local draft queue and posts a single `POST /…/review/create/` call; the backend forwards as one github Review object.
- Switching to a local-first model with offline drafts is a roadmap migration that **adds** tables; existing endpoints still work because the write-through endpoint stays as the source of truth for "publish".
