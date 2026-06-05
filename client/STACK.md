# Client stack

Implementation choices for the local client. Open to revision; not in CONTEXT.md because these are stack decisions, not language.

## Shell
- **Tauri 2** — desktop shell, Rust on the system side, webview for UI.

## Frontend
- **React 19** + **Vite** + **TypeScript** — chosen for ecosystem fit with our diff and PR-review needs. macOS-native feel comes from CSS, not from a UI kit.

## UI primitives & components
- **shadcn/ui on top of Radix primitives** — copy-paste components we own as source; Radix gives accessibility + unstyled behaviour; the look stays ours. Picked over MUI / Ant / Chakra, which fight us on chrome. Requires Tailwind. Pulled in lazily — first onboarding screens did not need any shadcn components yet, so it's not installed.
- **Tailwind CSS v4** (`@tailwindcss/vite`) — utility layer that shadcn assumes; configured via `@import "tailwindcss"` in `src/styles.css`. Design tokens (palette, radii, shadows) live as plain CSS custom properties on `:root` rather than in the Tailwind theme — easier 1:1 parity with the design prototype, and components reference them via `var(--token)` in inline styles.

## Pickable libraries (install when first used; documented here so the choice is settled)
| Need | Library |
| --- | --- |
| Diff viewer | `@git-diff-view/react` (preferred over `react-diff-view`; supports split/unified and per-line slot for our own comment layer) |
| Syntax highlighting inside diffs | `shiki` (VS Code engine; same themes) |
| Storyline drag-reorder | `@dnd-kit` |
| Resizable panels (3-pane layouts) | `react-resizable-panels` (also what shadcn uses) |
| Command palette | `cmdk` |
| Markdown (PR descriptions, intros, comments) | `react-markdown` + `remark-gfm` |
| Toasts | `sonner` |
| Client state | `Zustand` (right size for a desktop app — Redux is overkill) |
| Forms | `react-hook-form` + `zod` |

## Diff rendering
- **`@git-diff-view/react`** — provides a GitHub-style diff display with first-class line-widget support, which we need for per-line comment threads and storyline anchors. (We had a prior tool using `diff2html`; we are deliberately not carrying that forward because innerHTML-string output makes line-anchored comments awkward.) Revisitable.

## Diff-with-inline-comments widget
- Roll our own thin wrapper around `@git-diff-view`'s per-line slot API. Existing libraries render diffs fine but model "comments anchored to a line range + threaded replies + draft state" poorly. We own this surface.

## Git access
- **`git2-rs`** (libgit2) in the Rust side, exposed to the webview via narrow Tauri commands, for read-only diff/branch/blob/log/remote operations. Writes (commit/push) stay out of scope.
- **Network git (`fetch`) shells out to the system `git` binary**, not libgit2. The vendored libgit2 build has no TLS/SSH transport ("unsupported URL protocol"), and the system git transparently uses the user's own credentials (ssh-agent, credential helpers, proxies). Stage holds no GitHub credentials of its own — fetch is a plain local git-transport op. Deliberate split from the git2-rs-for-everything line; revisit if we ever want a libgit2 build with bundled TLS.

## File watching
- **`notify` + `notify-debouncer-mini`** in the Rust side — fires events when the working tree or refs change so the Self-Review view stays live without manual refresh.

## Persistent client settings
- **`tauri-plugin-store`** — small key/value store for client-side flags that should survive restarts but don't belong in the backend (e.g. the `onboarded` flag that controls whether the sign-in screen is shown on startup). Recents and the active-repo lock continue to live in their own JSON file under `app_data_dir`, separate from this store.

## Backend communication
- All calls to the Stage Backend go **through the Rust side** via Tauri commands; the webview never speaks HTTP to a remote host directly. The Rust side uses `reqwest` (or equivalent) and is the future home of the local-first sync engine described in `docs/ROADMAP.md`.
- The client has **no GitHub credentials**. The only secret it holds is the Stage session token, stored in the OS keychain via `tauri-plugin-keyring` (or `keyring-rs`).
- **TLS provider**: `reqwest`'s `rustls` feature is selected; rustls 0.23 picks `aws-lc-rs` as its default crypto provider. `aws-lc-sys` ships pre-built binaries for macOS (arm64 + x86_64), so no native toolchain is needed on the client's primary target. Other targets (Linux musl, BSD) may require `cmake` + a C compiler at build time.
- **Backend URL configuration**: the SDK constructor (`api::Client::new`) takes `base_url` as a `&str` argument — the SDK does not pick a config story. Each consumer chooses its own. `examples/auth_smoke.rs` and any future CLI read `STAGE_BACKEND_URL` from the env (default `http://localhost:8000`); the future Tauri commands slice will read from `tauri.conf.json` and plumb through `AppState`. The env-var name `STAGE_BACKEND_URL` is the shared convention across non-Tauri callers.

## Activity log (dev-only debug panel)
A read-only, structured event stream for inspecting what the app is doing at runtime — HTTP calls, git ops, command invocations, webview console output, and raw Rust events. **Dev-only**: every piece is gated behind `#[cfg(debug_assertions)]` (Rust) / `import.meta.env.DEV` (webview), so a release build carries no ring buffer, no IPC commands, and no UI. Decisions below were settled in a `/grill-with-docs` session.

- **Name**: *Activity log* (not "Terminal"/"Console"/"Debug log") — it's an observability surface, not a shell.
- **Shape**: read-only structured event stream. No `xterm.js`, no interactive shell — nothing the user can type into.
- **Placement**: a bottom-docked, resizable drawer inside the main window, built with **`react-resizable-panels`** (the resizable-panels pickable above — this is its first use). The whole app sits in the top panel; the drawer is the bottom panel, mounted only while open.
- **Toggle**: `` Cmd+` `` on macOS (`` Ctrl+` `` cross-platform). No visible affordance anywhere — it's a developer shortcut, deliberately undiscoverable to end users.
- **Source of truth**: a Rust-side ring buffer in `AppState` (`activity_log.rs`), **2000 entries, drop-oldest**. Always-on from app start, survives webview reload, **in-memory only** — no disk mirror, no persistence across `Cmd+Q`.
- **Instrumentation**: a single `tracing_subscriber::Layer` (level ≥ DEBUG, filtered to `stage_client_lib`) feeds the ring. Pills are classified by the layer:
  - `http` — target starts with `stage_client_lib::api`; one `tracing::info!` per request emitted by the wrapper in `api::Client::send` (method, url, status, duration_ms).
  - `git` — target starts with `stage_client_lib::git`; `tracing::info!` callsites inside `git.rs`.
  - `cmd` — a span with field `pill = "cmd"`, via `#[cfg_attr(debug_assertions, tracing::instrument(fields(pill = "cmd")))]` on each `commands.rs` handler; the layer reads the span field on close and records its duration.
  - `webview` — pushed in from the webview via `activity_log_push` (the `console.*` overrides and the top-level `ErrorBoundary`); `target = "console"`.
  - `rust` — catch-all for any other `stage_client_lib` event.
- **Redaction (a-narrow)**: the layer hard-redacts only fields whose key is `authorization` (case-insensitive) to `[redacted]`; the auth token never enters a log field (the HTTP wrapper logs method/url/status, never headers). Everything else — URLs, bodies, git output, errors — is shown raw. The boundary is documented at the redactor callsite.
- **Tauri surface** (all `#[cfg(debug_assertions)]`):
  - `activity_log_snapshot` (webview → Rust) — returns the full ring on panel open.
  - `activity_log_push` (webview → Rust) — for the `console.*` overrides and `ErrorBoundary`.
  - `activity_log_clear` (webview → Rust) — empties the ring.
  - event `activity_log:event` (Rust → webview) — streams each new entry while the panel is open.
- **Export**: one **Copy as JSONL** button (clipboard, current filtered view, redaction already applied in Rust) and a **Clear** button. No "Save to file".
- **UI**: rows show timestamp, level pill, source pill, target, message, optional `duration_ms`, and expand to the full `fields` map + error. Filters: multi-select source pills, a level filter (default `INFO+`, toggle to include `DEBUG`), and a substring search over message + field values. Drawer height is persisted across restarts via `tauri-plugin-store` (key `activity_log.drawer_size_pct` — panels size in percent).

## Project layout
- Single Cargo crate under `src-tauri/` (the default Tauri scaffold). Not a Cargo workspace. If a shared `stage-core` crate is needed when the backend lands, we restructure then; not paying for that flexibility today.

## Tooling
- **Package manager**: Bun. One lockfile (`bun.lock`).
- **Lint / format**: Biome. One config, one binary, both jobs.
