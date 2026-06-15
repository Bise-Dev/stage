# ADR-0020 · Workspace authorization model

**Status:** accepted
**Date:** 2026-06-15

## Context

The only privileged identity Stage stores is `Workspace.created_by` — there is no roles table, no per-repo permission mirror. Authorization is therefore **creator-centric** and **phase-qualified**: a workspace's accessibility changes as it moves through its lifecycle.

- **Pre-publish** (`pr_number IS NULL`) — a private draft. Work-in-progress that must not leak to other Stage users.
- **Published** (PR open) — public. The change is now a GitHub PR anyone with Stage access can review.
- **Archived** (PR closed/merged) — read-only. Reads stay available; every write is rejected.

This ADR records the access matrix (salvaged from the retired design / data-model reference docs, then re-verified against the code) so the rule lives with the decisions rather than in a drifting reference doc. The enforcement points are `backend/apps/workspaces/{apis,services,selectors}.py`.

## Decision

### Access matrix

| Action | Pre-publish (no PR) | Published (PR open) | Archived (PR closed/merged) |
|---|---|---|---|
| Create Workspace | any authed user | n/a | n/a |
| List Workspaces (`GET /workspaces/`) | own drafts only | own + any published | own + any closed/merged |
| Read Workspace (`GET /workspaces/{uuid}/`) | creator only — **404 to others** | any authed user | any authed user |
| PATCH Workspace metadata | creator only | rejected (`head_ref`/`base_ref` frozen once a PR exists) | rejected (`workspace_archived`) |
| Delete Workspace (`DELETE /workspaces/{uuid}/`) | creator only | rejected (`workspace_published`) | rejected (`workspace_published`) |
| Read Storyline (`GET .../storyline/`) | creator only — **404 to others** | any authed user | any authed user |
| Edit Storyline (`PUT .../storyline/`) | creator only | creator only | nobody (`workspace_archived`) |
| Post / reply IntroComment | creator only (`creator_only_pre_publish`) | any authed user | nobody (`workspace_archived`) |
| Edit IntroComment | comment author only (`not_owner`) | comment author only | nobody |
| Delete IntroComment (soft) | comment author only (`not_owner`) | comment author only | nobody |
| Resolve / unresolve thread | Workspace creator only (`not_creator`) | Workspace creator only | nobody |
| Open PR (`POST .../open-pr/`) | creator only (`creator_only`) | n/a (already open) | creator only (re-publish path) |
| Reopen PR (`POST .../reopen-pr/`) | n/a | n/a | creator only (`creator_only`) |
| PR-anchored writes (passthrough comments / reviews / PR actions) | n/a | any authed user | nobody |

IntroComment threads are depth-1: a reply may only target a root comment (`depth_exceeded` otherwise), and only root comments are resolvable (`only_roots_can_be_resolved`).

### 404, not 403, for pre-publish non-creator reads

A pre-publish workspace is private state the creator may not have shared with anyone yet. Returning `403` would leak its existence and let a stranger enumerate other users' draft work by guessing UUIDs. We return **`404`** instead — indistinguishable from "no such workspace." This applies to `GET /workspaces/{uuid}/` and `GET .../storyline/` (and the pre-publish IntroComment list) when the requester is not the creator.

### Error-code taxonomy

Domain failures raise `ApplicationError(message, extra={"code": ...}, status=...)`; the handler in `apps/core/exception_handlers.py` renders `{"message": ..., "extra": ...}`. Per CLAUDE.md the **message** is the human-facing sentence and **`extra["code"]`** is the stable machine handle the client branches on. The canonical codes, verified against the backend:

| Code | Status | Raised when |
|---|---|---|
| `workspace_archived` | 409 | any write to a workspace whose PR is closed/merged |
| `workspace_exists` | 409 | create collides with an existing `(repo, head_ref)` |
| `workspace_published` | 409 | delete attempted on a workspace that already has a PR |
| `etag_mismatch` | 409 | storyline `PUT` with a stale `If-Match` etag |
| `pr_already_open` | 409 | open-pr when a PR is already open for the head |
| `no_pr_to_reopen` | 409 | reopen-pr with no PR on the workspace |
| `creator_only` | 403 | non-creator attempts open-pr / reopen-pr / delete |
| `creator_only_pre_publish` | 403 | non-creator posts an IntroComment on a pre-publish workspace |
| `not_creator` | 403 | non-creator resolves/unresolves a thread |
| `not_owner` | 403 | non-author edits/deletes an IntroComment |
| `comment_deleted` | 409 | edit/reply on a soft-deleted comment |
| `depth_exceeded` | 400 | reply targets a non-root comment |
| `only_roots_can_be_resolved` | 400 | resolve targets a reply |
| `open_pr_failed` | 502 | GitHub rejected the PR open (e.g. 422 no commits) |
| `github_app_no_access` | 403 | the Stage GitHub App is not installed on the repo owner / repo |
| `github_installations_unavailable` | 502 | the GitHub installations check itself failed |

(Several call sites still pass the code as the bare `message`; migrate them to the `message` + `extra["code"]` shape when touched, per CLAUDE.md.)

## Consequences

- **Permissive published reads are a POC simplification.** Once a PR is open, *any* authenticated Stage user can read the workspace and write PR-anchored review activity. The intended end-state is "creator **or** GitHub reviewer/collaborator of the PR," which requires consulting GitHub's per-repo permission API — parked in `docs/ROADMAP.md`.
- The creator-centric model holds because the GitHub PR author equals the workspace creator by construction (only the creator can Open-PR), so Stage never needs to consult GitHub's author identity for authz.
- The 404-not-403 choice means a creator hitting their own workspace while signed in as the wrong account sees "not found," not "forbidden" — acceptable given the enumeration-prevention benefit.

## See also

- ADR-0002 — Workspace identity and computed phases (where the archived state comes from).
- ADR-0017 — the repo-access gate (`github_app_no_access`) that fronts the overview endpoint.
- CONTEXT.md — `Workspace state`, `Archived workspace`, `IntroComment`.
