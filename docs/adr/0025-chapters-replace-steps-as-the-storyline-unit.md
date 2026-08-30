# Chapters replace steps as the storyline unit

Status: accepted

A Storyline was an ordered list of per-file **steps**, each carrying its own intro — which made authoring cost scale with the number of changed files (28 intros for a 28-file branch) and pushed authors toward boilerplate. We decided the narrative unit is now the **Chapter**: a titled, author-ordered group of changed files with **one intro**; files inside a chapter carry no per-file title or intro. Files left out of every chapter still publish, rendered as an automatic alphabetical "Everything else" section at the end, and never block the publish gate (which becomes: ≥1 chapter, every chapter titled with a non-empty intro, no stale chapter — the stale and uncommitted-work gates from ADR-0024 carry over unchanged). The Debrief adopts the same shape so it seeds a Storyline 1:1.

## On-disk format (v2) and the deliberate hard break

`.stage/<branch>/` now holds `review.toml`, one file per chapter under `chapters/` (zero-padded numeric prefix for order; TOML frontmatter carries the title and the ordered file list; the body is the markdown intro), and `pr.md` (the PR description draft, kept so updates can `gh pr edit --body-file`). The previous one-file-per-step `steps/` layout is **not read** — no migration shim. There is exactly one live artifact in the old format and we chose to discard it rather than carry a legacy reader forever; per the fail-loud rule, encountering a legacy folder raises "unsupported legacy storyline format" instead of rendering partially.

## Considered options

- **Chapters + optional per-step intros** — rejected: two levels of narration to author and render, and the chapter design explicitly states files get no step name.
- **Legacy read shim (step → one-file chapter)** — rejected as unnecessary permanent surface for a single disposable artifact.
