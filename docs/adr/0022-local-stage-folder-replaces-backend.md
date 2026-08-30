# ADR-0022 · A local `.stage` folder replaces the backend

**Status:** accepted
**Date:** 2026-06-15 (accepted 2026-06-18)

> Scope: this records the architecture of the `.stage` refactor (integration branch
> `main_refactor_local`). **Accepted** and landed: the `backend/` directory and the client's
> backend SDK are deleted, `stage-core` is the whole engine, and `CONTEXT.md` describes this
> no-backend system. The milestones (A–H) that implemented it are merged.

## Context

The current architecture (ADR-0001) is three-tier: `Local Client ⇄ Stage Backend ⇄ GitHub`. The
backend (Django + Postgres) does two jobs: it **stores** Stage-native data (Workspace, Storyline,
IntroComment) and it **brokers** GitHub on the user's behalf, holding the OAuth token and exposing
a Stage session.

The requirement set re-derives the product as **local-first with no backend**. The
architecture-neutral residue of each backend job was already decided in those requirements: identity
is delegated to git/GitHub with no Stage account; GitHub is reached with the user's own local
credentials; step discussion and review activity live on GitHub's native surfaces; the dashboard is
a local scan plus a GitHub PR search; and it is accepted that Stage's own data appears in the PR
diff as committed files.

This ADR records the concrete architecture that satisfies those decisions: the backend is deleted,
all data handling moves to Rust, GitHub is reached through the local `gh`/`git` CLIs, and the
shareable artifact is stored as committed files in a `.stage/` folder on the feature branch.

ADR-0001 **explicitly rejected** storing the storyline as a file in the PR branch. That rejection is
revisited and overturned here — see *Considered alternatives*.

## Decision

### 1. Storage — `.stage` rides the feature branch

The shareable artifact lives as ordinary committed files on the feature branch. It merges into the
default branch with the PR and is visible in the PR diff. One folder per **Review** (the
renamed Workspace — see §8), keyed by branch, with **no shared index file** — the dashboard
discovers Reviews by listing folders, not by reading a registry.

```
.stage/<branch>/
  review.toml              # title, base_ref, head_ref, pr_number
  steps/
    010_<slug>.md          # +++ anchor, title +++   ·   intro = markdown body
    020_<slug>.md
```

- **One file per step**; order is a zero-padded numeric filename prefix (`010`, `020`, …); structure
  is TOML frontmatter (`anchor`, optional `title`); the intro is the raw markdown body.
- **Identity:** the `head_ref` field is authoritative and the folder name is a fast-path.
  Lookup tries `.stage/<current-branch>/`, else scans folders for a `head_ref` match. A confirmed
  branch rename re-syncs folder name + field. `pr_number` is a field (powers reviewer-from-PR
  lookup).

### 2. Conflict behaviour (the primary design goal)

- **Cross-branch: none.** Different branches write different folders; there is no shared file to
  conflict on. This is the reason for the no-index, folder-per-Review layout.
- **Same-branch / two-machine: rare and loud.** The storyline is **single-writer** — only the author
  writes `.stage` (enforced by git push permissions). One-file-per-step keeps independent edits
  independent. A genuine conflict surfaces as a normal git conflict (fail-loud), never a silent
  clobber.

### 3. Lifecycle — drafts stay out of git until publish

Self-Review *(private, no auth)* → **Ready to share** *(creates a per-machine draft in the local
store)* → compose storyline *(edits the draft; no commits, so pre-PR history stays clean)* →
**Publish** *(Rust serializes the draft into `.stage/<branch>/`, makes a scoped commit, `git push`,
`gh pr create`, and auto-posts one "Open in Stage" comment)*. After the first publish the committed
`.stage` is **authoritative** (one-way promotion); later edits write `.stage` directly + commit +
push.

This yields **two stores split at Ready-to-share**: the existing local SQLite store holds private
Self-Review state (Debrief, Self-Review notes, the pre-publish draft); committed `.stage` holds the
published storyline + metadata. Consequence: unpublished drafts are strictly per-machine.

### 4. Discussion

- **Pre-publish:** the author's annotations are **Self-Review notes** (local; no separate surface).
- **Post-publish:** **GitHub PR threads** per step; resolve/edit/delete map to GitHub
  natives.
- Discussion is always **code-anchored** to the step's diff location, never to the intro paragraph.

### 5. GitHub access and identity — local CLIs, no stored token

- **git transport** (push, fetch) uses the system `git` and the user's existing git credentials.
- **GitHub API** (open/read PR, submit verdict, comments, checks, search, PR actions, the
  auto-comment) shells out to **`gh`**, which owns its own token. Stage reads, stores, and holds
  **no credential**.
- `gh` is a **hard requirement**; absent or unauthenticated → a loud one-time "install `gh` / run
  `gh auth login`" message. There is no broker fallback.
- **Identity:** committed artifacts are attributed by their git commit author; GitHub
  actions by the `gh` token owner; `gh api user` (cached) answers "who am I" when needed. No Stage
  account, no Stage session. Stage does **not** reconcile the git commit identity against the `gh`
  identity (assumes the same human) — an accepted simplification.

### 6. Reviewer entry — fully local, read-only by default

- Default open is fully local and read-only: a GitHub PR search or
  `stage open <pr-url>` resolves the PR to a local clone by `origin` match, `git fetch`es the PR
  head, and renders the storyline + diff **tree-to-tree** (ADR-0018) with **no working-tree
  mutation**.
- A **user-confirmed "Check out this branch"** action is the lone exception (narrowly amends
  ADR-0016's observe-only stance) for reviewers who want to build/run.
- **Discovery:** on first publish Stage auto-posts exactly one PR comment carrying
  `stage open <pr-url>`. The https one-click "Open in Stage" link is deferred — it needs a host to
  redirect into a `stage://` handler, and there is no longer a backend to host it; the copy-paste
  command is the guaranteed path.
- No matching local clone → a loud, actionable error (no silent fallback).

### 7. Rust / TypeScript boundary — TS only visualizes

`stage-core` becomes the **entire engine**: git2 reads, `git`/`gh` shell-outs, `.stage`
read/write + scoped commits, the SQLite store (+ draft tables), dashboard assembly, identity.
`src-tauri` shrinks to thin command bindings + watchers + window; `stage-cli` gains
`OpenMode::Review`. **All derived state** (Review state, staleness, ready-to-publish, dashboard
signal) is computed in Rust; TS receives view-ready DTOs and only renders — it never reads
`.stage`/`gh`/`git` or derives state. The Rust↔TS type contract is enforced by **ts-rs**-generated
types (already in place). Deleted: the backend HTTP SDK (`api/*`), `oauth.rs`, `session.rs`.

### 8. Terminology

- **Workspace → Review** (the per-change artifact). `title`/`state`/`lifetime`/`archived` cascade.
- The GitHub approve / request-changes / comment decision is the **verdict** ("submit a verdict").
  The bare noun "review" is reserved for the Stage artifact.
- **Review note → Self-Review note** (the author's annotation, made during Self-Review, before any
  Review artifact exists).
- **Self-Review** (a private author-only *phase*) and **Review** (a shareable *artifact*) coexist as
  different categories: a Self-Review produces a Review at Ready-to-share.
- **IntroComment** is removed; step discussion is a GitHub PR thread.

## Considered alternatives

- **Keep the storyline out of the PR diff (out-of-band ref / git-notes).** Rejected: reintroduces
  the hidden machinery this refactor deletes, breaks the "scan the working tree" dashboard, and the
  requirements already accept Stage data in the diff.

- **One fixed path for the storyline** (e.g. `.stage/storyline.toml` on every branch). Rejected: two
  branches write the same path, so *every* second merge into the default branch conflicts. The
  folder-per-Review layout is the fix.

- **A single index/registry file listing all Reviews.** Rejected: it is the same shared-file
  conflict trap. Folder discovery replaces it.

- **A storyline-array file with an `order` field** instead of one file per step. Rejected: every
  edit rewrites the whole file, so any two edits collide and reorders churn the array.

- **PR number as the Review key.** Rejected: no PR exists during the entire pre-publish authoring
  window, the key requires a network call, and a Review outlives/reuses across PRs — so PR
  number is a stored field, not the key.

- **Commit drafts to the branch as you author them (O1) / keep them uncommitted (O2).** O1 was the
  recommendation (it makes drafts cross-branch-discoverable and Publish ≈ `git push`) but was
  rejected in favour of clean pre-PR history; O2 cannot show drafts across branches. Drafts live in
  the local store until publish (O3) — accepting strictly per-machine drafts.

- **An in-process GitHub client (octocrab) reading a token from `gh`.** Rejected: Stage would then
  hold and manage the token (refresh, expiry, SSO). Shelling out to `gh` keeps Stage credential-free
  and matches the stated constraint to use the local `gh`/`git` CLIs.

- **Keep the term "Workspace" / name the artifact after its storage.** Rejected: the requirement
  issues consistently call it a "review"; aligning the domain term with that vocabulary is worth the
  knock-on renames (verdict, Self-Review note).

### Why ADR-0001's rejection no longer holds

ADR-0001 rejected the "storyline as a file in the PR branch" two-tier shape for four reasons. Each is
now resolved:

| ADR-0001 objection | Resolution here |
|---|---|
| Storyline mutates with **reviewer** activity → cross-user races on every push | The storyline is **single-writer** (author only). Reviewers discuss via GitHub threads and **never** write `.stage`. The race is gone. |
| Reviewers without push access can't edit it | Reviewers are not meant to edit it — author-only by design. They fetch + read; they discuss on GitHub. |
| Authors get stale-storyline warnings on every reviewer comment | Comments live on GitHub, not in `.stage`; reviewer activity never touches the storyline, so it never goes stale from a comment. |
| GitHub credentials would live on every client (token-exposure surface) | Accepted and inverted: Stage holds **no** token — it shells out to the user's `gh`. There is no Stage-managed token surface at all. |

## Consequences

**Positive**
- No server to operate, deploy, or secure; no Stage IdP, no session, no stored OAuth token.
- The storyline travels with the branch for free on `push`/`pull`/`clone`; Publish ≈ `git push` + PR.
- Conflicts are structurally rare (single-writer, folder-per-Review, no index) and loud when real.
- One credential story: whatever the user already has for `git` + `gh`.

**Negative / accepted costs**
- `.stage` accumulates permanently on the default branch (one folder per merged Review), and Stage's
  scoped commits interleave with code commits on the branch.
- Unpublished drafts are strictly per-machine (local store); losing the machine loses the draft.
- A reviewer needs a **local clone** for the integrated experience; a clone-less, github.com-only
  reviewer falls back to reviewing the raw diff (with `.stage/*` files visible) on github.com.
- A user with working `git` but no usable GitHub API credential must do a one-time `gh auth login`;
  there is no broker fallback.

**Residual risk to validate**
- Branch-protection / signed-commit / required-status policies on the default branch may interact
  with Stage's auto-commits to `.stage` (e.g. a signed-commits requirement would force Stage's
  commits to be signed). ADR-0001 cited this as a fragility of the git-file approach; it is not fully
  dissolved, only narrowed (single-writer, author's own branch). Confirm against the target repos'
  policies before adopting.

## ADR impact

- **Supersedes:** ADR-0001 (three-tier topology), ADR-0005 (SDK device-flow), ADR-0007 (loopback
  callback), ADR-0008 (GitHub-as-Stage-IdP), ADR-0009 (overview aggregation endpoint), ADR-0017
  (repo-access gate via app installation).
- **Amends:** ADR-0014 (`stage open` gains a PR-identity form and `OpenMode::Review`); ADR-0016
  (observe-only, with one user-confirmed checkout exception).
- **Reaffirms:** ADR-0018 (storyline diff is committed tree-to-tree). ADR-0003's *write-through
  principle* (no local copy of review state; GitHub is authoritative) survives — only the mechanism
  changes, from client→backend→GitHub to client→`gh`.
