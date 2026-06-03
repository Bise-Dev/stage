# Implementation plan — Cycle 1: Debrief + Review-note loop

Status: **planned, not started.** Branch: `feat/self-review-debrief`.

Domain & rationale are captured elsewhere — read these first, this file does not repeat them:

- `CONTEXT.md` → **Debrief**, **Review note**, **Self-Review**, **Stale step**.
- `docs/adr/0011-agent-self-review-is-local-cli-not-backend.md` → the architectural decision (local CLI + app store, not backend/MCP) and the rejected alternatives.

## What we're building (one paragraph)

A second, **local, auth-free** review cycle: a coding agent authors a **Debrief** (ordered steps over its Base-scope diff, each with an agent-written intro) into a local SQLite store via a new `stage` CLI; the author reviews it on the enriched Self-Review screen in the Tauri app and leaves **Review notes** (diff-anchored); the agent re-runs the skill, reads `open` notes, fixes the code, marks them `addressed` with a reply, and regenerates the Debrief. The existing backend Workspace/Storyline and their auth are untouched. Promotion (Debrief → Storyline) is **deferred**.

## Decided details (locked 2026-06-01)

- **Store:** one SQLite DB at a **Tauri-independent** stable path (compute via a `directories`-style app dir named `stage` — NOT Tauri's identifier-based `app_data_dir()`, or the CLI can't locate it). Rows keyed by `(repo_owner, repo_name, branch)`, derived from the `origin` remote + current branch — same key shape as the backend Workspace (eases future promotion). Fallback when no GitHub remote: hash of the canonical repo root.
- **Debrief `set` schema (stdin):** `{ "base": "main", "steps": [{ "file": "...", "intro": "md", "order": 0 }] }`; `order` optional (array index). Files not in the current Base diff → **reject loudly** (fail-loud per `CLAUDE.md`).
- **Review note:** `id` = UUID (app-minted); anchor `{ file, line_start?, line_end? }`; `status ∈ {open, addressed, resolved}`; `agent_reply` text; timestamps. **`outdated` is computed**, never stored (like Workspace state / Stale step).
- **Agent trigger:** human-invoked only; the skill reads `notes --status open` and self-selects produce vs address mode. No hooks.

## Crate move (prerequisite, lands in PR1)

Introduce a **cargo workspace** under `client/`: existing `src-tauri` + new `stage-core` (SQLite store + domain + the Tauri-independent git-diff helpers) + `stage-cli` (the `stage` binary). The CLI must not compile Tauri — hence the extraction. `src-tauri/src/git.rs` re-exports from `stage-core` so the app keeps building.

## PRs

1. **`stage-core` + store + path keying.** Workspace setup; `rusqlite` (bundled) store + migrations; `repo_key_from_cwd()`; domain types; read/write fns. `stage-cli` skeleton: `set` / `show` / `clear`. Tests: store round-trip, repo-key derivation.
2. **Base-diff reuse + `files` + validation.** Move git2-only diff code (`self_review_diff`, `ChangedFile`, patch/line-count) from `git.rs` into `stage-core::diff`; re-export. Add `stage self-review files [--base]`. `set` validates each `file` against the Base diff, rejects unknowns. Tests: diff parity, rejection.
3. **Review-note lifecycle (agent side).** `stage self-review notes [--status …]` (JSON, computed `outdated`); `stage self-review address <id> --reply "…"` (open→addressed; loud on unknown/resolved). Tests: transitions, outdated flag.
4. **The skill** (`.claude/skills/self-review-debrief/`, built per `write-a-skill`). On invoke: open notes present → address mode (fix → `address` each → regenerate via `files`→`set`); none → produce mode. Docs: JSON schema, intro guidance, fail-loud, never invent files. *(needs PR1–PR3)*
5. **Tauri commands.** `self_review_debrief_get`, `self_review_notes_list`, `self_review_note_create/resolve/reopen` via `stage-core` against AppState's active repo+branch. Extend `watcher.rs` to watch the DB → emit `debrief-changed`. `tauri.ts` wrappers. *(needs PR1; parallel with PR4)*
6. **Enrich `SelfReview.tsx`.** Debrief rail (steps + agent intros) driving the existing diff; wire per-line `Thread` UI to Review-note create/read; show status + agent reply + resolve/reopen + outdated flag; live-refresh on `debrief-changed`. *(needs PR5)*

**Sequencing:** PR1→PR2→PR3 sequential; PR4 & PR5 parallel after PR3; PR6 after PR5.

**Deferred:** promotion bridge (Debrief → Storyline at Ready-to-share); MCP wrapper over the CLI core.

## Verification

Each PR ends with `just pre-commit`; PRs touching Rust logic or the UI run `just verify` (adds clippy + cargo test + pytest). Fix lints/typecheck before declaring done (per `CLAUDE.md`).

---

> ⚠️ Architectural plan — have a qualified engineer review it before building, especially the two-writer SQLite concurrency (CLI + app) and the shared store-path derivation (the one place CLI/app must agree).
