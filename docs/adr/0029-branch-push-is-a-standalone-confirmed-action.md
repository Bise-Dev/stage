# ADR-0029 · Branch push and delete are standalone confirmed actions, and every git shell-out goes through one module

**Status:** accepted
**Date:** 2026-08-30
**Amends:** ADR-0019 (Publish owned the branch push); applies ADR-0027's confirmation rule to a non-working-tree mutation.

## Context

ADR-0019 made **Publish** the single point where Stage pushes a branch: push, then open the PR, in one "go public" gesture. That was right when a Workspace's whole purpose was to become a PR. It is no longer the whole story. Since ADR-0022 the product is local-first — the author reviews a branch, writes notes, and reads an agent's Debrief without GitHub in the picture at all — and the commonest thing they want next is not "open a PR" but "get these commits onto the remote": to back the work up, to hand it to CI, to let a colleague fetch it, or to update a PR that already exists.

There was no gesture for that. A `git_push` Tauri command existed but nothing in the UI called it, and it had drifted while unused:

- it spawned `Command::new("git")`, so a Dock-launched bundle got launchd's bare `PATH` — the exact failure #151 fixed for `gh`;
- it always passed `--set-upstream`, even for a branch that already tracked one;
- it always ran in the *focused* worktree, whichever branch that held;
- it pushed on the first click, with no confirmation and no statement of what would go out;
- its failures came back as `AppError::Backend("git_spawn_failed: …")`, losing git's own message.

That last cluster was not unique to push. Five modules each hand-rolled the same "spawn git, test the status, stringify stderr" block, and they had drifted in exactly the ways that matter: only `github.rs` resolved the binary via `tool_path`; `review_folder.rs` dropped git's stderr for a `{args:?} failed` debug string; `switch.rs` and `git.rs` had their own third and fourth spellings.

## Decision

**1 · A branch push is its own action, on the branch menu, behind the ADR-0027 confirmation.** ADR-0027 already named `push` among the mutations that must sit behind "an explicit confirmation that lists the exact git commands"; this is that rule applied. `stage-core::push` is two-phase like `switch`: `push_plan` inspects and returns the exact command, `push_execute` re-derives the plan and runs it. Publish keeps its inline push — it is still one gesture — and gains a sibling rather than losing a job.

**2 · A push is not a working-tree mutation, and is planned as one anyway.** It moves a remote ref and touches no file. The branch therefore needs no checkout to be pushed. But it is the one Stage action other people can see, so it gets the same confirmation: the command, the commit count, the directory it runs in, and what stays behind.

**3 · The push runs in the branch's own worktree.** Not the focused one. Pushing a ref works from anywhere in the repo, so this changes no outcome today; it means per-worktree config and hooks apply where the author expects, `--set-upstream` is written from the branch's own checkout, and the command Stage displays is the one the author would have typed in that directory. A branch with no worktree — or a `prunable` one — pushes from the repo root.

**4 · Stage never force-pushes.** A branch that has diverged from its upstream is a reported state with no button (`PushPlanOutcome::Diverged`, both counts named). Rebase, merge, or `--force-with-lease` are the author's call, made in their terminal. "Nothing to push" is likewise a report, not an empty push.

**5 · Deleting a branch is the same shape, and deletes only the local ref.** `stage-core::delete` plans and confirms like the other two. It never touches the remote branch: a local delete is recoverable from the reflog, while deleting the shared remote branch is visible to everyone and can break an open PR, so that stays something the author does deliberately in their terminal. It never removes a worktree (ADR-0016), and never deletes the branch's Debrief or Self-Review notes — a branch can be recreated at the same name, and silently dropping the author's own notes as a side effect of a ref delete would be the more surprising behaviour.

**6 · An unmerged delete is offered, with the recovery SHA, and no backup ref.** Deleting a dead experiment is a normal thing to want, so an unmerged branch is planned rather than refused — but it is the case where the author most needs to see what they are losing, so the plan carries the unmerged count, the ref it was measured against, the tip's commit summary, and the tip SHA. The confirmation shows `git branch <name> <sha>` for *every* delete, not just the risky ones: that SHA is the whole recovery story, and the moment after the delete is exactly when it stops being easy to find. Stage writes no backup tag or branch first — an unasked-for ref left behind is clutter the author then has to clean up, and the reflog already is the safety net. The default branch is refused outright; a branch any worktree holds (including a `prunable` one, which still blocks git's delete) is reported with the path, not deleted.

**7 · Every `git` shell-out in `stage-core` goes through `git_cli`.** One spawn (with `tool_path`'s resolved binary), one classifier (git's stderr verbatim), one place to fix the next thing that turns out to be wrong with all of them. `GitStep`/`GitStepKind` move out of `switch` into `git_step` for the same reason — the confirmation list is every git action's, not the switch's.

## Considered alternatives

- **Fold push into Publish only (keep ADR-0019 whole).** Rejected: it forces "I want a PR" on an author who only wants their commits on the remote, and leaves the local-first path with no way to share work at all.
- **Wire the existing one-shot `git_push` to the menu.** Rejected: it pushes on click. ADR-0027's confirmation rule exists precisely for the outward-facing ones, and this is the only Stage action other people can observe.
- **Offer `--force-with-lease` behind a scarier confirmation.** Rejected for now. A lost commit is the one failure a local review tool must never cause, and a diverged branch is nearly always resolved by understanding *why* it diverged — which happens in a terminal, not a modal.
- **Dim the entry when the snapshot says there's nothing to push.** Rejected: the overview snapshot is as fresh as the last fetch, so the menu would guess. The plan is cheap, local, and authoritative — let it answer.
- **Have push use `gh`.** Rejected: transport is the user's own git credentials (ADR-0022 §5). The push works with `gh` absent or unauthenticated, like every other git op.
- **Refuse to delete an unmerged branch.** Rejected: abandoning an experiment is ordinary, and a tool that only deletes branches git would have deleted anyway is not worth a menu entry. Showing the count and the recovery SHA is the honest version.
- **Write a backup tag/branch before deleting.** Rejected — and this is a standing preference, not a one-off: the reflog already holds the commits, and a safety ref nobody asked for becomes litter the author has to notice and clean up. Report the SHA instead.
- **Delete the branch's Debrief and notes alongside the ref.** Rejected: they are the author's own work, not git state, and the branch may be recreated. If orphaned local state becomes a real problem it deserves its own deliberate cleanup affordance.
- **Offer "delete local + remote" as one action.** Rejected for now: the two have very different blast radii, and folding them into one confirmation makes the dangerous half easy to trigger while aiming at the safe one.

## Consequences

- The branch menu carries **Push branch…** for every branch (ADR-0028's one shared menu), checked out or not, and **Delete branch…** for every branch but the default.
- `push_plan` is honest about staleness: the ahead/behind counts come from refs on disk. A plan is as fresh as the last fetch, and `push_execute` re-derives it, so a stale plan fails loud rather than pushing something unexpected.
- `git::push`, `PushOutcome` (the old shape) and the `git_push` command are deleted; `git::fetch` now spawns through `git_cli`, so it inherits the resolved-binary fix it never had.
- `SwitchStep`/`SwitchStepKind` are renamed to `GitStep`/`GitStepKind` — a breaking change to the generated TS bindings, absorbed in the same commit.
- The next git action (commit, fetch-one-branch) needs a `GitStepKind` variant and a plan module, not another dialog and another `Command::new`.
