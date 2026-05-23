# Comments are write-through to github in the POC

**Status:** accepted

For the POC, Stage backend does **not** store a `DraftReview` / `DraftComment` / `Comment` entity. The Local Client holds the pre-publish draft queue; when the user submits, the client posts to a Stage backend endpoint that **immediately** writes through to github as native github review activity and returns the github response.

This matters because earlier spec versions (`docs/superpowers/specs/2026-05-23-local-review-backend-design-v2.md` §5.6 and the v2 plan tasks T19/T20/T22/T23) describe `DraftReview` and `DraftComment` tables with a `category` enum. A reader following the spec without context would build those tables and then have to remove them. This ADR is the explicit "we chose not to."

## Considered Options

- **Drafts persisted backend-side** (the v2 spec): backend stores drafts, `publish-all` reads them and creates a github review. Rejected for the POC because it duplicates state github can hold (a github "pending review" is the same idea natively), the `category` field never reaches github, and a non-Stage reviewer can't see the drafts anyway.
- **Github native pending review**: client calls `POST /reviews` with empty `event` to start a pending review on github, then `POST /reviews/{id}/comments` to attach drafts. Rejected for the POC for simplicity (one less concept) — but kept as a roadmap candidate.

## Consequences

- No `DraftReview` / `DraftComment` migrations; v2 plan T19/T20/T22/T23 deleted from POC scope.
- `IntroComment` is the only comment-shaped backend table (it has no github counterpart).
- The "publish-all" UX still works: the client batches its local draft queue and posts a single `POST /api/workspaces/{uuid}/review` call; the backend forwards as one github Review object.
- Switching to a local-first model with offline drafts is a roadmap migration that adds tables; existing endpoints would still work because the write-through endpoint stays.
