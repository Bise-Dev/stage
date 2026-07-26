# Stage

A local-first tool for human-tailored pull request review. Authors craft a guided walkthrough ("storyline") over their own branch; reviewers follow that walkthrough and leave comments. **GitHub is the system of record and Stage runs with no server of its own** — it stores only what git and GitHub cannot, as committed files on the branch.

## Design criteria

1. **Human-tailored review** — humans always have the last word. Stage assists; it does not auto-decide.
2. **Local-first, no backend** — the user works against local state (local git, a local store, the user's own `gh`). There is no Stage server, account, session, or stored token (ADR-0022 §5); network is the user's own `git`/`gh`, not a Stage API.
3. **GitHub-compatible, no duplication** — Stage stores only what GitHub and git cannot already represent (the storyline + per-step intros), as committed files in `.stage/`. Review activity (comments, the verdict) is native GitHub review activity posted through the user's `gh`, so a non-Stage reviewer uses the PR normally.

## Topology

Two entities. The client reaches GitHub with the user's **own** local credentials (ADR-0022):

```
Local Client  ⇄  GitHub          (API via `gh`, git transport via `git`)
     │
     ├─ local git repo + `.stage/<branch>/`   (committed — the shareable artifact)
     └─ a per-machine SQLite store             (private pre-publish drafts + Self-Review)
```

- **There is no Stage backend.** `stage-core` (Rust) is the whole engine: git2 reads, `git`/`gh` shell-outs, `.stage` read/write + scoped commits, the SQLite store, dashboard assembly, and identity. `src-tauri` is thin command bindings + watchers + window; `stage-cli` adds `stage open`.
- **No Stage credentials.** GitHub API calls shell out to the user's `gh` (which owns its token); git transport (push/fetch) uses the user's `git`. Stage holds, stores, and brokers **no** token. `gh` is a hard requirement — absent or unauthenticated is a loud, one-time "install `gh` / run `gh auth login`" error, with no broker fallback.
- **Identity** is the `gh` token owner, resolved read-only via `gh api user` (cached). There is no Stage account, session, sign-in, or "local-only" axis — the whole app is local.
- The shareable artifact (storyline + metadata) lives as **committed files in `.stage/<branch>/`** on the feature branch; it merges into the default branch with the PR and is visible in the diff. **One folder per Review, keyed by branch, with no shared index** — the dashboard discovers Reviews by listing folders, not a registry. The storyline is **single-writer** (author only); a genuine same-branch conflict surfaces as a normal git conflict, never a silent clobber.
- Pre-publish **drafts** live in a per-machine SQLite store (losing the machine loses the draft). **Publish** is a one-way promotion: it serializes the draft into committed `.stage`, after which the committed folder is authoritative and later edits write `.stage` directly.
- Review activity (comments, the verdict) is **write-through** to GitHub via `gh`; GitHub is the source of truth. Stage owns no Comment entity.
- **All derived state** (Review status, staleness, ready-to-publish, dashboard signal) is **computed in Rust**; the webview renders ts-rs-generated DTOs and never reads `.stage`/`gh`/`git` (ADR-0022 §7).

## Language

**Review** (the per-change artifact — formerly *Workspace*, ADR-0022 §8):
A Stage object over a local branch holding what doesn't belong in git or GitHub — primarily the storyline. **Keyed by the branch** (`head_ref`); the `.stage/<branch>/` folder name is a fast path while `head_ref` is authoritative. Before publish it is a **per-machine draft** in the local store, created at **Ready to share** (a Self-Review on its own needs no Review). At Publish it is serialized into committed `.stage/<branch>/` and optionally linked to a GitHub PR via a `pr_number` field; the Review's identity stays the branch and outlives the PR being merged or closed. No Stage UUID, no backend row.
_Avoid_: "Workspace" (the former name), Review session, branch context, PR draft.

**Review title**:
The author's human-readable label for a Review, entered at **Ready to share** and stored in `review.toml`. Independent of the GitHub PR title — it does **not** auto-sync after Publish. Distinct from the branch (`head_ref`), the machine identifier; the title is the human one.
_Avoid_: "name" (that's the branch), "PR title".

**Storyline**:
The author's chosen narrative for how a reviewer should walk through the change — an ordered sequence of steps, each pointing at part of the diff and optionally carrying an introductory note. Drafted in the local store; serialized at Publish to one file per step under `.stage/<branch>/steps/` (a zero-padded numeric filename prefix orders them; TOML frontmatter carries the anchor + optional title; the body is the markdown intro).
_Avoid_: Tour, walkthrough, guide.

**Self-Review**:
An iterative, author-only stage in which the author inspects their own evolving diff to gain an overview and guide further work (with or without an agent). It lives as long as the author keeps editing the branch and ends when they are happy. Distinct from the Storyline: a Self-Review is a working aid for the author; a Storyline is the artifact handed to reviewers. By default it compares the **selected worktree** against a **Base branch** (defaulting to the repo's remote default branch), showing the whole change — committed branch work plus uncommitted edits; the author can toggle to an **Uncommitted** view (working tree vs `HEAD`). A coding agent can attach a **Debrief** and read the author's **Self-Review notes** back, forming a local author↔agent loop. **Requires no GitHub auth** — `gh` is only invoked when a GitHub action is taken (Publish, or reviewing a PR).
_Avoid_: Local review, pre-flight, draft review.

**Debrief**:
An agent-authored, local, author-facing narrative over the agent's own contributions — the same ordered-steps-over-the-diff shape as a Storyline, but produced by a coding agent for the **author** to review during Self-Review, not for external reviewers. Each step carries an **agent-authored intro**. Composed against the Base-scope diff. Lives only on the author's machine. At **Ready to share** a Debrief can seed a Review's Storyline — carrying its ordered steps and intros across as a starting point the author then curates — or be discarded for a fresh one. Distinct from a Storyline by producer (agent), audience (the author), storage (local store), and lifecycle (regenerated across passes, not hand-curated).
_Avoid_: "Handoff" (collides with an agent's conversation handoff and the `handoff` skill), "self-review storyline", "draft storyline", "recap", "walkthrough".

**Self-Review note** (formerly *Review note*, ADR-0022 §8):
The author's annotation on a **diff location** (a file path, optionally a line range), made during Self-Review — before any shareable Review exists. Anchored to the diff rather than to a Debrief step, so it survives the agent regenerating the Debrief and exists even with no agent involved. A **threaded conversation** (the author's opening text plus author/agent replies) with an **open → addressed → resolved** lifecycle. Local-only. The single annotation concept on a Self-Review diff — there is no separate ephemeral "comment". Distinct from a **GitHub PR review thread** (post-publish step discussion) and from a github review **verdict**.
_Avoid_: "comment" (the diff affordance creates a Self-Review note), "feedback", "change request", "IntroComment" (removed — see *Step discussion*).

**Ready to share** (state, gesture):
The author's explicit "I'm done iterating, now prepare what reviewers will see" decision. **Creates the per-machine draft Review in the local store** (Self-Review has no Review; this gesture makes one). After this, the author is in storyline composition. **Implies a committed branch**: storyline composition works against the *settled committed branch diff* — reviewing still-uncommitted edits is the earlier Self-Review phase's job.
_Avoid_: "share" (overloaded), "publish" (the next step).

**Ready to publish** (state, computed):
The condition that gates Publish: the Storyline has ≥1 step, every step has a non-empty intro, and **no step is stale** against the current committed diff (a stale step narrates code the PR wouldn't contain, so it is never publishable — the author removes or re-anchors it, per *Stale step*). **Computed in Rust, never stored** — the moment the last gap is fixed, the Review is ready to publish.
_Avoid_: "complete", "done".

**Verdict** (the review decision, ADR-0022 §8):
The reviewer's overall GitHub decision — **approve**, **request changes**, or **comment** — submitted through the user's `gh` as a native GitHub review (maps to the GitHub Reviews API `event`). The bare noun "review" is reserved for the Stage artifact, so we say "submit a verdict".
_Avoid_: naming it "review" (ambiguous with the artifact); treating it as a stored Stage state (it's GitHub's).

**Review status** (derived, never stored — formerly *Workspace state*):
The single status shown per Review, computed in Rust from the draft and the PR's GitHub state. Pre-publish: **Draft** or **Ready to publish**. Published (PR open): the GitHub review decision — **Open** (no verdict yet), **Changes requested**, or **Approved**. PR closed/merged: **Merged** / **Closed** (archived). "Reviewing" is **not** a status — it describes your role/column.
_Avoid_: storing it; using "Ready to share" as a status (that's the creation gesture).

**Publish** (verb):
The action that gets a Review's branch + PR onto GitHub. **There is no GitHub precondition before this** — the author works fully locally (Self-Review → Ready-to-share → storyline composition) without pushing. Publish serializes the draft storyline into `.stage/<branch>/`, makes a scoped commit, `git push`es the branch with the user's own credentials, and runs `gh pr create` (or edit/reopen) — auto-posting exactly one "Open in Stage" PR comment on first create. A branch that can't be pushed/opened surfaces `gh`/`git`'s error here, fail-loud. Re-publishing (push an update against the same PR) is the normal lifecycle.
_Avoid_: "submit" (that's the verdict), "send".

**Uncommitted work at Publish**:
Publish refuses to run silently over a dirty working tree — *uncommitted work* is any staged, unstaged-tracked, or untracked (non-ignored) change, excluding Stage's own `.stage/<branch>/` writes. The author sees the affected paths and chooses a **disposition**: **commit everything** into the branch first (the one place Stage authors a commit of the author's code, with an author-editable message), **publish without it** (the committed branch is the whole change; the listed paths stay local), or cancel. The choice is per-publish, never remembered; the gate is enforced in Rust, so no entry path (app or CLI) can publish a dirty tree without an explicit disposition. Guards the failure where the change exists only in the working tree and Publish would ship a storyline with none of the code.
_Avoid_: "dirty tree" in user-facing copy (say "uncommitted work"); treating Stage's scoped `.stage` commit as uncommitted work.

**Review lifetime**:
A Review outlives the GitHub PR it points to. PR close/merge does not delete it — the committed `.stage` stays on the branch, and the author can resume Self-Review, edit the Storyline, and re-publish (reopening a PR if needed). Archiving is **not** a manual action and is **never stored**: it follows the PR's GitHub state (closed/merged → archived; reopened → restored). See ADR-0002.

**Comment**:
Native GitHub review activity (a PR-level issue comment, or an inline line comment), posted **write-through** to GitHub via the user's `gh`. Stage owns no Comment entity and stores no comment drafts. See ADR-0003 (the write-through principle survives the backend's removal).

**Step discussion** (post-publish — replaces the removed *IntroComment*):
Discussion on a storyline step is a **GitHub PR review thread**, code-anchored to the step's diff location (never to the intro paragraph). Resolve / reopen / edit / delete map to GitHub natives, gated per-comment by GitHub-computed viewer capabilities. **IntroComment is removed** (ADR-0022 §8) — there is no Stage-native intro-discussion entity. Pre-publish, the author's private annotations are **Self-Review notes**.

**Stale step**:
A Storyline step whose anchor is no longer part of the change set it composes against (file removed, renamed, or never present). **Computed in Rust** (never stored), two detection sites by phase: **pre-publish** against the local draft's committed diff; **post-publish** against the committed `.stage` storyline vs the current PR head. Surfaced as a per-step flag; nothing auto-fixes — the author edits the storyline. Pre-publish, a stale step **blocks Publish** (see *Ready to publish*). The two detectors can disagree (the local diff and the eventual PR diff need not match — see *Publish*), which is expected.
_Avoid_: "broken step", "outdated step", "orphaned step" (we say "stale" consistently).

**Archived Review**:
A Review whose GitHub PR is closed or merged. Derived strictly from the PR's GitHub state — there is no manual "archive" gesture and the state is never stored. Reopening the PR restores it. The default dashboard view hides archived Reviews — a view filter, not a separate state.
_Avoid_: "frozen" (former name); implying a manual archive action or a stored flag.

**Decisions document** (future):
A planned export of an archived Review into a single self-contained artifact (markdown / structured) capturing the storyline + intros + the GitHub review activity (verdict, threads). Out of scope today.

**Reviewer entry** (open a PR read-only):
How a reviewer reaches a change. Default is fully local and read-only: a GitHub PR search (the dashboard) or `stage open <pr-url>` resolves the PR to a local clone by `origin` match, `git fetch`es the PR head, and renders the storyline + diff **tree-to-tree** (ADR-0018) with **no working-tree mutation**. The lone exception is a user-confirmed **"Check out this branch"** for reviewers who want to build/run. A PR with no `.stage` storyline degrades gracefully to a plain read-only diff (Stage is a thin review wrapper, never refusing service). There is **no "import"** — the storyline rides the branch, so there is nothing to import.
_Avoid_: "import this PR into Stage" (deliberately absent); treating a clone-less github.com review as a Stage flow (it falls back to the raw diff with `.stage/*` files visible).

**Repo**:
The local git repository, identified by its git **common directory** — the unit the repo picker opens and that all its worktrees attach to. Carries the GitHub `(owner, name)` from its `origin` remote when one exists; with no remote it still exists, keyed by the common-dir. One Repo groups every worktree git reports for that common-dir.
_Avoid_: "active repo" (that names a path, not the entity); "clone".

**Worktree**:
A working directory git has attached to a Repo, each checked out on its own branch (git permits at most one worktree per branch). Surfaced as an annotation on the branch in the repo's branch list, never as a separate Repo. Stage only **observes** worktrees — it never creates, removes, prunes, or checks them out (the one exception is the user-confirmed reviewer checkout, ADR-0016/0022); their lifecycle stays with git and whatever tool the author uses.
_Avoid_: "checkout"; "Workspace"; "workspace" (jj's word for this concept).

**Root worktree** / **Linked worktree**:
Git's original worktree (the one whose gitdir is the common-dir) vs. worktrees added later. The root cannot be removed; linked ones can. Either may hold the Default branch. Shown as a `root` / `⌥ worktree` badge in the branch list's worktree column.
_Avoid_: "main worktree" (collides with a branch named `main`).

**Default branch**:
The Repo's default branch, read from `origin/HEAD` (falling back to the repo's configured default). A property of the **branch** (shown beside the branch name), name-agnostic — it need not be `main`, and it can be checked out on any worktree or none. Distinct from the **Root worktree**, a worktree property.
_Avoid_: assuming the default is `main` (it may be `master`, `develop`, …).

**Base branch** (a.k.a. target branch):
The branch a change is reviewed and prepared to merge **into** — the comparison point for the committed-work view of Self-Review and for the Storyline. Defaults to the repo's **remote default branch** (repo-wide, so it sidesteps a stale local default) and is selectable. Distinct from the **Default branch**, a fixed repo property: the Base branch is a per-review choice that merely *defaults* to it. For a published Review the Base branch is the PR's merge target, so it is constrained to a branch that exists on the remote; Self-Review, which never opens a PR, allows any local branch. Either way the comparison prefers the remote-tracking copy (`origin/<base>`) over a possibly-stale local branch (ADR-0016, ADR-0018).
_Avoid_: conflating with "Default branch"; surfacing "base ref" in user-facing copy (that's `base_ref`, a code name).
