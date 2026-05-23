# Backend TODO

Open design questions that must be resolved before (or while) the backend gets built. None of these were resolved in the initial foundation-grilling pass — they were deliberately deferred to a "second step." A second person picking up the backend should treat this list as the first grilling agenda.

For high-level context first, read in this order:
1. `../CONTEXT.md` — glossary + design criteria + three-tier topology
2. `../docs/adr/0001-three-tier-topology.md` — why a separate backend exists
3. `../docs/ROADMAP.md` — write-through today, local-first sync as the goal
4. `../client/STACK.md` — what the client looks like and how it expects to talk to us

## Open design questions

### 1. Storyline / Step data model
A Storyline was defined as an ordered sequence of steps "each pointing at part of the diff." Unresolved: does a Step point at a file? a hunk? a line range? a commit? Can one Step span multiple files? This is the central new entity Stage owns; its shape is undefined.

### 2. Full Workspace shape
Locked so far: `id` (Stage-generated UUID), `repo`, `branch`, optional `pr_number`, and "the storyline." Unresolved: title/description authored separately from the PR? Author identity? Created-at timestamp? Lifecycle status (draft / published / archived)? Anything else?

### 3. API surface
No endpoints have been enumerated. `BackendClient` is referenced as a Tauri-command surface on the client side but never written down. The verb list is unknown — candidates include `CreateWorkspace`, `PublishStoryline`, `OpenPr`, `SubmitReview`, `AddLineComment`, etc.

### 4. GitHub-API mapping
"Write-through to GitHub" is the rule, but no mapping exists between Stage actions and GitHub endpoints. PR review comments, general PR comments, and review submissions are three different GitHub APIs with different shapes; each Stage action needs to be mapped to the right one. A table of "Stage action → GitHub API call" is the deliverable.

### 5. Auth flow
"Stage session token, stored in OS keychain on the client" is the only commitment. Unresolved: how is the token obtained — GitHub OAuth web flow at the backend, device flow for desktop, something else? Token lifecycle and refresh semantics? What happens when the GitHub OAuth grant is revoked?

### 6. Multi-user model
Unresolved: does Stage have a first-class `User` entity, or is a Stage user just a wrapper around a GitHub user? Org/team scoping? Permission model for who can see / edit a given Workspace?

### 7. Reviewer's view of someone else's Workspace
When a reviewer opens a Workspace authored by someone else, do they receive a *copy* of the storyline at review-start time, or navigate the author's *live* one? What happens when the author edits the storyline mid-review? This decision shapes both the data model and the sync story.

### 8. When does a Workspace get linked to a PR?
Unresolved: explicit "Create PR" action triggered from inside Stage, or auto-detect when the user pushes and a PR exists for the branch on GitHub? Both have implications for the backend's relationship with GitHub (write vs read; webhooks vs polling).

### 9. Sync mechanics
When github.com receives a new comment or review activity, how does Stage learn? Options: backend-hosted webhook endpoint, periodic polling, or only-on-page-open refresh. Each has different ops + hosting implications.

## Deliverables once the above are resolved

- Expand `../CONTEXT.md` with the resolved entities (Storyline, Step, Review, User).
- `docs/api.md` — enumerate endpoints + payload shapes (loose is fine at first).
- `docs/data-model.md` — Workspace, Storyline, Step, etc. as plain prose or type sketches.
- `docs/github-mapping.md` — Stage action → GitHub API call table.
- `docs/auth.md` — auth flow walkthrough.
- New ADRs for any irreversible decisions (e.g., webhook vs polling, OAuth flow type).
