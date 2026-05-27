# Not implemented (client UI)

Central catalog of UI surfaces that are **shipped as visible-but-unbacked** or **deliberately omitted**, so the gap between the design prototype and the live client is explicit and reviewable in one place.

Two distinct categories:

- **Deferred** — the design intends it, but there's no backend/git command yet. Rendered so the screen reads complete; wired later.
- **By design** — deliberately *not* built because a documented decision (usually `CONTEXT.md`) rules it out. These are not "todo"; they should stay absent.

---

## Workspaces screen (`client/src/screens/workspaces/`)

Implements the design's "1 · Workspaces" (`screens-v2-workspaces.jsx`). Decisions from the grill session on 2026-05-27.

### Data sourcing — all live

Every bucket is now backed by real data:

| Bucket | Source | Notes |
| --- | --- | --- |
| **Self-Review** (branch, no workspace) | `gitLocalBranches` + `gitDiffStats` | All local branches (name, current-HEAD marker, last-commit summary/time, `+/−` vs the default branch), most-recent first, refreshed on `repo-changed`. |
| **Ready to share** (workspace, no PR) | repo-overview aggregator + `gitDiffStats` | Pre-publish workspaces. State (Draft / Ready-to-publish) and storyline count are Stage-computed; `+/−` from a local diff of head vs base. |
| **In review** (workspace + PR) | repo-overview aggregator | Published workspaces. State (In review / Changes requested / Approved / Frozen) from the PR review decision; `+/−` and comment count from the PR; split into your column vs the review column by `created_by`. |
| **Open PRs** (PR, no workspace) | repo-overview aggregator | PRs you author/review with no workspace (`author`/`reviewer` role); branch + `+/−` from the PR. |

The overview is one repo-scoped call (`repo_overview`, see `docs/adr/0009`) that merges Stage workspaces with GitHub PR data server-side. Local branches stay client-side.

### Still pending (smaller follow-ups)

- **`Workspace.title` capture UI** — the field exists and is rendered, but nothing sets it yet (the "New workspace" / Ready-to-share flow is unbuilt), so rows fall back to the branch name.
- **CI checks** — deliberately not surfaced (the compact row doesn't show them).
- **GraphQL batch fan-out** — the aggregator uses parallel REST per PR for now (see `docs/ROADMAP.md`).

### Actions — visible and clickable, but no-op

Per the grill, unbuilt controls render enabled and log on click rather than being hidden or disabled:

| Control | Intended behavior | Why no-op |
| --- | --- | --- |
| **New workspace** (toolbar) | The "Ready to share" gesture — create a workspace for the current branch | Backend `workspace_create` exists, but the title-capture + storyline-composition flow is unbuilt. |
| **Self-Review** (branch row) | Open the Self-Review screen for that branch | Self-Review screen not built. |
| **Review** (Open PR row) | Open the PR-anchored review surface | Storyline/review screens not built. |
| **+ / search / kind filters** | — | These **do** work: client-side filtering over whatever rows are rendered. Not stubbed. |

### Deliberately omitted (by design — keep absent)

| Design element | Why removed |
| --- | --- |
| **"Import PR"** toolbar button | `CONTEXT.md` → *"Import (deliberately absent): There is no manual 'import this PR into Stage' action."* |
| **"Start workspace"** CTA on Open PRs | `CONTEXT.md` → reviewers *"do not create a Workspace on the author's behalf."* Open PRs are read-only / PR-anchored. Replaced with "Review" / "Open on GitHub". |

### Terminology realignment

The design's **"Local review"** bucket label was dropped — it is a banned alias in `CONTEXT.md`'s **Self-Review** entry. The author-side buckets follow the glossary lifecycle: **Self-Review** (no workspace) → **Ready to share** (workspace, no PR) → **In review** (published PR). The design's chat-era model ("start a workspace, then review inside it") was superseded by the glossary's model (Self-Review needs no workspace; the workspace is born at "Ready to share").

---

## Other design screens (out of scope for this task)

The handoff bundle contains more screens, none built yet: **Branch graph** ("2 · Branch graph"), **Local review / Self-Review**, **Create PR** (order files + write intros), **Storyline review**, **Publish review**, **Settings**. Tracked here only so the bundle's full scope is visible; build order is a separate decision.
