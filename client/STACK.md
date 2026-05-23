# Client stack

Implementation choices for the local client. Open to revision; not in CONTEXT.md because these are stack decisions, not language.

## Shell
- **Tauri 2** — desktop shell, Rust on the system side, webview for UI.

## Frontend
- **React 19** + **Vite** + **TypeScript** — chosen for ecosystem fit with our diff and PR-review needs. macOS-native feel comes from CSS, not from a UI kit.

## Diff rendering
- **`@git-diff-view/react`** — provides a GitHub-style diff display with first-class line-widget support, which we need for per-line comment threads and storyline anchors. (We had a prior tool using `diff2html`; we are deliberately not carrying that forward because innerHTML-string output makes line-anchored comments awkward.) Revisitable.

## Git access
- **`git2-rs`** (libgit2) in the Rust side, exposed to the webview via narrow Tauri commands. Read-only diff/branch/blob/log operations for now; fetch later.

## File watching
- **`notify` + `notify-debouncer-mini`** in the Rust side — fires events when the working tree or refs change so the Self-Review view stays live without manual refresh.

## Backend communication
- All calls to the Stage Backend go **through the Rust side** via Tauri commands; the webview never speaks HTTP to a remote host directly. The Rust side uses `reqwest` (or equivalent) and is the future home of the local-first sync engine described in `docs/ROADMAP.md`.
- The client has **no GitHub credentials**. The only secret it holds is the Stage session token, stored in the OS keychain via `tauri-plugin-keyring` (or `keyring-rs`).

## Project layout
- Single Cargo crate under `src-tauri/` (the default Tauri scaffold). Not a Cargo workspace. If a shared `stage-core` crate is needed when the backend lands, we restructure then; not paying for that flexibility today.

## Tooling
- **Package manager**: Bun. One lockfile (`bun.lock`).
- **Lint / format**: Biome. One config, one binary, both jobs.
