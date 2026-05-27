# Not implemented (client UI)

Central catalog of UI surfaces that are **shipped as visible-but-unbacked** or **deliberately omitted**, so the gap between the design prototype and the live client is explicit and reviewable in one place.

Two distinct categories:

- **Deferred** — the design intends it, but there's no backend/git command yet. Rendered so the screen reads complete; wired later.
- **By design** — deliberately *not* built because a documented decision (usually `CONTEXT.md`) rules it out. These are not "todo"; they should stay absent.

---

## Workspaces screen (`client/src/screens/workspaces/`)

Implements the design's "1 · Workspaces" (`screens-v2-workspaces.jsx`). Decisions from the grill session on 2026-05-27.

### Data sourcing

| Bucket | Source today | Status |
| --- | --- | --- |
| **Self-Review** (branch, no workspace) | — | **Deferred** — needs a Rust command to enumerate local branches with diff stats. Rendered from the typed stub in `data.ts`. |
| **Ready to share** (workspace, no PR) | — | **Deferred** — needs a backend `workspace_list` call scoped to the active repo. Stubbed. |
| **In review** (workspace + PR) | — | **Deferred** — same backend dependency as above. Stubbed. |
| **Open PRs** (PR, no workspace) | `githubPrs(role)` | **Live** — the only bucket wired to real data. |

Because no workspace-listing backend exists, **every real GitHub PR returned by `githubPrs` lands in the "Open PRs" bucket** (no workspace can be associated yet). The Self-Review / Ready-to-share / In-review buckets are populated only by stub data and will be empty against a real account until the backend lands.

Row fields with **no live source** (shown for stub rows only; blank/omitted for live PRs): diff stats (`+added / −removed`), `ahead/behind`, storyline step count, comment count, CI check status, reviewer avatars.

### Actions — visible and clickable, but no-op

Per the grill, unbuilt controls render enabled and log on click rather than being hidden or disabled:

| Control | Intended behavior | Why no-op |
| --- | --- | --- |
| **Fetch** (toolbar) | `git fetch` on the active repo | No fetch command; git access is read-only today (see `STACK.md` → "Git access: fetch later"). |
| **New workspace** (toolbar) | The "Ready to share" gesture — create a workspace for the current branch | No backend `workspace_create`; gesture also depends on screens not yet built. |
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
