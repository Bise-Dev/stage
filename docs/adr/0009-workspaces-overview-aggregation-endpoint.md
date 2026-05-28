# Repo-scoped aggregation endpoint for the Workspaces overview

Status: accepted

The Workspaces screen needs, per repo, a unified list of the user's Stage Workspaces and their Open PRs (open PRs with no Workspace), each row carrying both Stage-owned fields (title, storyline step count, computed pre-publish phase) and GitHub-derived fields (review decision → state, additions/deletions, review-comment count, merged/closed → Frozen). Because the Local Client holds no GitHub credentials and never talks to GitHub directly ([0001](./0001-three-tier-topology.md)), every GitHub-derived field must be brokered server-side. We add a **single repo-scoped aggregation endpoint** (e.g. `GET /api/v1/repos/{owner}/{repo}/overview/`) that reads Stage Workspaces from the DB, fans out to GitHub per PR to enrich them, also returns the user's Open PRs (distinguished via `workspaces_existing_for_prs`), and responds with one tagged-union shape (`{ kind: "workspace" | "open_pr", … }`). The client composes the screen from exactly two sources: local git (branches → Self-Review bucket) and this one call; local branch data never leaves the machine.

## Considered options

- **Client orchestration** (client calls `workspace_list` + GitHub search + per-PR detail and stitches) — rejected: the client can't call GitHub (it has no creds), so it would still be N backend round-trips, and the merge logic would live in two places.
- **Extend the DB-only `WorkspaceListApi`** — rejected: it is cross-repo, returns no Open PRs, and overloading a clean DB selector with GitHub fan-out muddles its responsibility.

## Consequences

- One network round-trip yields the whole GitHub-backed overview, at the cost of **N+1 GitHub calls server-side** per load (bounded by PR count; mitigated by parallel fan-out + a short-TTL cache keyed by `(user, repo)`).
- Fan-out uses the existing REST `GithubGateway`. **GraphQL batching** (one query for all PRs' `reviewDecision`/additions/deletions/comments) is the scaling follow-up — see `docs/ROADMAP.md`.
- CI checks are deliberately **excluded** from the payload — the compact workspace row does not display them.
- The unified tagged-union shape couples the client's row model to this endpoint; changing it is a coordinated client + backend change.
