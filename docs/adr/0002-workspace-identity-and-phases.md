# ADR-0002 · Workspace identity is a UUID; lifecycle phases are computed

**Status:** accepted
**Date:** 2026-05-23

## Context

A **Workspace** is the backend's container for everything an author and reviewers work on around one body of changes. Naming the identity is non-trivial: a Workspace exists *before* a github PR is opened (during Self-Review / Ready-to-share) and *outlives* the PR being closed or merged. Using `(repo, pr_number)` would only identify it during the published portion of its life.

## Decision

A Workspace is identified by a backend-minted `uuid4`. The github `pr_number` is a nullable field, not part of the identity.

The Workspace passes through several **descriptive** phases — not enum values, but *computed* states derived from the workspace row + the github PR state on read:

- **ready-to-share** — `pr_number IS NULL`, storyline incomplete.
- **ready-to-publish** — `pr_number IS NULL`, storyline complete (≥1 step, every intro non-empty).
- **published** — `pr_number IS NOT NULL`, github PR is open.
- **closed / merged** — `pr_number IS NOT NULL`, github PR is closed (the **archived** state — see ADR-0019 and CONTEXT.md).

Self-Review is a *client-side only* state and never reaches the backend; the Workspace is created at the "Ready to share" gesture.

## Considered alternatives

- **PR-scoped (`(repo, pr_number)`)** — original v1/v2 spec. Rejected because the storyline-composition state would have to live entirely client-side, lost on a cache clear, and "Open PR" would become a creation step instead of a state transition on an existing row.
- **Two-entity (`DraftWorkspace` → `Workspace` on Open-PR)** — explicit transition with two tables. Rejected because the data is shape-identical in both phases; one mutable row is simpler.
- **Stored phase enum (`local | public | frozen | archived`)** — initially proposed during grilling. Rejected because the source of truth is github's PR state; computing the phase on read keeps the backend free of drift bugs and removes a write surface.

## Consequences

- `Workspace.id` is a UUID; all FKs to Workspace use UUID.
- Uniqueness is split: `(repo_owner, repo_name, head_ref)` unconditional; `(repo_owner, repo_name, pr_number)` conditional on `pr_number IS NOT NULL`.
- `POST /api/v1/workspaces/<uuid>/open-pr/` **mutates** the existing row (sets `pr_number` + `pr_opened_at`) rather than creating one.
- "Workspace frozen" is computed on every write inside the workspace surface (one github `GET /pulls/{n}` per write — accepted POC cost; cache is on the roadmap).
- Authz keys on `workspace.created_by_id` (creator identity), which is stable across all phases.
- The Workspace outlives PR close/merge — clients can still read the storyline, intro comments, and review activity; writes return `409 workspace_frozen`. Reopening the PR on github thaws the workspace automatically.
