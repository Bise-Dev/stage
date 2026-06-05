# ADR-0014 · `stage open` — the CLI launches the GUI into Self-Review

**Status:** accepted
**Date:** 2026-06-05

## Context

The `self-review-debrief` skill writes a Debrief through the `stage` CLI, then today just *tells* the author to go look in Stage's Self-Review screen. We want it to **open Stage directly at the right position** — the Self-Review for the current `(repo, branch)`, showing the diff the agent narrated.

ADR-0013 already built the auth model this relies on (session persistence + local-only mode) and explicitly scoped itself to "the auth model the GUI honors on boot," deferring the *plumbing* to a follow-up. **This ADR is that follow-up.** It covers how the CLI launches/reaches the GUI and how the boot context is delivered — not the auth routing, which is ADR-0013's.

Constraints discovered:

- **`stage` is already the CLI binary** (`stage-cli`, the one the debrief skill drives). The GUI is a *separate* Tauri binary, not named `stage`. So a second `stage` shim on PATH (an earlier idea) would collide.
- **Auth/Self-Review is local and auth-free** (ADR-0011, ADR-0013, `CONTEXT.md`). Opening into Self-Review needs no Stage session.
- **`bundle.active = false`** in `client/src-tauri/tauri.conf.json` — there is no installed `.app` today, so nothing to launch.
- The debrief loop is **single-author, single-branch-under-review at a time** — multi-window side-by-side review is not a driving need.

## Decision

### 1. The existing `stage` CLI gains an `open` subcommand — the CLI *is* the launcher

`stage open` resolves the current repo root and **spawns the GUI binary**, handing it the repo root. One binary, one name; the debrief skill already holds `stage`. There is no separate PATH shim.

### 2. Transport: single-instance + direct-exec (not `open -a`)

`stage open` **direct-execs the GUI binary with argv** and returns (spawn detached; do not wait — the GUI runs indefinitely). `tauri-plugin-single-instance` deduplicates:

- **Cold start** — the spawned process *is* the primary. Its `setup` parses `std::env::args` → records an open-intent.
- **Warm start** — an instance is already running. The plugin forwards the new argv to the primary's single-instance callback → it records the intent **and emits an `open-intent` event** to the live webview; the second process exits.

Direct-exec is chosen over macOS `open -a Stage --args` because `open` **silently drops args when the app is already running**, which is exactly the warm-start path we depend on. Direct-exec delivers argv identically cold and warm.

### 3. Window model: single-instance, focus + navigate (not multi-window)

A running Stage is **brought to front and navigated** to Self-Review for the new `(repo, branch)`, switching the single global active repo (`AppState.active`). Back returns the author to where they were. We deliberately **do not** make active-repo/watcher per-window — the per-window-state refactor an earlier plan called "the bulk of the work" is dropped. Side-by-side review of two branches is a possible additive follow-up, not a current need.

### 4. Boot-context delivery: a persisted open-intent honored after the auth choice

Rust holds `AppState.pending_open: Mutex<Option<OpenIntent>>` (`OpenIntent { repo: PathBuf, mode }`, `mode` defaults to self-review). A `take_open_intent()` command hands it to the webview (cold), and the `open-intent` event pushes it (warm). On receipt, `App.tsx` does `setActiveRepo(repo)` and routes to Self-Review.

Per **ADR-0013's boot table**, the intent must **survive the SignIn screen**: a no-session `stage open` shows SignIn (with "Stay offline") first, and the retained intent makes *both* `onAuthenticated` and `enterLocalOnly` route to Self-Review with the repo pre-set, **skipping the repo picker** (rather than today's `→ openRepo`). A valid session routes straight through. The intent is *not* silently auto-resolved into local-only (ADR-0013 rejected that).

Only the **repo root** is passed — never the branch. The GUI opens that working tree and Self-Review reads the current branch from git itself; the Debrief is keyed by `(repo, branch)` the same way, so passing a branch could only disagree with the checked-out HEAD.

### 5. "The right position" seeds the base from the Debrief

When an open-intent lands and a Debrief exists for `(repo, branch)`, the Self-Review **base selector is seeded from the Debrief's stored `base`** (overriding the per-repo `localStorage` default *for that open*), so the author sees the same Base-scope diff the agent narrated.

### 6. GUI discovery + distribution

`bundle.active` is enabled so there is an installed GUI to launch. `stage open` locates the GUI binary by, in order: **`STAGE_GUI_BIN` env override** → the installed bundle location → a `client/target/{release,debug}/` **dev fallback** (so the whole loop is testable against a running `tauri dev` without installing). `just install` builds the bundle and links the `stage` CLI onto PATH.

### 7. Skill trigger

`self-review-debrief` runs `stage open` **after every successful `self-review set`** (fresh produce, and the regeneration at the end of address mode) — nowhere else. `stage open` **fails loud** itself (non-zero + stderr) per `CLAUDE.md`, but the skill treats an open failure as **non-fatal**: the Debrief is already stored, so it reports "ready" plus the open failure for manual recovery.

## Considered alternatives

- **A second `stage` PATH shim execing the GUI.** Rejected: collides with the existing `stage` CLI; the CLI is already in the skill's hand, so an `open` subcommand is strictly simpler.
- **`open -a Stage --args` / a `stage://` URL scheme.** Rejected: `open --args` drops args on warm start (breaks focus+navigate); a URL scheme is more moving parts and macOS-only.
- **Multi-window (a window per invocation).** Rejected for now: requires a large per-window active-repo/watcher refactor for a side-by-side need the debrief loop doesn't have. Additive later if needed.
- **Silent auto-local-only for a no-session `stage open`.** Rejected by ADR-0013 (show SignIn first; carry the intent).
- **Passing the branch in argv.** Rejected: redundant and can disagree with the checked-out HEAD; the GUI rediscovers it.

## Consequences

**Positive:**

- The debrief loop closes end-to-end: agent writes the Debrief → `stage open` → author is looking at exactly that diff, signed in or not.
- No new binary or PATH entry beyond the `stage` CLI the skill already uses; no per-window-state refactor.
- Warm and cold launches behave identically (single-instance + direct-exec).

**Negative:**

- **The bundle must now be built/installed** for real use (`bundle.active = true`, `just install`); dev rides the `target/` fallback.
- **Focus-steal:** `stage open` brings Stage to front; firing on every `set` (incl. address-mode regen) can yank focus while the author is elsewhere. Judged acceptable — the author invoked the agent and is awaiting it.
- **Single active repo repoints** on `stage open`; the prior screen is left behind (Back returns). The cost of dropping multi-window.

## Reference

- ADR-0013 (session persistence + local-only mode — the boot auth model honored here); ADR-0011 (agent self-review is local + auth-free).
- `CONTEXT.md` — **Self-Review**, **Debrief**, **Local-only mode**.
- `client/stage-cli/src/main.rs` (`open` subcommand); `client/stage-core/src/repo_key.rs::repo_root_from_cwd`.
- `client/src-tauri/src/lib.rs` (single-instance plugin, argv parse, `AppState`); `client/src-tauri/src/state.rs` (`pending_open`); `client/src-tauri/src/commands.rs` (`take_open_intent`, `set_active_repo`).
- `client/src/App.tsx` (intent routing through SignIn); `client/src/tauri.ts` (bindings + `open-intent` listener); `client/src/screens/selfReview/SelfReview.tsx` (base seeding).
- `client/src-tauri/tauri.conf.json` (`bundle.active`); `justfile` (`install`).
- `.claude/skills/self-review-debrief/SKILL.md` (the `stage open` trigger).
