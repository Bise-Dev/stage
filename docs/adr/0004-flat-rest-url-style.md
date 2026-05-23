# ADR-0004 · Flat REST URL style for the Stage backend

**Status:** accepted
**Date:** 2026-05-23

## Context

The Stage backend forks `brunovollmer/Django-Starter`, whose canonical ADR (`backend/docs/adr/0001-architecture-and-styleguide-baseline.md`) enforces a HackSoft-style "one `APIView` subclass per HTTP operation" rule. In that style, every verb gets its own URL segment:

```
GET    /items/                       # ItemListApi
POST   /items/create/                # ItemCreateApi
GET    /items/{id}/                  # ItemDetailApi
PATCH  /items/{id}/update/           # ItemUpdateApi
POST   /items/{id}/archive/          # ItemArchiveApi
DELETE /items/{id}/delete/           # ItemDeleteApi
```

This works well for the boilerplate's reference `Item` app but collides with our context:

1. The published canonical contract (`docs/api.md`, merged before backend implementation began) used flat REST URLs (`POST /workspaces/`, `PATCH /workspaces/<uuid>/`) — the shape client developers and reviewers committed to.
2. During the T11 execution (Workspace CRUD APIs), the subagent emitted both per-verb and flat URLs simultaneously, producing dead code (`WorkspaceCreateApi`, `WorkspaceUpdateApi` were unreachable because tests hit the flat URLs). The cleanup commit `656eec2` removed the dead views.

## Decision

For the Stage backend, **adopt flat REST routing** as the URL style. Specifically:

- **Collections**: `GET` (list) and `POST` (create) share the same URL on a single `APIView` subclass with `get` and `post` methods.
  - `GET  /api/v1/workspaces/` — list
  - `POST /api/v1/workspaces/` — create
- **Resources**: `GET` (detail) and `PATCH` (update) share the same URL on a single `APIView` with `get` and `patch` methods.
  - `GET   /api/v1/workspaces/<uuid>/` — detail
  - `PATCH /api/v1/workspaces/<uuid>/` — update
- **Distinct write semantics on a resource get distinct sub-paths**, each handled by its own single-method `APIView`:
  - `POST /api/v1/intro-comments/<uuid>/delete/` (soft delete)
  - `POST /api/v1/intro-comments/<uuid>/resolve/` (resolve thread)
  - `POST /api/v1/intro-comments/<uuid>/unresolve/`
  - `POST /api/v1/workspaces/<uuid>/open-pr/`
  - `POST /api/v1/workspaces/<uuid>/reopen-pr/`
  - `POST /api/v1/repos/<o>/<r>/pulls/<n>/actions/<action>/`

The rule of thumb: if two operations on the same resource are *interchangeable from the URL's perspective* (REST verbs distinguish them), they share a URL. If two operations are semantically distinct *actions* (a soft delete is not "an update with deleted=True"; resolve / unresolve are state transitions, not generic mutations), each gets its own action-named sub-path.

## Considered alternatives

- **Strict per-verb (boilerplate style)**. Rejected because:
  - The canonical contract was already published in `docs/api.md` using flat URLs; flipping the contract late in the cycle would invalidate work in flight on the client.
  - REST has a 25-year norm of "POST on a collection creates; PATCH on a resource updates"; following the styleguide here would surprise every external reviewer of the API.
  - HackSoft itself describes the "one APIView per operation" rule as an *internal* code-organization heuristic, not a public-URL prescription. Splitting an APIView is cheap inside the codebase; splitting URLs is a contract change.

- **Flat URLs *and* per-verb URLs both routed to the same handler** (route aliases). Rejected because it doubles the surface that has to stay consistent, with no benefit.

## Consequences

- We deviate from the boilerplate styleguide on URL shape. Inside the code, we retain its preference for thin views — but a single APIView class may now expose two methods (e.g. `WorkspaceListApi.get` + `.post`).
- Action sub-paths (`/delete/`, `/resolve/`, `/open-pr/`) are kept *because they carry semantic meaning*, not because of styleguide pressure. They aid contract readability.
- Future contributors writing new Stage endpoints should follow flat REST by default; they can fork into action sub-paths when an operation has a name worth keeping in the URL.
- `docs/api.md` and `docs/data-model.md` were reconciled with this style in the T24 commit (`7fa4e96`).
