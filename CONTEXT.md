# Stage

A local-first tool for human-tailored pull request review. Authors craft a guided walkthrough ("storyline") over their own branch; reviewers follow that walkthrough and leave comments. **GitHub is the system of record and Stage runs with no server of its own** — it stores only what git and GitHub cannot, as committed files on the branch.

## Shipping scope (read this before the glossary)

That paragraph describes the **domain**, which this document defines in full. It does not describe what the **current version supports**, which is narrower: **local Self-Review, with the agent's Debrief folded into it, and nothing else**.

Everything downstream of **Ready to share** — the **Review** artifact, **Storyline** composition, **Publish**, **Reviewer entry**, **Verdict**, and post-publish **Step discussion** — is implemented in `stage-core`, but its UI is **commented out** in the webview and refused by the CLI. The terms below stay authoritative because the engine, the store and the `.stage` format still use them; they are marked **[gated]** where a reader might otherwise expect to find them in the app.

Live in the shipping app: **Self-Review**, **Debrief**, **Chapter** (as the Debrief's unit), **Self-Review note**, **Base branch**, **Repo**, **Worktree**, **Branch**, **Push branch**, **Delete branch**.

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

- **There is no Stage backend.** `stage-core` (Rust) is the whole engine: git2 reads, `git`/`gh` shell-outs, `.stage` read/write + scoped commits, the SQLite store, dashboard assembly, and identity. `src-tauri` is thin command bindings + watchers + window; `stage-cli` adds the `st` CLI (`st open`).
- **No Stage credentials.** GitHub API calls shell out to the user's `gh` (which owns its token); git transport (push/fetch) uses the user's `git`. Stage holds, stores, and brokers **no** token. `gh` is a hard requirement — absent or unauthenticated is a loud, one-time "install `gh` / run `gh auth login`" error, with no broker fallback. Because a Dock/Finder-launched macOS bundle inherits launchd's minimal `PATH` (no Homebrew), Stage locates `gh`/`git` itself rather than trusting the inherited `PATH` — see `client/stage-core/src/tool_path.rs` for the ladder and the `STAGE_GH_BIN` override.
- **Identity** is the `gh` token owner, resolved read-only via `gh api user` (cached). There is no Stage account, session, sign-in, or "local-only" axis — the whole app is local.
- The shareable artifact (storyline + metadata) lives as **committed files in `.stage/<branch>/`** on the feature branch; it merges into the default branch with the PR and is visible in the diff. **One folder per Review, keyed by branch, with no shared index** — the dashboard discovers Reviews by listing folders, not a registry. The storyline is **single-writer** (author only); a genuine same-branch conflict surfaces as a normal git conflict, never a silent clobber.
- Pre-publish **drafts** live in a per-machine SQLite store (losing the machine loses the draft). **Publish** is a one-way promotion: it serializes the draft into committed `.stage`, after which the committed folder is authoritative and later edits write `.stage` directly.
- Review activity (comments, the verdict) is **write-through** to GitHub via `gh`; GitHub is the source of truth. Stage owns no Comment entity.
- **All derived state** (Review status, staleness, ready-to-publish, dashboard signal) is **computed in Rust**; the webview renders ts-rs-generated DTOs and never reads `.stage`/`gh`/`git` (ADR-0022 §7).

## Language

**Review** (the per-change artifact — formerly *Workspace*, ADR-0022 §8): **[gated]**
A Stage object over a local branch holding what doesn't belong in git or GitHub — primarily the storyline. **Keyed by the branch** (`head_ref`); the `.stage/<branch>/` folder name is a fast path while `head_ref` is authoritative. Before publish it is a **per-machine draft** in the local store, created at **Ready to share** (a Self-Review on its own needs no Review). At Publish it is serialized into committed `.stage/<branch>/` and optionally linked to a GitHub PR via a `pr_number` field; the Review's identity stays the branch and outlives the PR being merged or closed. No Stage UUID, no backend row.
_Avoid_: "Workspace" (the former name), Review session, branch context, PR draft.

**Review title**: **[gated]**
The author's human-readable label for a Review, entered at **Ready to share** and stored in `review.toml`. Independent of the GitHub PR title — it does **not** auto-sync after Publish. Distinct from the branch (`head_ref`), the machine identifier; the title is the human one.
_Avoid_: "name" (that's the branch), "PR title".

**Storyline**: **[gated]**
The author's chosen narrative for how a reviewer should walk through the change — an ordered sequence of **Chapters** over the diff. Changed files the author leaves out of every chapter stay part of the published Review: reviewers see them as an automatic, alphabetical "Everything else" section at the end, and they never block publishing. Drafted in the local store; serialized at Publish to one file per chapter under `.stage/<branch>/`. The pre-chapter one-file-per-step format is not read — a legacy `.stage` folder fails loudly rather than rendering partially.
_Avoid_: Tour, walkthrough, guide.

**Chapter**:
The Storyline's narrative unit: a titled, author-ordered group of changed files carrying **one intro** addressed to reviewers. Chapters are the only carrier of narrative — files inside a chapter have no per-file title or intro of their own.
_Avoid_: "step" (the retired pre-chapter unit, one file + one intro each), section, group.

**Self-Review**:
An iterative, author-only stage in which the author inspects their own evolving diff to gain an overview and guide further work (with or without an agent). It lives as long as the author keeps editing the branch and ends when they are happy. Distinct from the Storyline: a Self-Review is a working aid for the author; a Storyline is the artifact handed to reviewers. By default it shows the **committed** branch work against a **Base branch** (defaulting to the repo's remote default branch); folding uncommitted edits in **widens that same diff** rather than adding a section (ADR-0030), so every file appears once with all of its work in one patch. It is the **one review surface for the author's own work**: a branch's Debrief is read here, not in a separate view. A coding agent can attach a **Debrief** and read the author's **Self-Review notes** back, forming a local author↔agent loop. **Requires no GitHub auth** — `gh` is only invoked when a GitHub action is taken (Publish, or reviewing a PR).
_Avoid_: Local review, pre-flight, draft review.

**Debrief**:
An agent-authored, local, author-facing narrative over the agent's own contributions — the same ordered-**Chapters** shape as a Storyline, but produced by a coding agent for the **author** to review during Self-Review, not for external reviewers. It is **content within the Self-Review surface, not a separate view**: the author reads it alongside the diff it narrates, and opening that Self-Review is what marks it seen. Each Chapter carries an **agent-authored intro**; the Debrief holds no per-file or inline commentary — the author's questions and the agent's answers live in **Self-Review notes**. It describes the branch as the agent left it (committed + uncommitted; no commit required) and records the head SHA and timestamp at write time, so the UI can present it as new / seen / outdated. One Debrief per branch, **overwritten** on every agent pass. Lives only on the author's machine. At **Ready to share** a Debrief can seed a Review's Storyline — its Chapters and intros carry across 1:1 as a starting point the author then curates — or be discarded for a fresh one. Distinct from a Storyline by producer (agent), audience (the author), storage (local store), and lifecycle (regenerated across passes, not hand-curated).
_Avoid_: "Handoff" (collides with an agent's conversation handoff and the `handoff` skill), "self-review storyline", "draft storyline", "recap", "walkthrough".

**Self-Review note** (formerly *Review note*, ADR-0022 §8):
The author's annotation on a **diff location** (a file path, optionally a line range), made during Self-Review — before any shareable Review exists. Anchored to the diff rather than to a Debrief step, so it survives the agent regenerating the Debrief and exists even with no agent involved. A **threaded conversation** (the author's opening text plus author/agent replies) with an **open → addressed → resolved** lifecycle. Local-only. The single annotation concept on a Self-Review diff — there is no separate ephemeral "comment". Distinct from a **GitHub PR review thread** (post-publish step discussion) and from a github review **verdict**.
_Avoid_: "comment" (the diff affordance creates a Self-Review note), "feedback", "change request", "IntroComment" (removed — see *Step discussion*).

**Ready to share** (state, gesture): **[gated]**
The author's explicit "I'm done iterating, now prepare what reviewers will see" decision. **Creates the per-machine draft Review in the local store** (Self-Review has no Review; this gesture makes one). After this, the author is in storyline composition. **Implies a committed branch**: storyline composition works against the *settled committed branch diff* — reviewing still-uncommitted edits is the earlier Self-Review phase's job.
_Avoid_: "share" (overloaded), "publish" (the next step).

**Ready to publish** (state, computed): **[gated]**
The condition that gates Publish: the Storyline has ≥1 Chapter, every Chapter has a title and a non-empty intro, and **no chapter is stale** against the current committed diff (a stale chapter narrates code the PR wouldn't contain, so it is never publishable — the author removes or re-anchors it, per *Stale chapter*). Unplaced files never block (they publish into the "Everything else" section). **Computed in Rust, never stored** — the moment the last gap is fixed, the Review is ready to publish.
_Avoid_: "complete", "done".

**Verdict** (the review decision, ADR-0022 §8): **[gated]**
The reviewer's overall GitHub decision — **approve**, **request changes**, or **comment** — submitted through the user's `gh` as a native GitHub review (maps to the GitHub Reviews API `event`). The bare noun "review" is reserved for the Stage artifact, so we say "submit a verdict".
_Avoid_: naming it "review" (ambiguous with the artifact); treating it as a stored Stage state (it's GitHub's).

**Review status** (derived, never stored — formerly *Workspace state*): **[gated]**
The single status shown per Review, computed in Rust from the draft and the PR's GitHub state. Pre-publish: **Draft** or **Ready to publish**. Published (PR open): the GitHub review decision — **Open** (no verdict yet), **Changes requested**, or **Approved**. PR closed/merged: **Merged** / **Closed** (archived). "Reviewing" is **not** a status — it describes your role/column.
_Avoid_: storing it; using "Ready to share" as a status (that's the creation gesture).

**Publish** (verb): **[gated]**
The action that gets a Review's branch + PR onto GitHub. **There is no GitHub precondition before this** — the author works fully locally (Self-Review → Ready-to-share → storyline composition) without pushing. Publish serializes the draft storyline into `.stage/<branch>/`, makes a scoped commit, `git push`es the branch with the user's own credentials, and runs `gh pr create` (or edit/reopen) — auto-posting exactly one "Open in Stage" PR comment on first create. A branch that can't be pushed/opened surfaces `gh`/`git`'s error here, fail-loud. Re-publishing (push an update against the same PR) is the normal lifecycle.
_Avoid_: "submit" (that's the verdict), "send".

**Push branch** (verb, ADR-0029):
Getting a branch's commits onto its remote, and nothing else — no PR, no `.stage` commit, no `gh`. The standalone counterpart to the gated **Publish**, which does this *and* opens a PR as one gesture. Offered on every branch in the branch menu, checked out or not: a push moves a ref, so it needs no working tree. It is planned before it runs, like a **Switch**: Stage shows the exact `git push` command, the commit count, and the directory it runs in, and nothing happens until the author confirms. That directory is the branch's **own** worktree when it has one, not the focused one. Uncommitted work never rides along — the confirmation says how much stays local. A branch that has **diverged** from its upstream is reported, never pushed: Stage never force-pushes, so rebasing or merging is the author's own call.
_Avoid_: "publish" for a bare push (Publish opens a PR); "sync" (that's the background snapshot engine); "upload".

**Delete branch** (verb, ADR-0029):
Deleting one **local** branch ref, and only that. The remote branch is never touched (that's visible to everyone and can break an open PR — the author does it themselves), no worktree is removed (ADR-0016), and the branch's **Debrief** and **Self-Review notes** are kept, since a branch can be recreated at the same name. Planned and confirmed like a **Push branch**: the confirmation names the branch's last commit, says how many commits are not in the comparison ref (its upstream, else the **Default branch**), and shows the tip SHA that restores it — `git branch <name> <sha>` — for every delete, not only risky ones. An **unmerged** branch is offered, not refused; the **Default branch** is refused; a branch any worktree holds is reported with that worktree's path. Stage writes **no** backup tag or branch first — the reflog is the safety net, and an unasked-for ref is just litter.
_Avoid_: "remove" (that's worktrees, which Stage never does); implying the remote branch goes too.

**Uncommitted work at Publish**: **[gated]**
Publish refuses to run silently over a dirty working tree — *uncommitted work* is any staged, unstaged-tracked, or untracked (non-ignored) change, excluding Stage's own `.stage/<branch>/` writes. The author sees the affected paths and chooses a **disposition**: **commit everything** into the branch first (the one place Stage authors a commit of the author's code, with an author-editable message), **publish without it** (the committed branch is the whole change; the listed paths stay local), or cancel. The choice is per-publish, never remembered; the gate is enforced in Rust, so no entry path (app or CLI) can publish a dirty tree without an explicit disposition. Guards the failure where the change exists only in the working tree and Publish would ship a storyline with none of the code.
_Avoid_: "dirty tree" in user-facing copy (say "uncommitted work"); treating Stage's scoped `.stage` commit as uncommitted work.

**Review lifetime**: **[gated]**
A Review outlives the GitHub PR it points to. PR close/merge does not delete it — the committed `.stage` stays on the branch, and the author can resume Self-Review, edit the Storyline, and re-publish (reopening a PR if needed). Archiving is **not** a manual action and is **never stored**: it follows the PR's GitHub state (closed/merged → archived; reopened → restored). See ADR-0002.

**Comment**: **[gated]**
Native GitHub review activity (a PR-level issue comment, or an inline line comment). While a review is being **drafted** in Stage, comments accumulate locally — each with a **severity** (blocking / suggestion / nit, rendered as a bold prefix in the posted body, since GitHub has no severity field) — and reach GitHub only at **Finish review**, submitted together as one GitHub review (overall comment = review body, verdict = review event). Replies inside an existing GitHub thread remain write-through. Stage owns no post-publish Comment entity; GitHub is the record once submitted.

**Storyline discussion** (formerly *Step discussion*; post-publish — replaces the removed *IntroComment*): **[gated]**
Discussion on a storyline is a **GitHub PR review thread**, code-anchored to a diff location within a chapter's files (never to a chapter's intro paragraph). Resolve / reopen / edit / delete map to GitHub natives, gated per-comment by GitHub-computed viewer capabilities. **IntroComment is removed** (ADR-0022 §8) — there is no Stage-native intro-discussion entity. Pre-publish, the author's private annotations are **Self-Review notes**.

**Stale chapter** (formerly *Stale step*): **[gated]**
A Chapter holding a **stale file reference** — a referenced file that is no longer part of the change set the Storyline composes against (removed, renamed, or never present). **Computed in Rust** (never stored), per file reference, two detection sites by phase: **pre-publish** against the local draft's committed diff; **post-publish** against the committed `.stage` storyline vs the current PR head. Surfaced as a flag on the chapter; nothing auto-fixes — the author edits the storyline. Pre-publish, a stale chapter **blocks Publish** (see *Ready to publish*). The two detectors can disagree (the local diff and the eventual PR diff need not match — see *Publish*), which is expected.
_Avoid_: "broken chapter", "outdated chapter", "orphaned file" (we say "stale" consistently).

**Archived Review**: **[gated]**
A Review whose GitHub PR is closed or merged. Derived strictly from the PR's GitHub state — there is no manual "archive" gesture and the state is never stored. Reopening the PR restores it. The default dashboard view hides archived Reviews — a view filter, not a separate state.
_Avoid_: "frozen" (former name); implying a manual archive action or a stored flag.

**Decisions document** (future):
A planned export of an archived Review into a single self-contained artifact (markdown / structured) capturing the storyline + intros + the GitHub review activity (verdict, threads). Out of scope today.

**Reviewer entry** (open a PR read-only): **[gated]**
How a reviewer reaches a change. Default is fully local and read-only: a GitHub PR search (the dashboard) or `st open <pr-url>` resolves the PR to a local clone by `origin` match, `git fetch`es the PR head, and renders the storyline + diff **tree-to-tree** (ADR-0018) with **no working-tree mutation**. The lone exception is a user-confirmed **"Check out this branch"** for reviewers who want to build/run. A PR with no `.stage` storyline degrades gracefully to a plain read-only diff (Stage is a thin review wrapper, never refusing service). There is **no "import"** — the storyline rides the branch, so there is nothing to import.
_Avoid_: "import this PR into Stage" (deliberately absent); treating a clone-less github.com review as a Stage flow (it falls back to the raw diff with `.stage/*` files visible).

**Repo**:
The local git repository, identified by its git **common directory** — the unit the repo picker opens and that all its worktrees attach to. Carries the GitHub `(owner, name)` from its `origin` remote when one exists; with no remote it still exists, keyed by the common-dir. One Repo groups every worktree git reports for that common-dir.
_Avoid_: "active repo" (that names a path, not the entity); "clone".

**Worktree**:
A working directory git has attached to a Repo, each checked out on its own branch (git permits at most one worktree per branch). Surfaced as an annotation on the branch in the repo's branch list, never as a separate Repo. Stage only **observes** worktrees — it never creates, removes, prunes, or checks them out (the one exception is the user-confirmed reviewer checkout, ADR-0016/0022); their lifecycle stays with git and whatever tool the author uses. A worktree git reports **prunable** (its directory is gone) is not a Worktree for Stage's purposes: every view treats its branch as having none, because nothing there can be opened, reviewed, or switched to — the branch list still marks it `prunable` so the user can see why the worktree went away. Git still refuses a second checkout of that branch until the user prunes it themselves.
_Avoid_: "checkout"; "Workspace"; "workspace" (jj's word for this concept); calling a prunable worktree a Worktree.

**Root worktree** / **Linked worktree**:
Git's original worktree (the one whose gitdir is the common-dir) vs. worktrees added later. The root cannot be removed; linked ones can. Either may hold the Default branch. Shown as a `root` / `⌥ worktree` badge in the branch list's worktree column.
_Avoid_: "main worktree" (collides with a branch named `main`).

**Default branch**:
The Repo's default branch, read from `origin/HEAD` (falling back to the repo's configured default). A property of the **branch** (shown beside the branch name), name-agnostic — it need not be `main`, and it can be checked out on any worktree or none. Distinct from the **Root worktree**, a worktree property.
_Avoid_: assuming the default is `main` (it may be `master`, `develop`, …).

**Base branch** (a.k.a. target branch):
The branch a change is reviewed and prepared to merge **into** — the comparison point for the committed-work view of Self-Review and for the Storyline. Defaults to the repo's **remote default branch** (repo-wide, so it sidesteps a stale local default) and is selectable. Distinct from the **Default branch**, a fixed repo property: the Base branch is a per-review choice that merely *defaults* to it. For a published Review the Base branch is the PR's merge target, so it is constrained to a branch that exists on the remote; Self-Review, which never opens a PR, allows any local branch. Either way the comparison prefers the remote-tracking copy (`origin/<base>`) over a possibly-stale local branch (ADR-0016, ADR-0018).
_Avoid_: conflating with "Default branch"; surfacing "base ref" in user-facing copy (that's `base_ref`, a code name).
