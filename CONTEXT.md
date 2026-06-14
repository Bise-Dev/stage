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
An iterative, author-only stage in which the author inspects their own evolving diff to gain an improved overview of their current changes and guide further implementation work (with or without an agent). It lives as long as the author keeps editing the branch and ends when they are happy with the change. Distinct from the Storyline: a Self-Review is a working aid for the author; a Storyline is the artifact handed to reviewers. By default Self-Review compares the **selected worktree** against a **Base branch** (defaulting to the repo's remote default branch), showing the whole change: committed branch work plus any uncommitted edits. The author can toggle to an **Uncommitted** view (the working tree against `HEAD`) to isolate just the edits since the last commit. When a coding agent did the work, it can attach a **Debrief** within the Self-Review and read the author's **Review notes** back, forming a local author↔agent review loop. **Does not require Stage authentication** — the client can run in **Local-only mode** during Self-Review; the device-flow login is triggered the first time the author hits "Ready to share".
_Avoid_: Local review, pre-flight, draft review.

**Local-only mode** (app state):
The client running with **no Stage session** — local features only. This is the **auth axis**: Self-Review, Debrief, Review notes, the repo picker, and the branch toggle all work; anything that calls the backend (Workspaces overview, Ready to share, Publish) is disabled until the author signs in. Entered explicitly via **"Stay offline"** on the SignIn screen (or automatically when Self-Review is opened with no valid session). **Not sticky** — it means "not signed in *yet*", is never persisted, is re-evaluated every launch, and a successful sign-in upgrades it to signed-in in place. Distinct from the **connectivity axis** (network/backend unreachable) — that is *not* what this term means; local-only is about the absence of a session, not the absence of a network. Made legible by ADR-0013, which also persists the session token so a returning author skips sign-in.
_Avoid_: "offline mode" (conflates the auth and connectivity axes — local-only is purely the auth axis); "guest mode", "anonymous mode".

**Debrief**:
An agent-authored, local, author-facing narrative over the agent's own contributions — the same ordered-steps-over-the-diff shape as a Storyline, but produced by a coding agent for the **author** to review during Self-Review, not for external reviewers. Each step carries an **agent-authored intro** explaining what the agent did (the agent's own commentary on the change). Composed against the Base-scope diff (everything changed versus the base branch, committed or not). Lives only on the author's machine and requires no Stage authentication. When the author goes **Ready to share**, a Debrief can be **promoted** into a Storyline — carrying its ordered steps and intros across as the starting point, which the author then curates — or discarded in favour of a fresh one. Distinct from a Storyline by producer (agent, not author), audience (the author, not reviewers), storage (local, not backend), and lifecycle (regenerated by the agent across passes, not hand-curated).
_Avoid_: "Handoff" (the original name — collides with an agent's *conversation* handoff and the `handoff` skill; renamed to Debrief for that reason); "self-review storyline", "draft storyline" (a Debrief is its own artifact, not a phase of Storyline); "recap", "walkthrough".

**Review note**:
The author's annotation on a **diff location** (a file path, optionally a line range), made during Self-Review. Anchored to the diff rather than to a Debrief step — so it survives the agent regenerating the Debrief, and exists even when no Debrief or agent is involved at all (the author annotating their own diff). A note is a **threaded conversation**: the author's opening text plus follow-up replies from either the author or the agent. Its lifecycle is **open → addressed → resolved**: an agent reply marks it `addressed`; an author reply on an addressed note re-raises it to `open`; the author explicitly `resolved`s (terminal) or reopens. When a coding agent worked the branch, it reads outstanding Review notes back, revises its contributions, and replies — closing the local author↔agent loop; with no agent in the loop the note is simply the author's own annotation. The single annotation concept on a Self-Review diff — there is no separate ephemeral "comment". Local-only. Distinct from an **IntroComment** (backend-native, on Storyline intros) and from a github review **Comment**.
_Avoid_: "comment" (overloaded — the diff affordance creates a Review note, not a Comment), "feedback", "change request".

**Ready to share** (state, gesture):
The author's explicit "I'm done iterating, now let me prepare what reviewers will see" decision. **Creates the Workspace in the backend** — Self-Review has no Workspace; this gesture is what makes one. After this, the author is in storyline composition. **Implies a committed branch**: by reaching Ready to share the author has committed everything they intend to ship, so storyline composition works against the *settled committed branch diff* — reviewing still-uncommitted, working-tree changes is the earlier Self-Review phase's job, not the storyline's.
_Avoid_: "share" (overloaded), "publish" (that's the next step).

**Ready to publish** (state, computed):
The condition that gates the "Open PR" / "Push update" action: the Storyline has ≥1 step and every step has a non-empty intro. **Computed**, never stored — the moment the last intro is written, the workspace is ready-to-publish.
_Avoid_: "complete", "done".

**Workspace state** (derived, never stored):
The single status shown per Workspace, computed from two owners. Pre-publish (no PR): **Draft** (Storyline not yet Ready-to-publish) or **Ready to publish**. Published (PR open): the GitHub review decision — **In review** (no decision yet), **Changes requested**, or **Approved**. PR closed/merged: **Archived**. "Reviewing" is **not** a state — it describes your role/column, not the Workspace.
_Avoid_: storing it; using "Ready to share" as a state (that's the creation gesture).

**Publish** (verb):
The action that gets this workspace's branch + PR onto github. **There is no GitHub precondition at Workspace creation** — the author works fully locally (Self-Review → Ready-to-share → storyline composition) without ever pushing, and Publish is the single point where Stage touches github. First publish pushes the branch if github does not yet have it and creates the github PR (sets `pr_number` on the Workspace); a branch that cannot be pushed/opened surfaces github's error here (e.g. 422), never at create. Subsequent publishes push new review activity (storyline edits and any pending comments) against the same PR. Repeating publish is the normal lifecycle — the workspace is reusable across publish cycles.
_Avoid_: "submit" (used inside publish for the github Review event), "send".

**Workspace lifetime**:
A Workspace outlives the github PR it points to. PR close / merge does not delete the Workspace — reads stay available and the author can resume Self-Review on the same branch, edit the Storyline, and re-publish (re-opening a PR if needed). Archiving is **not** a manual action and is **never stored**: it follows the github PR state strictly (closed/merged PR → archived workspace; reopened PR → restored). See `docs/design.md` § 8.

**Comment** (POC stance — no backend entity):
For the POC, Stage backend does **not** store a Comment entity. Pre-publish drafts are a Local Client concern; the client posts to the backend, which writes through to github in the same request cycle. The local-first offline-drafts sync model is a roadmap goal, not POC scope. See `docs/adr/0003-write-through-comments-poc.md`.

**IntroComment** (still backend-native):
Discussions on Storyline intros remain a backend entity — github has no equivalent surface.

**Stale step**:
A Storyline step whose `diff_file_path` is no longer part of the change set the author is composing against (file removed, renamed, or never existed in that change set). One concept, two detection sites depending on lifecycle phase: **pre-publish** the client detects it against the **local branch diff** during storyline composition (no PR exists yet); **post-publish** the backend detects it against the **current PR head** on storyline read. Either way it is surfaced as a flag per step; nothing auto-fixes it — the author edits the storyline to resolve. The two detectors can disagree (the local diff and the eventual PR diff need not match — see *Publish*), which is expected: each reports staleness relative to the change set in view at that phase.
_Avoid_: "broken step", "outdated step", "orphaned step" (we use "stale" consistently for all detection sites).

**Archived workspace**:
A workspace whose github PR is closed or merged. All write endpoints (storyline edit, IntroComment post, github review submission) reject with `409 workspace_archived`. Reads still work. Re-opening the PR restores the workspace. Archiving is derived strictly from the PR's github state — there is no manual "archive" gesture and the state is never stored.
_Avoid_: "frozen" (former name for this state); implying a manual archive action or a stored flag (it's derived from the PR state). The default review list hides archived workspaces — that's a view filter, not a separate state.

**Decisions document** (future):
A planned export of an archived workspace into a single self-contained artifact (markdown / structured) capturing the storyline + intros + IntroComments + the github review activity. Out of POC scope, but the immutability rule above guarantees the export is deterministic.

**Workspace-anchored** vs **PR-anchored** endpoints:
The Stage backend exposes two parallel API surfaces. *Workspace-anchored* endpoints (URL contains `/workspaces/{uuid}/...`) require a Workspace to exist; they serve storyline + IntroComments. *PR-anchored* endpoints (URL contains `/repos/{owner}/{repo}/pulls/{number}/...`) require only a github PR; they pure-passthrough to github. A reviewer whose author did not use Stage uses only PR-anchored endpoints — Stage degrades to a thin review wrapper rather than refusing service.

**Import** (deliberately absent):
There is no manual "import this PR into Stage" action. A Workspace is created by the author via "Ready to share". When a reviewer encounters a PR with no Workspace, they review through PR-anchored endpoints; they do not create a Workspace on the author's behalf.

**Repo**:
The local git repository, identified by its git **common directory** — the unit the repo picker opens and that all its worktrees attach to. Carries the GitHub `(owner, name)` from its `origin` remote when one exists (the same pair the backend Workspace uses); with no remote it still exists, keyed by the common-dir. One Repo groups every worktree git reports for that common-dir.
_Avoid_: "active repo" (that names a path, not the entity); "clone".

**Worktree**:
A working directory git has attached to a Repo, each checked out on its own branch (git permits at most one worktree per branch). Surfaced as an annotation on the branch in the repo's branch list, never as a separate Repo. Stage only **observes** worktrees — it never creates, removes, prunes, or checks them out; their lifecycle stays with git and whatever tool the author uses.
_Avoid_: "checkout"; "Workspace" (the backend object); "workspace" (jj's word for this concept).

**Root worktree** / **Linked worktree**:
Git's original worktree (the one whose gitdir is the common-dir) vs. worktrees added later. The root cannot be removed; linked ones can. Either may hold the Default branch. Shown as a `root` / `⌥ worktree` badge in the branch list's worktree column.
_Avoid_: "main worktree" (collides with a branch named `main`).

**Default branch**:
The Repo's default branch, read from `origin/HEAD` (falling back to the repo's configured default). A property of the **branch** (shown beside the branch name), name-agnostic — it need not be called `main`, and it can be checked out on any worktree or none. Distinct from the **Root worktree**, which is a worktree property.
_Avoid_: assuming the default is `main` (it may be `master`, `develop`, …).

**Base branch** (a.k.a. target branch):
The branch a change is reviewed and prepared to merge **into** — the comparison point for the committed-work view of Self-Review and for the Storyline. Defaults to the repo's **remote default branch** (repo-wide, the same from any worktree, so it sidesteps a stale local default) and is selectable. Distinct from the **Default branch**, a fixed repo property: the Base branch is a per-review choice that merely *defaults* to it. "Target branch" is the same branch named from the merge-**into** perspective. For a **Workspace** the Base branch is the PR's merge target, so it is constrained to a branch that exists on the remote (a valid PR target); Self-Review, which never opens a PR, allows any local branch. Either way the comparison prefers the remote-tracking copy (`origin/<base>`) over a possibly-stale local branch of the same name (ADR-0016, ADR-0018).
_Avoid_: conflating with "Default branch"; surfacing "base ref" in user-facing copy (that's `base_ref`, a code name).
