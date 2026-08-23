# The review surface is gated, not deleted, until it ships

Status: accepted — 2026-08-23; scopes what ADR-0014, ADR-0018, ADR-0019, ADR-0022 §6, ADR-0024, ADR-0025 and ADR-0026 describe, without reversing any of them

Stage's engine covers the whole author→reviewer arc: the **Review** artifact, **Storyline** composition over chapters, **Publish**, read-only **reviewer entry**, and GitHub **verdicts**. Only one part of it is good enough to put in front of a user: the author's local **Self-Review** with the agent's **Debrief** folded in. So the current version **supports self-review/debrief only**, and every user-visible mention of the rest is hidden.

The whole review surface is switched off from **one flag** — `REVIEW_SURFACE_ENABLED` in `client/src/featureFlags.ts` — plus one refusal in `stage-cli`. Concretely, with the flag off:

- **App routes.** The `localStoryline` and `localReview` views are unreachable; a `Review`-mode open intent can't be honoured and falls through to Self-Review.
- **Branch table.** No storyline/draft chip, no GitHub PR column (it carries GitHub's *review decision*), no "Storyline" or "Discard review…" row actions. The remaining column is named **Self-review**.
- **Overview.** No "New review…" button or composer modal — that is the composer's only entry point (v6-light L7 M4) — and no "On GitHub · no local branch" section, whose every row exists only to be opened as a Review.
- **CLI.** `st open <pr-url>` **fails loud** (`StageError::Invalid`) instead of silently opening Self-Review; `st open` with no argument is unchanged.

## Why gated rather than deleted

The code is finished, tested, and intended to come back on — deleting it would trade a one-line change for a re-implementation, and would strand the ADRs above with no code to point at. Gating also keeps the hidden paths **type-checked and compiled**: the flag is typed `boolean` rather than the `false` literal precisely so TypeScript keeps checking the branches it disables, and the two orphaned `stage-cli` helpers carry `#[allow(dead_code)]` with a pointer here rather than being removed along with their tests.

The cost we accept: dead-but-live code, and a `cargo`/`tsc` surface slightly larger than what ships. That is cheaper than the alternative and is bounded by there being exactly one flag.

## What this does not change

Nothing below the webview moves. `stage-core` still derives Review status, staleness and ready-to-publish; the local store still holds draft Reviews; the `.stage/<branch>/` folder format is untouched; the sync engine still polls GitHub. A user who already has draft or published Reviews on disk keeps them — the rows simply render without their review chips, and nothing garbage-collects them.

Fail-loud (CLAUDE.md) governs the seam: where a gated capability can still be *asked for* from outside the app — the CLI's PR target — it refuses with a complete, user-facing sentence rather than degrading to the nearest working behaviour. Silently opening Self-Review when a PR was requested would be exactly the quietly-wrong result the convention forbids.

## Turning it back on

Flip `REVIEW_SURFACE_ENABLED` to `true` and restore the PR branch of `stage_cli::open` (its helpers are still there). Then revisit the docs that describe today's scope: `README.md`, the scope notes in `CONTEXT.md` and `docs/ARCHITECTURE.md`, and `docs/ROADMAP.md`.
