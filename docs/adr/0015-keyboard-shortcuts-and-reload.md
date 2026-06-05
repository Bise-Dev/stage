# ADR-0015 · Keyboard shortcuts are a first-class pattern; ⌘R/Ctrl+R reloads

**Status:** accepted
**Date:** 2026-06-05

## Context

We want a "reload the data on this screen" keyboard shortcut, starting with the
Workspaces home page (where the GitHub-backed overview and local-branch list can
silently go stale). The broader goal is to stop adding shortcuts the way the app
does today — every screen hand-rolling its own `window.addEventListener('keydown', …)`
(SelfReview's ⌘F/Escape, Composer's ⌘-Enter, various element-level handlers).
That ad-hoc style duplicates platform handling, `preventDefault`, ignore-while-typing
logic, and listener cleanup at every call site, and there is no single place to see
what chords exist.

Constraints discovered:

- **The app runs in a Tauri (WKWebView) webview.** ⌘R/Ctrl+R is the native browser
  reload — left unhandled it hard-reloads the webview and wipes all app state (the
  current `view`, scroll, in-flight edits). Any reload binding must intercept it.
- **Routing is a `view` state machine in `App.tsx`**, not a router — there are no
  route components to hang per-route shortcut config on.
- **The backend already serves fresh data.** `repo_overview`
  (`backend/apps/workspaces/selectors.py`) reads Workspaces from its own DB and pulls
  all GitHub PR data live through `GithubGateway`, which is plain `httpx` with no
  cache, no ETags, and no conditional requests. A client reload that re-calls the
  overview genuinely re-pulls current data — no backend cache-busting is needed.
- **Workspaces already has a "Fetch" action** (`runFetch`: `git fetch` → `repoSummary`
  → `loadBranches` → `loadOverview`) with a `fetching` flag driving a "Fetching…"
  label and a disabled button.

## Decision

### 1. A `useShortcut` hook + a canonical `shortcuts.ts`, not a registry/provider

Shortcuts become a first-class pattern via a single reusable hook,
`useShortcut(shortcut, handler, opts)`, that owns: platform normalization, matching the
chord, `preventDefault`, an opt-in `ignoreWhileTyping`, and listener cleanup. Canonical
chords live in one `shortcuts.ts` (e.g. `RELOAD`). A screen opts in with one line —
`useShortcut(RELOAD, runFetch)` — and never touches raw `keydown` again.

A central `ShortcutProvider` + registration registry (which would enable a discoverable
"?" cheatsheet) was **rejected for now**: it is more infrastructure than the current need
justifies, and the hook can be wrapped by a registry later without changing call sites.

### 2. ⌘R on macOS, Ctrl+R elsewhere — the "mod" modifier is platform-aware

`RELOAD` is `{ key: 'r', mod: true }`, where `mod` resolves to **⌘ (metaKey) on macOS and
Ctrl (ctrlKey) on Windows/Linux**, matching each OS's reload convention. The hook
requires exactly that modifier (and rejects the other, so ⌘R on macOS isn't also matched
as a Ctrl+R binding) and `preventDefault()`s the match to suppress the webview's native
reload.

### 3. Reload means the screen's most-thorough refresh — on Workspaces, the full Fetch

⌘R on Workspaces is a keyboard alias for the existing `runFetch` (`git fetch` + reload
branches + reload overview), **not** a lighter re-pull. The author's mental model is
"refresh everything I'm looking at, including new remote work." It reuses the existing
`fetching` flag for visual feedback and **guards re-entry** (⌘R while already fetching is
a no-op — no stacked `git fetch`es).

### 4. Reload fires regardless of focus

⌘R/Ctrl+R is an unambiguous chord that is never typed as text, so it fires even when a
text input/textarea has focus (matching native browser reload). `ignoreWhileTyping` is a
hook opt reserved for future plain-key shortcuts (e.g. `r`, `?`) that *would* clash with
typing.

### 5. Workspaces only, for now

Only the home page binds `RELOAD` initially (the stated main use case). Other screens
(Storyline's `load`, SelfReview's `fetchDiff` — though SelfReview already auto-refreshes
via a filesystem watcher) are a one-line `useShortcut(RELOAD, …)` add when wanted. The
existing ad-hoc handlers (SelfReview ⌘F/Escape) are left in place; migrating them onto
the hook is optional follow-up.

## Considered alternatives

- **Central `ShortcutProvider` + registry.** Rejected for now: more up-front
  infrastructure than warranted; the hook is wrappable by a registry later without
  touching screens. Reconsider when a discoverable cheatsheet is wanted.
- **⌘R/Ctrl+R reload-only (no `git fetch`), keeping Fetch as the heavier action.**
  Rejected: the author wanted ⌘R to be the thorough refresh, and a second nearly-identical
  refresh affordance is confusing.
- **Ctrl+R literally on all platforms.** Rejected: ⌘R is the mac convention and, left
  unbound, would still trigger the native webview reload and wipe state.
- **Suppress reload while typing.** Rejected: the chord can't be typed as text, and
  suppressing it mid-edit is surprising versus native behavior.

## Consequences

**Positive:**

- New shortcuts are a one-liner; platform/`preventDefault`/cleanup logic lives in one
  hook, and canonical chords in one file.
- The native webview reload (which would wipe app state) is intercepted.
- Reload reuses the existing fetch path, flag, and feedback — no new UI or backend work.

**Negative / to verify:**

- **Native menu accelerator risk.** No menu is configured (no Rust menu, none in
  `tauri.conf.json`), so `preventDefault` on the JS handler is expected to fully suppress
  the reload. But Tauri v2 may inject a default macOS menu; if it carries a native ⌘R
  accelerator it bypasses JS and must be stripped/overridden in the Rust menu setup.
  **Confirm empirically:** press ⌘R against the running app and verify the webview does
  not hard-reload.
- The existing ad-hoc handlers are not yet migrated, so two styles coexist until a
  cleanup pass.

## Reference

- `CONTEXT.md` — **Workspace state**, **Self-Review** (the screens whose data reloads).
- `client/src/lib/shortcuts.ts` (chord definitions), `client/src/lib/useShortcut.ts` (the hook).
- `client/src/screens/workspaces/Workspaces.tsx` (`runFetch`, `fetching` flag — the reload target).
- `backend/apps/workspaces/selectors.py::repo_overview`; `backend/apps/github_proxy/gateway.py` (live, uncached GitHub reads — why a client reload gets fresh data).
