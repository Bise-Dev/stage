# Stage

A local-first tool for human-tailored pull request review. Authors craft a guided walkthrough ("storyline") over their own branch; reviewers follow that walkthrough and leave comments. GitHub remains the backend of record; Stage only stores what git and GitHub cannot.

## Design criteria

1. **Human-tailored review** — humans always have the last word. Stage assists; it does not auto-decide.
2. **Local-first** — the user works against local state (local git, locally cached backend data); network is for sync, not for the core flow.
3. **GitHub-compatible, no duplication** — Stage stores only what GitHub and git cannot already represent (storyline, per-step intros). Review state (comments, approvals, request-changes) is synced through to GitHub so a non-Stage reviewer can use the PR normally.

## Topology

Three entities, with a strict communication shape:

```
Local Client  ⇄  Stage Backend  ⇄  GitHub
```

- The Local Client never talks to GitHub directly. Its only network peer is the Stage Backend.
- The Local Client has **no GitHub credentials**. GitHub OAuth tokens are held exclusively by the Stage Backend; the client authenticates only to the Stage Backend (with a Stage session token).
- All non-git data the client needs comes from one of two sources: local git operations, or the Stage Backend API (which aggregates Stage-owned data with GitHub data brokered on the user's behalf).
- The Stage Backend owns the storyline and any other Stage-native data; it brokers everything else from GitHub.
- Review actions (comments, approve, request changes) are **write-through** today: the client posts to the backend, which writes them as native GitHub review activity in the same request cycle. GitHub is the source of truth for review state, and Stage does not own a Comment entity. Moving to a local-first sync model is a roadmap goal (see `docs/ROADMAP.md`), not part of the POC.

## Language

**Workspace**:
A Stage-owned object that sits on top of a local branch and holds the information about that branch's review that does not belong in git or GitHub — primarily the storyline. Identified by a Stage-generated UUID; `(repo, branch)` is a unique but mutable lookup index. Created eagerly the moment the author decides to make their in-progress review shareable (a Self-Review on its own does not need a Workspace). Optionally linked to a GitHub PR via a `pr_number` field; the Workspace's identity does **not** shift to the PR, and it outlives the PR being merged or closed.
_Avoid_: Review session, branch context, PR draft.

**Workspace title**:
The author's human-readable label for a Workspace, entered at **Ready to share** (when the Workspace is created) and stored on the Workspace. Independent of the GitHub PR title — it does **not** auto-sync after Publish. Distinct from the branch (`head_ref`), which is the machine identifier; the title is the human one.
_Avoid_: "name" (that's the branch), "PR title".

**Storyline**:
The author's chosen narrative for how a reviewer should walk through the change — an ordered sequence of steps, each pointing at part of the diff and optionally carrying an introductory note from the author.
_Avoid_: Tour, walkthrough, guide.

**Self-Review**:
An iterative, author-only stage in which the author inspects their own evolving diff to gain an improved overview of their current changes and guide further implementation work (with or without an agent). It lives as long as the author keeps editing the branch and ends when they are happy with the change. Distinct from the Storyline: a Self-Review is a working aid for the author; a Storyline is the artifact handed to reviewers. By default Self-Review compares the working tree against `HEAD` (uncommitted only); the author can toggle to a branch-vs-default-branch view that includes committed work. **Does not require Stage authentication** — the client can operate fully local-only during Self-Review; the device-flow login is triggered the first time the author hits "Ready to share".
_Avoid_: Local review, pre-flight, draft review.

**Ready to share** (state, gesture):
The author's explicit "I'm done iterating, now let me prepare what reviewers will see" decision. **Creates the Workspace in the backend** — Self-Review has no Workspace; this gesture is what makes one. After this, the author is in storyline composition.
_Avoid_: "share" (overloaded), "publish" (that's the next step).

**Ready to publish** (state, computed):
The condition that gates the "Open PR" / "Push update" action: the Storyline has ≥1 step and every step has a non-empty intro. **Computed**, never stored — the moment the last intro is written, the workspace is ready-to-publish.
_Avoid_: "complete", "done".

**Workspace state** (derived, never stored):
The single status shown per Workspace, computed from two owners. Pre-publish (no PR): **Draft** (Storyline not yet Ready-to-publish) or **Ready to publish**. Published (PR open): the GitHub review decision — **In review** (no decision yet), **Changes requested**, or **Approved**. PR closed/merged: **Frozen**. "Reviewing" is **not** a state — it describes your role/column, not the Workspace.
_Avoid_: storing it; using "Ready to share" as a state (that's the creation gesture).

**Publish** (verb):
The action that opens or updates the github PR for this workspace. **Publish means PR creation, not branch push** — the branch must already exist on github before the Workspace was created (precondition for Ready-to-share). First publish creates the github PR (sets `pr_number` on the Workspace). Subsequent publishes push new review activity (storyline edits and any pending comments) against the same PR. Repeating publish is the normal lifecycle — the workspace is reusable across publish cycles.
_Avoid_: "submit" (used inside publish for the github Review event), "send", "push" (overloaded with branch push, which is a separate, pre-Workspace action).

**Workspace lifetime**:
A Workspace outlives the github PR it points to. PR close / merge does not delete the Workspace — reads stay available and the author can resume Self-Review on the same branch, edit the Storyline, and re-publish (re-opening a PR if needed). There is **no archive concept**: mutability follows the github PR state strictly (closed PR → frozen workspace; reopened PR → thawed). See `docs/design.md` § 8.

**Comment** (POC stance — no backend entity):
For the POC, Stage backend does **not** store a Comment entity. Pre-publish drafts are a Local Client concern; the client posts to the backend, which writes through to github in the same request cycle. The local-first offline-drafts sync model is a roadmap goal, not POC scope. See `docs/adr/0003-write-through-comments-poc.md`.

**IntroComment** (still backend-native):
Discussions on Storyline intros remain a backend entity — github has no equivalent surface.

**Stale step**:
A Storyline step whose `diff_file_path` no longer matches the current PR head (file removed, renamed, or never existed in the new diff). Detected by the backend on storyline read; surfaced as a flag per step. Backend never auto-fixes; the author edits the storyline to resolve.
_Avoid_: "broken step", "outdated step" (we use "stale" consistently).

**Frozen workspace**:
A workspace whose github PR is closed or merged. All write endpoints (storyline edit, IntroComment post, github review submission) reject with `409 workspace_frozen`. Reads still work. Re-opening the PR thaws the workspace. There is no manual archive concept; mutability follows the PR's github state strictly.
_Avoid_: "archived" (no such notion in v1).

**Decisions document** (future):
A planned export of a frozen workspace into a single self-contained artifact (markdown / structured) capturing the storyline + intros + IntroComments + the github review activity. Out of POC scope, but the immutability rule above guarantees the export is deterministic.

**Workspace-anchored** vs **PR-anchored** endpoints:
The Stage backend exposes two parallel API surfaces. *Workspace-anchored* endpoints (URL contains `/workspaces/{uuid}/...`) require a Workspace to exist; they serve storyline + IntroComments. *PR-anchored* endpoints (URL contains `/repos/{owner}/{repo}/pulls/{number}/...`) require only a github PR; they pure-passthrough to github. A reviewer whose author did not use Stage uses only PR-anchored endpoints — Stage degrades to a thin review wrapper rather than refusing service.

**Import** (deliberately absent):
There is no manual "import this PR into Stage" action. A Workspace is created by the author via "Ready to share". When a reviewer encounters a PR with no Workspace, they review through PR-anchored endpoints; they do not create a Workspace on the author's behalf.
