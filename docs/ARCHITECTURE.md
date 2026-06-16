# Stage — Architecture map

Stage is a local-first tool for human-tailored pull-request review: authors craft a guided walkthrough ("storyline") over their own branch; reviewers follow it and comment. GitHub stays the backend of record; Stage stores only what git and GitHub can't.

This page is a **map**, not a spec — it carries no detail of its own. Each concern points to where the canonical answer lives:

- **Domain language** → [`CONTEXT.md`](../CONTEXT.md) (the glossary; the single source for what each term means).
- **Decisions & rationale** → [`docs/adr/`](./adr/) (one ADR per decision; the "why").
- **Forward goals** → [`docs/ROADMAP.md`](./ROADMAP.md) (what we're deliberately not building yet).
- **Persistence schema** → `backend/apps/*/models.py` + their migrations are the source of truth. There is no hand-maintained data-model doc.
- **REST contract** → the backend code *is* the contract: `backend/apps/*/apis.py` + `serializers/`. Run `just generate-schema` for an OpenAPI dump. There is no hand-maintained API doc.

## Topology

```
Local Client  ⇄  Stage Backend  ⇄  GitHub
```

The Local Client has **no GitHub credentials** and never talks to GitHub directly — its only network peer is the Stage Backend. The backend owns Stage-native data and **brokers** everything else from GitHub on the user's behalf. Full rationale: **ADR-0001**.

## What Stage stores

Only what git and GitHub cannot already represent:

- **Stage-native:** `Workspace`, `Storyline`, `StorylineFile`, `IntroComment`.
- **Auth:** `User`, `Session`, `GitHubIdentity` (per-user GitHub App tokens — see ADR-0007/0008).

Everything else — PR data, file diffs, GitHub comments/reviews, CI checks, branches, repos — is fetched from GitHub on demand and never mirrored.

## Decision map

| Concern | ADR |
|---|---|
| Three-tier topology (client ⇄ backend ⇄ GitHub) | 0001 |
| Workspace identity (UUID) + computed lifecycle phases | 0002 |
| Comments are write-through to GitHub (POC) | 0003 |
| Flat REST URL style | 0004 |
| Backend layering (services / selectors / apis) | 0005 |
| Local Client SDK shape (stateless, caller-owned loop) | 0006 |
| GitHub App user-to-server + loopback + PKCE auth | 0007 |
| GitHub as Stage's identity provider | 0008 |
| Repo-scoped overview aggregation endpoint | 0009 |
| Self-Review diff rendering stack | 0010 |
| Agent self-review (Debrief) is a local CLI, not backend | 0011 |
| Self-Review's one annotation concept: Review notes | 0012 |
| Client session persistence + local-only mode | 0013 |
| `stage open` — CLI launches the GUI into Self-Review | 0014 |
| Keyboard shortcuts + reload | 0015 |
| Git worktrees: observe-only, Repo keyed by common-dir | 0016 |
| Repo-access gate via GitHub App installation check | 0017 |
| Storyline diff is a committed tree↔tree diff | 0018 |
| Workspace creation does no GitHub work; Publish owns the push | 0019 |
| Workspace authorization model (matrix + error codes) | 0020 |
| (superseded by 0007) Client SDK device-flow vocabulary | 0021 |
