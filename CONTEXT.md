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

**Storyline**:
The author's chosen narrative for how a reviewer should walk through the change — an ordered sequence of steps, each pointing at part of the diff and optionally carrying an introductory note from the author.
_Avoid_: Tour, walkthrough, guide.

**Self-Review**:
An iterative, author-only stage in which the author inspects their own evolving diff to gain an improved overview of their current changes and guide further implementation work (with or without an agent). It lives as long as the author keeps editing the branch and ends when they are happy with the change. Distinct from the Storyline: a Self-Review is a working aid for the author; a Storyline is the artifact handed to reviewers.
_Avoid_: Local review, pre-flight, draft review.
