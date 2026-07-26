# Working-tree mutations are scoped, confirmed actions

Status: accepted — amends ADR-0016 (worktrees remain observe-only by default)

ADR-0016 made Stage strictly observe-only toward worktrees, with the reviewer-entry checkout (ADR-0022 §6) as the lone exception. The unified branch→review flow needs branch actions to start from any row in the branch list, so we amended the rule rather than reversing it: **reading never mutates, and mutation happens only where the working tree genuinely matters, always behind an explicit confirmation that lists the exact git commands** (stash → checkout → stash pop, commit, push).

Concretely: self-review and debrief of a non-checked-out branch render committed tree-to-tree with **no checkout**. The confirmed switch runs only for (a) creating or updating a storyline — the `.stage` commit needs the tree — and (b) optionally when the user wants to run a PR they are reviewing. If the target branch is already checked out in another linked worktree, git forbids a second checkout; Stage performs the `.stage` commit in *that* worktree instead of switching the current one. "Any action switches" (the v6 mock's stance) was rejected: mutating the user's tree for a read-only look is exactly what ADR-0016 exists to prevent.
