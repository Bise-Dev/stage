# ADR-0018 · Storyline diff is a committed tree↔tree diff, decoupled from the checkout

**Status:** accepted
**Date:** 2026-06-12

## Context

Storyline composition previewed its diff by reusing Self-Review's diff command,
`self_review_diff(scope = Base, base_ref)` (`stage-core/src/diff.rs`). That call
diffs `merge_base(base, HEAD) → working tree` — the head side is **whatever is
checked out** in the active repo. The storyline screen then guarded
`diff.currentBranch === ctx.headRef` and, on mismatch, surfaced
*"The working tree is on X, but this storyline is for Y. Check out Y…"*.

Two things made this wrong in practice:

- **It assumed the head ref is the checked-out branch.** With git worktrees
  (ADR-0016) a branch is checked out in *one* directory at most. Opening a
  storyline for `feature-x` from the main checkout (on `main`) — or for any
  branch fetched but not checked out anywhere — tripped the guard. The advice
  "check it out" is unfollowable: git refuses to check out a branch a worktree
  already holds.
- **It contradicted the glossary.** The `CONTEXT.md` **Ready to share** entry
  already states storyline composition works against the *"settled committed
  branch diff"* — uncommitted, working-tree changes are Self-Review's job, not
  the Storyline's. The preview pane diffed the working tree anyway.

Meanwhile the storyline **step list** (`git_diff_files`) and the **PR open**
(`pull_request_open`, `base ← head`) already resolved committed refs, so the
three surfaces of one storyline disagreed on what "the diff" was.

The decision was grilled against the codebase and glossary (the alternative —
"focus the head's worktree on open and keep the working-tree diff" — was
rejected: it still requires the branch checked out *somewhere* and still shows
uncommitted edits, contradicting the glossary).

## Decision

1. **The storyline diff is committed and checkout-independent.** New
   `stage_core::diff::committed_diff(base_ref, head_ref)` computes
   `merge_base(base, head) → head` **tree↔tree** (the GitHub "three-dot" PR
   diff). It resolves both sides as refs and never reads the working tree, so a
   storyline previews identically from the main checkout, any worktree, or none
   — as long as `head_ref` exists as a committed branch. Exposed as the
   `storyline_diff` Tauri command; the storyline preview drops the
   `currentBranch` guard entirely.

2. **The base prefers the remote-tracking ref.** `resolve_base_commit` resolves
   `base_ref` to `origin/<base_ref>` when it exists, else the bare ref — so a
   stale local `main` inside a worktree never skews the diff (the Self-Review
   base model, ADR-0016). `diff_files` / `diff_stats` (step list, overview
   stats) route through the same resolver, so list and preview now agree.

3. **A Workspace's base is a remote branch; `base_ref` is stored bare.** The
   base is the PR merge target, so it must exist on `origin`. The New Workspace
   base picker is sourced from `origin/*` (`git_remote_branches`), stricter than
   Self-Review's any-local-branch picker — an invalid base is rejected at
   creation, not at a Publish 422. The stored `base_ref` is the **bare branch
   name** (`main`, GitHub's vocabulary, what `pull_request_open` passes as
   `base=`); the `origin/` preference is a diff-time concern only.

## Consequences

- Two diff entry points now coexist in `diff.rs` by design:
  `self_review_diff` (tree↔**workdir**, includes uncommitted — Self-Review) and
  `committed_diff` (tree↔**tree**, committed only — Storyline). They are *not*
  redundant; they model the two glossary phases. `committed_diff` returns
  `head_sha` (the PR head), which is also the `commit_id` a reviewer needs to
  post a line comment against this diff.
- The storyline "no committed changes" empty state is now unambiguous: step list
  and preview are the same committed resolution, so an empty list means there is
  genuinely nothing to compose over (commit/push first) — the old
  "N uncommitted changes detected" branch is gone.
- Behavior change, **no migration**: `base_ref` was already stored bare; only the
  diff resolution and the picker change. Existing workspaces re-resolve.
- The base picker depends on `origin/*` being fetched; an unfetched remote
  yields a thinner list (the default stays selectable). Loading remote branches
  is additive and never blanks the local branch list on failure.
