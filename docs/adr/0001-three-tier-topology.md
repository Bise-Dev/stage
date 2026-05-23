# ADR-0001 · Three-tier topology: client ⇄ Stage Backend ⇄ GitHub

**Status:** accepted
**Date:** 2026-05-23

## Context

Stage augments github's PR-review surface with author-defined narrative (storyline) and tool-native discussion (intro comments). To deliver that, three entities must coordinate:

1. The **Local Client** (Tauri desktop app) where authors compose and reviewers walk.
2. **GitHub**, which owns the source of truth for PR state, file diffs, reviews, comments, branches, repositories.
3. **Stage-native data** (Workspace, Storyline, IntroComment) that has no github counterpart and needs a real home.

Two-tier shape was on the table: client talks to github directly + persists Stage-native data in git refs or branch files. We rejected it.

## Decision

A strict three-tier shape with a one-way edge between layers:

```
Local Client  ⇄  Stage Backend  ⇄  GitHub
```

- The **Local Client never talks to github directly.** Its only network peer is the Stage Backend.
- The Local Client has **no github credentials**. github OAuth tokens are held exclusively by the Stage Backend; the client authenticates only to the Stage Backend (with a Stage Bearer session token from the device flow).
- All non-git data the client needs comes from one of two sources: local git operations, or the Stage Backend API (which aggregates Stage-owned data with github data brokered on the user's behalf).
- The Stage Backend owns the Storyline, IntroComment, and any other Stage-native data.
- Review actions (comments, approve, request-changes) are **write-through** today (see ADR-0003): the client posts to the Stage Backend, which writes them as native github review activity in the same request cycle. Moving to a local-first sync model is a roadmap goal, not a POC concern.

## Considered alternatives

- **Two-tier (client + github only)** with Storyline stored as a JSON file in the PR branch. Rejected:
  - Storyline becomes a git artifact that mutates with reviewer activity — branch-protection rules / signed-commit policies make this fragile.
  - Cross-user transport on an evolving artifact means race conditions on every push.
  - Reviewers without push access cannot edit it; authors get "stale storyline" warnings on every reviewer comment.
  - github credentials would live on every client, multiplying token-exposure surface.

- **Two-tier with git refs (not files)**. Less fragile than files but still requires every client to be auth'd against github + git push gymnastics for reviewer-side state changes. Same cross-user race problems.

## Consequences

**Positive:**
- One credential surface: the Backend holds the github token; clients hold only a Stage session token they can revoke.
- One write-funnel: review-actions-sync-to-github is enforced in a single place.
- Stage-native data has a real home (Postgres) that survives client cache clears and is shared cross-user.
- Future server-side features (webhooks, push, cache, analytics) attach cleanly because the Backend is already in the middle.

**Negative:**
- We own a server at POC stage (operational cost, on-call surface).
- No offline github fallback for the client — if the Backend or github is unreachable, review-time work blocks.
- An additional network hop for every read that would otherwise be a direct github call.

The first two are accepted trade-offs. The third is mitigated long-term by per-route ETag caching (see roadmap) and by the fact that the storyline read (the hot path for review) is mostly local data.
