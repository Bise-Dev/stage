# Workspace identity is a UUID with two lifecycle phases

**Status:** accepted

A **Workspace** is the backend's container for everything an author and reviewers work on around one body of changes. We identify it by a backend-minted `uuid4`, **not** by `(repo, pr_number)`. The same row exists in two phases:

- **`local`** (`pr_number IS NULL`) — author has started a local-review session for a branch; storyline + AI-doc + drafts are being composed; no github PR yet.
- **`public`** (`pr_number` set) — github PR has been opened; the same row is now the shared workspace for reviewers.

This matters because the UI's "Local review" bucket needs a backend home from the moment the author starts composing; the work survives across sessions and browser-cache clears; and "Open PR" becomes a state transition on an existing row, not a workspace creation.

## Considered Options

- **PR-scoped only** (the original v1/v2 spec): backend Workspace exists only after PR. Rejected because the local-review state would have to live in the UI's localStorage and would be lost on cache clear; transporting it to the backend at Open-PR moment also re-creates "two entities in disguise" with no real benefit.
- **Two-entity model** (`DraftWorkspace` → `Workspace` on Open-PR): explicit transition with two tables. Rejected because the data is the same shape in both phases and the transition would require copying rows; one mutable row is simpler.

## Consequences

- Workspace primary key changes to UUID; all FKs to Workspace use UUID.
- Uniqueness is split: `(repo, head_ref)` while local, `(repo, pr_number)` once public.
- The orchestration endpoint to open a PR (`POST /api/workspaces/{uuid}/open-pr`) **mutates** the existing row rather than creating one.
- Authz: storyline edit / AI-doc ingest gates were "PR author identity". In `local` phase there is no PR author yet — replace with "workspace creator identity". When the workspace becomes `public`, the gate should agree (the PR author on github IS the workspace creator, because the creator is the one who called `open-pr`).
