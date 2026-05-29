# ADR-0010 · Workspace creation does no GitHub work; Publish owns the branch push and the existence check

**Status:** accepted
**Date:** 2026-05-29

## Context

A Workspace is created by the author's "Ready to share" gesture. The question is where the GitHub side of a branch's life is validated: at creation time, or later at Publish.

An earlier framing (older CONTEXT.md wording) treated "the branch already exists on github" as a **precondition of creation** — and treated Publish as PR-creation only, with the branch push happening as a separate, pre-Workspace step. That makes creation depend on remote state and forces the author to push before Stage is useful.

We want the author to be able to work **fully locally** — Self-Review, Ready-to-share, storyline composition — without ever pushing, and to ship branch + PR together in one deliberate step.

## Decision

**Workspace creation is a pure backend DB insert. It makes no GitHub call and imposes no GitHub precondition.** A purely-local branch that GitHub has never seen is a valid head for a Workspace.

**Publish is the single point where Stage touches GitHub for a branch.** First publish pushes the branch if GitHub does not already have it, then opens the PR (sets `pr_number`). Any failure to push/open surfaces GitHub's error there (e.g. `422`) — never at create.

## Considered alternatives

- **Validate branch existence at create (the old precondition).** Rejected: couples creation to remote state, breaks local-first (`design.md §4`, trust-the-client), and adds a GitHub round-trip to a DB-only operation. The check would also be racy — a branch can be deleted between create and publish, so Publish must re-check regardless, making the create-time check redundant.
- **Keep branch push as a separate step before Publish.** Rejected: forces a push before the author has decided to share, and splits "get my work onto GitHub" across two gestures. Folding the push into Publish gives one "go public" action.

## Consequences

- `workspace_create` stays a single `INSERT` (+ empty `Storyline`); no gateway dependency.
- A degenerate Workspace (e.g. `head_ref == base_ref`, or a branch never pushed) can exist pre-publish. The client mitigates the obvious case by excluding the default branch from the shareable Self-Review list; a backend `head == base` guard is a noted follow-up. Publish is the backstop — GitHub rejects what it can't represent.
- Error messaging at Publish must be clear, since it's the first time the author learns of a GitHub problem with their branch.
- CONTEXT.md's **Publish** and **Self-Review** entries were updated to match (no create-time precondition; Publish pushes branch + opens PR).
