# ADR-0016 · Git worktrees: observe-only, git as source of truth, Repo keyed by common-dir

**Status:** accepted
**Date:** 2026-06-06

## Context

Stage opens a local repo as a single working directory ("active repo" = a path) and runs Self-Review against the one checked-out branch. Authors increasingly use **git worktrees** — often created by an external tool (e.g. agent-deck) so a coding agent works an isolated branch in its own directory — then open Stage to Self-Review the change and read the agent's **Debrief**. Today Stage treats each worktree as an unrelated repo (keyed by its path), which fragments the repo picker, the branch list, and the Debrief store.

Goal: a git repo and its worktrees appear as **one Repo** in the UI, each worktree surfaced as an annotation on its branch, while Stage leans on git's own guarantees (notably git's rule of at most one worktree per branch).

Constraints surfaced while grilling the design against the codebase:

- The backend is a thin GitHub proxy keyed by `(owner, name)`; it stores no filesystem paths and needs **no change** (ADR-0001).
- The Debrief store and the `stage` CLI coordinate through `repo_key_from_cwd` → `(owner, name, branch)` (ADR-0011). Its no-remote fallback hashed the **per-worktree workdir basename** (`repo_key.rs:115-133`), so worktrees of a no-remote repo failed to resolve to one identity.
- `default_base()` (`diff.rs:415-425`) resolved the Self-Review base to the **local** default branch, which inside a worktree is frequently stale versus the remote.

## Decision

1. **Git is the source of truth.** Stage keeps no worktree registry. It enumerates worktrees from git on demand (`git worktree list --porcelain -z` on the common-dir, consistent with the existing `git fetch` shell-out in `git.rs:182`) and re-asks on change. Orphaned/stale directories that git omits do not exist to Stage.
2. **Observe-only (v1).** Stage never creates, removes, prunes, locks, or checks out worktrees. Their lifecycle stays with git and the author's tooling.
3. **Repo = git common directory.** One Repo groups every worktree under that common-dir. The identity *label* is adaptive — `(owner, name)` from `origin` when present (matching the backend Workspace), else a common-dir-derived local slug — but worktree **membership** is always the common-dir, never the origin.
4. **Separate clones of the same remote are independent Repos.** Same `(owner, name)` label, different common-dirs ⇒ not merged. Reconciling two independent clones is the user's responsibility, not Stage's.
5. **No-remote identity fix.** `local_fallback_slug` keys on `repo.commondir()` (and the common-dir's parent basename) instead of the per-worktree workdir, so all worktrees of a no-remote Repo resolve to one identity. Behavior change with **no migration** (POC + local SQLite; old keys simply re-resolve).
6. **A worktree is a branch annotation, not a repo.** The repo's full local branch list is the top level. A branch checked out in a worktree carries a `root` / `⌥ worktree` badge plus its path in a worktree column; `default` — a branch property read from `origin/HEAD`, name-agnostic — sits with the branch name. Plain branches show no badge and no Self-Review action. The branch/worktree columns are separated by layout only, no divider.
7. **Self-Review base defaults to the remote default branch** (`refs/remotes/origin/HEAD`, repo-wide via the common-dir), selectable per review. Candidates: remote default (preselected), the local default (flagged "N behind"), the root worktree's branch, any other local or `origin/*` ref. Remote-tracking freshness (last fetch) is surfaced, reusing the existing `git_fetch`. This rejects the stale local default. A no-remote Repo falls back to the local default / root worktree branch.
8. **Single focused worktree (v1).** Selecting a worktree's Self-Review replaces the current one; no concurrent multi-worktree tabs.
9. **Debrief store key unchanged** — `(owner, name, branch)`. Worktrees never collide (git's at-most-one-worktree-per-branch rule makes the triple unique). Two *separate clones* of the same remote on the same branch would share a Debrief row: a documented v1 limitation, the user's responsibility, intentionally not isolated now — keeping the key aligned with the backend Workspace key eases the future Debrief→Storyline promotion (ADR-0011).
10. **Backend untouched.**

## Considered alternatives

- **Group by origin remote.** Rejected: merges separate clones, lets a branch appear in two worktrees, and breaks the at-most-one-worktree-per-branch invariant the branch list relies on. The common-dir is git's own boundary.
- **Manage worktrees (create / finish / prune).** Rejected for v1: duplicates agent-deck and git, risks fighting external tooling over the same worktrees, and is a large surface. Observe-only matches the real flow, where creation already happens elsewhere.
- **Keep treating each worktree as its own repo (today's accidental behavior).** Rejected: fragments picker, branch list, and Debrief store; the author's mental model is "one repo", not "N folders".
- **Default the Self-Review base to the local default branch (today).** Rejected: stale inside a worktree; the author is preparing a PR against the remote default.
- **Add the common-dir to the Debrief key for clone-safety.** Deferred: diverges from the backend Workspace key for a rare, user-caused situation.

## Consequences

**Positive:**

- One Repo, one branch list; worktrees are additive annotations. A plain single-directory repo is the degenerate one-worktree case, so today's behavior falls out unchanged with no special-casing.
- No new persistence and no backend change; the feature leans entirely on git plus the existing diff code.
- The Self-Review base reflects PR intent (versus the remote default) rather than local drift.

**Negative / costs:**

- A new shell-out (`git worktree list --porcelain -z`) alongside the existing `git fetch` one, with porcelain `-z` parsing to maintain.
- The `local_fallback_slug` change relocates no-remote Debrief keys (accepted, no migration).
- The two-clones-same-branch Debrief collision is a known, documented limitation.
- Edge states to render: detached worktrees (labelled by short SHA), prunable / locked worktrees, and bare repos (no root working tree).

## Reference

- `CONTEXT.md` — **Repo**, **Worktree**, **Root worktree** / **Linked worktree**, **Default branch**, **Base branch**; refined **Self-Review**.
- ADR-0001 (three-tier topology; backend keyed by `(owner, name)`, no filesystem paths).
- ADR-0010 (self-review diff stack); `client/stage-core/src/diff.rs::self_review_diff` / `default_base`.
- ADR-0011 (Debrief key via `repo_key_from_cwd` → `(owner, name, branch)`).
- ADR-0014 (`stage open` launches the GUI; `repo_root_from_cwd`).
- `client/stage-core/src/repo_key.rs`, `client/stage-core/src/diff.rs`; `client/src-tauri/src/state.rs`, `client/src-tauri/src/commands.rs`.
