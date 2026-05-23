# Stage — Local PR Review

Backend + UI that augments github pull-request review with an author-defined **Storyline** (ordered files with intent comments) and a structured review flow. Backend is a Django REST service. The **Client** is a separate, non-browser application built by another developer (form factor TBD: desktop / TUI / IDE plugin). Github is the source of truth for github-domain data; the backend stores only tool-native augmentation. The Client owns its own ephemeral state (e.g., which file the user is currently viewing) — the backend does not persist anything that is purely UI navigation state.

## Language

### Workspace + lifecycle

**Workspace**:
The backend container for one body of changes under review. Identified by a `uuid4`. Holds storyline, intros, AI-doc, and per-user drafts. Exists in two phases (see **Phase**).
_Avoid_: "session", "review" (overloaded), "draft workspace" (the same Workspace in `local` phase IS the draft).

**Phase**:
A workspace is in `local` phase while `pr_number IS NULL` (author still composing) or `public` phase once a github PR is opened against it (`pr_number` set).
_Avoid_: "draft" (collides with PR draft state and DraftReview), "mode" (we use "mode" for author/reviewer perspective).

**Mode**:
A workspace presents in `author` mode to the user who created it (or who is the PR author once `public`) and in `reviewer` mode to everyone else. Computed per request, not stored.
_Avoid_: "role" (we don't have a role system).

**Local state**:
Sub-state of a workspace while in `local` phase. Stored, advanced by explicit user action.
- `reviewing` — author is visualizing the diff; not yet committed to sharing. UI label: "Draft".
- `sharing` — author clicked "Ready to share"; now in the storyline-composition flow leading to Open PR. UI label: "Ready to share".

Transitions are one-way in v1 (`reviewing` → `sharing`, never back). Once the workspace becomes `public`, `local_state` is `NULL` and irrelevant.

**Storyline complete** (computed):
Within `sharing`, the boolean signal that gates the "Open PR" CTA. True iff the workspace has ≥1 StorylineFile AND every StorylineFile has a non-empty intro. Never stored.
_Avoid_: "storyline ready", "ready to open" (overloaded).

**Open PR**:
The state transition that calls github to create the PR and sets `pr_number` on the existing workspace row. Author-only action. UI label: "Open PR on GitHub".
_Avoid_: "create PR" (collides with the github-side creation; we open ours, github creates theirs as a side effect).

### Storyline

**Storyline**:
The author-defined ordered list of files reviewers should walk through, with per-file intent comments. One per Workspace.
_Avoid_: "outline" (UI button label for the dropdown is "Outline" but the noun is "Storyline").

**Step** / **StorylineFile**:
One entry in the Storyline: a file path + an order index + an optional **title** + an optional **intro**. "Step" is the user-facing word; `StorylineFile` is the DB table.
_Avoid_: "item", "row" (mixed with UI rows).

**Intro**:
The author's intent comment for one storyline step — what the reviewer should look for or understand about this file. Markdown. Stored per StorylineFile.
_Avoid_: "note" (UI says "Your note:" but that's the rendered preview of an Intro), "description", "comment" (collides with the comment family).

**IntroComment**:
A threaded, tool-native discussion attached to one Intro. Reviewer reacts to or questions an Intro without it becoming a github comment. The PR author can resolve threads.
_Avoid_: "intro reply" (replies are themselves IntroComments via parent_fk).

### Comments

**Draft comment** / **DraftComment**:
A comment composed in the UI before it is published to github. Lives in the backend, owned by one user, deleted after publish. Has a **category** (`comment | blocking | suggestion | nit`) that is **not** sent to github.
_Avoid_: "pending comment" (sounds like a status), "queued comment".

**DraftReview**:
The wrapper around a user's set of DraftComments + an optional review body + an event (`COMMENT | APPROVE | REQUEST_CHANGES`). One per `(workspace, user)`. Submitted as a github Review on publish-all.

**Github comment**:
Any comment that lives on github. We never mirror them — they are read via proxy. Comes in two github-native kinds: issue comments (PR-level) and review-line comments (anchored to a diff line).
_Avoid_: "published comment" (true but redundant — if it's on github it's published).

**IntroComment** vs **DraftComment** vs **Github comment** are three distinct things and must not be conflated:
- IntroComment ↔ a storyline step's intent (tool-native, never on github)
- DraftComment ↔ pre-publish staging of a future github comment (transient backend)
- Github comment ↔ what reviewers see on github (never in our DB)

### Review

**Local review (phase)**:
The UI flow the author goes through to visualize their own diff and compose the storyline before opening the PR. The corresponding workspace phase is `local`.
_Avoid_: "local-only review" (sounds like a feature that bypasses github — it isn't).

**Storyline review**:
The UI flow a reviewer goes through, walking the storyline step-by-step.
_Avoid_: "reading flow".

**Publish review** (verb) / **submit review**:
The action of pushing the user's DraftReview + DraftComments to github as a single github Review object.
_Avoid_: "send", "post" (post is for individual comments).

**Review** (the noun):
Ambiguous on its own — always qualify: "github Review object", "draft review", "storyline review (flow)".

## Relationships

- A **Workspace** has one **Storyline** (created lazily on first storyline write or via Open PR).
- A **Storyline** has many **StorylineFile**s (= **Step**s).
- A **StorylineFile** has many **IntroComment**s, threaded by parent_fk.
- A **Workspace** has at most one **DraftReview** per user, and many **DraftComment**s per user.
- A **Workspace** progresses `local` → `public` exactly once (Open PR). It never goes back.
- A **Workspace** in `public` phase points to exactly one **github PR** (`pr_number`).

## Example dialogue

> **Dev:** "When I start a new **Workspace**, does the **Storyline** exist immediately?"
> **Domain expert:** "The Workspace is created in `local` phase. The Storyline is created the first time you save one (or implicitly when you Open PR with a non-empty payload)."
>
> **Dev:** "If a reviewer adds an **IntroComment** during the `local` phase, can the **PR author** see it before Open PR?"
> **Domain expert:** "During `local`, only the **creator** can see the workspace. There are no reviewers yet. Once it goes `public`, reviewers can attach IntroComments to the Intros they care about."
>
> **Dev:** "What's the difference between a **DraftComment** with category `blocking` and a github review with event `REQUEST_CHANGES`?"
> **Domain expert:** "A DraftComment is one anchored comment, pre-publish. `blocking` is a tool-local UI tag that lives in our DB only — it never reaches github. The github Review's `REQUEST_CHANGES` event is the entire submitted review's verdict and is what actually blocks the PR on github."

## Flagged ambiguities (resolved)

- **"workspace"** was used to mean both "the backend row" and "the UI's local-review composition area". Resolved: same thing, different phases (`local` vs `public`).
- **"review"** was used for 6 distinct concepts. Resolved by qualifying every use: github Review, DraftReview, local review (phase / UI flow), storyline review (UI flow), publish review (action).
- **"comment"** was used for IntroComments, DraftComments, and github comments. Resolved: three distinct entities, kept separate by name.
- **"draft"** appears in `DraftReview`, `DraftComment`, github's PR `draft: bool`, and the UI's "Save draft" CTA. Each usage is now qualified by its noun.
