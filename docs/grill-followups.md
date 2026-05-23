# Grill-with-docs follow-ups (post-AS-BUILT review, 2026-05-23)

Output of the grill session that reviewed the v0.1.0-poc-backend implementation against the consolidated design docs. Doc fixes landed in the same session (commits below this file's commit). Code fixes are tracked here and should be addressed in a single hardening pass before backend / client integration starts in earnest.

All items are scoped for the **2-developer MVP** (no production-grade hardening). Items that go beyond MVP scope are deferred to `docs/ROADMAP.md` and not listed here.

---

## Backend code follow-ups

### F1 — Authz tightening (Q6)

**Rationale:** Pre-publish workspaces are author-private; current code lets any authed user read / mutate them. `design.md` § 9 is the canonical authz matrix after this grill. See also Q13 for the IntroComment row.

- `apps/workspaces/selectors.py::workspace_list` — accept `user` param, filter `(created_by=user) OR (pr_number IS NOT NULL)`.
- `apps/workspaces/apis.py::WorkspaceListApi.get` — pass `request.user` to selector.
- `apps/workspaces/apis.py::WorkspaceDetailApi.get` — **404** (not 403) if `workspace.pr_number IS NULL AND request.user.pk != workspace.created_by_id`. 404 prevents UUID enumeration.
- `apps/workspaces/apis.py::StorylineDetailApi.get` — same 404 gate.
- `apps/workspaces/services.py::workspace_update_local_phase` — accept `user`, raise 403 if `user.pk != workspace.created_by_id`.
- `apps/workspaces/apis.py::WorkspaceDetailApi.patch` — pass `request.user`.
- Tests: each gate gets a positive + negative case; cross-user enumeration must 404.

### F2 — Idempotent `pull_request_open` (Q7)

**Rationale:** Current code can deadlock the workspace if `gateway.create_pull` succeeds but the subsequent `workspace.save()` fails — the github PR exists, the workspace `pr_number` is `NULL`, retries hit github's "PR already exists from this head" 422. See `services.py:198-209`.

- `apps/github_proxy/gateway.py` — new `list_open_pulls(repo_owner: str, repo_name: str, *, head: str) -> list[dict]` method (maps to `GET /repos/{owner}/{repo}/pulls?state=open&head={owner}:{head_ref}`).
- `apps/workspaces/services.py::pull_request_open` — before `create_pull`, look up by head_ref. If a PR exists, adopt it: `workspace.pr_number = existing["number"]; workspace.pr_opened_at = parse(existing["created_at"])`. Else proceed with create.
- Tests: fresh-create happy path, adopt-existing-PR path (idempotency), github 5xx mid-create.
- Note: not a transactional outbox — see `docs/ROADMAP.md` "Transactional outbox" entry for the proper end-state. This patch just plugs the only currently-known stuck-state.

### F3 — Drop `Storyline.raw_json` (Q8)

**Rationale:** Field is written but never read anywhere in the codebase. YAGNI; removes drift hazard between two storyline projections.

- Migration: `alter table workspaces_storyline drop column raw_json`.
- `apps/workspaces/models.py::Storyline` — remove `raw_json` field.
- `apps/workspaces/services.py::storyline_create` (~line 22) — remove `raw_json=json.dumps(...)`.
- `apps/workspaces/services.py::storyline_replace` (~lines 73, 76) — remove `s.raw_json = ...` and `"raw_json"` from `update_fields`.
- No test updates expected — no test asserts on `raw_json`.

### F4 — Drop dead `SESSION_TOKEN_TTL_DAYS` (Q12)

**Rationale:** Env var exists but has zero usages; design says sessions never auto-expire.

- `config/settings/env_schemas.py` — remove the `SESSION_TOKEN_TTL_DAYS: int = 30` line.
- Update any `.env.example` / docker-compose sample if it lists the var.

### F5 — Creator-only IntroComment writes pre-publish (Q13)

**Rationale:** Pre-publish IntroComments are first-class — the author's prep notes alongside the storyline they're composing — but only the workspace creator should be able to post them (the workspace is private at that phase). Code currently has no creator-gate at the service layer; the only barrier is the Q6 transitive read-gate, which is fragile.

- `apps/workspaces/services.py::intro_comment_create` — if `workspace.pr_number IS NULL AND user.pk != workspace.created_by_id` → `ApplicationError("creator_only_pre_publish", status=403)`.
- Intro-comment list/thread endpoint (whichever API path serves it) — apply the same gate.
- Tests: pre-publish creator can post; pre-publish non-creator gets 403; published any-authed-user can post (unchanged).

---

## Client-side follow-up (informational; not backend's enforcement)

### C1 — Drop "Continue with SSO" button (Q2)

**Rationale:** Backend supports only github device flow. SSO has no backend counterpart and is not on the roadmap. Keeping the button risks bait-and-switch UX.

- `client/src/screens/onboarding/SignIn.tsx` — remove the SSO button + its surrounding divider.
- Coordinate with client dev (Bruno) — backend grill cannot land this change.

---

## Out-of-scope (logged for completeness, **not** in this follow-up pass)

These were touched during the grill but explicitly deferred to roadmap items (see `docs/ROADMAP.md`):

- **Phase 2a — GitHub App installation token** (Q9): swap the admin PAT for a github App's installation token so actions appear as `stage-bot[bot]` rather than as a human admin. ~80 lines + one-time github App setup. Roadmap entry written.
- **Phase 2b — Per-user OAuth on-behalf-of** (Q9): full per-user attribution. Multi-week effort; ADR-required when undertaken.
- **Transactional outbox for github-coupled writes** (Q7 long-term): replaces F2's idempotent patch with a proper two-phase pattern. Roadmap entry written.

---

## Doc patches landed in this grill (for the reader)

- `CONTEXT.md` — Self-Review needs no Stage auth; Publish = PR-not-branch.
- `docs/design.md` — § 4 branch-vs-PR precondition explicit; § 7 client pre-auth posture (no `/health` ping); § 9 authz matrix phase-qualified; § 10 storyline no longer mentions raw_json; § 14 admin PAT migration plan (2a/2b).
- `docs/data-model.md` — `head_ref` semantics clarified (frozen on backend side post-publish, github not synced back); `raw_json` removed from `Storyline` table; authz section delegates to `design.md` § 9.
- `docs/api.md` — pre-publish `stale` always false, `head_sha` null.
- `docs/ROADMAP.md` — transactional outbox section; OAuth split into 2a + 2b.
