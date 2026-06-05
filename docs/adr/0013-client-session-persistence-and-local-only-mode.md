# ADR-0013 · Client session persistence + explicit local-only mode

**Status:** accepted
**Date:** 2026-06-04

## Context

The desktop client boots **signIn-first**: `client/src/App.tsx` starts on the SignIn screen and every downstream view is gated behind a signed-in `user`. Auth is purely in-memory — `AppState.auth: Mutex<Option<AuthSession>>` (`client/src-tauri/src/state.rs`), lost on every restart, so the author re-runs the GitHub OAuth loopback on each launch.

This contradicts two things:

1. **The glossary.** `CONTEXT.md` **Self-Review** says the client "can operate fully local-only during Self-Review; the device-flow login is triggered the first time the author hits Ready to share," and **Debrief** "requires no Stage authentication." The signIn-first app does not honor that — you cannot reach Self-Review without signing in.
2. **The driving feature.** The `self-review-debrief` skill wants to run **`stage open`** after writing a Debrief and have the GUI land the author **directly in Self-Review** for the current `(repo, branch)` — which must work whether or not a Stage session exists.

Two distinct axes were being conflated under "offline":

- **Auth axis** — the app runs with *no Stage session*; only local features work. **This is the axis we address here**, named **local-only mode**.
- **Connectivity axis** — the network/backend is unreachable (caching, retry, sync). **Explicitly out of scope.** No network-resilience work.

`Session` on the backend (`backend/apps/identity/models.py`) is long-lived: `token_hash`, `last_used_at`, `revoked_at`, **no expiry**. So a persisted token stays valid until explicitly revoked — there is nothing client-side to expire on a timer.

## Decision

Keep **`signIn` as the conceptual gate**, but make the session survive restarts and make "no session" a legible, explicit user choice rather than a dead end.

1. **Persist the session token to disk.** A new `SessionStore` (`client/src-tauri/src/session.rs`) mirrors `RecentsStore`: it reads/writes `session.json` in the Tauri app-data dir (`~/Library/Application Support/dev.stage.client/`). `AppState.auth` stays the runtime source of truth; the store is loaded into it at boot and written through on sign-in and logout. **Token at rest is plaintext JSON** — a deliberate MVP stopgap carrying a loud `TODO(keychain)`; the OS keychain (macOS Keychain via `keyring`) is the eventual target. This is *not* secure secret storage and is documented as such inline.

2. **Validate the persisted token at boot** via a new `auth_bootstrap` command: it calls `auth_me` with the seeded token and returns the `User` on success. A `401` (`api::Error::Unauthenticated`) means a dead session → clear it from memory **and** disk, fall back to signed-out. Any other backend error is surfaced verbatim (fail-loud) and the token is left on disk to retry next launch. There is **no client-side expiry timer** (the `Session` has no expiry).

3. **Add an explicit "Stay offline" choice** on the SignIn screen that enters **local-only mode**: the app runs with no session, backend-touching features disabled. Local-only is **not sticky** — it means "not signed in *yet*". It is never persisted; it is re-evaluated every launch, and any successful sign-in upgrades it to signed-in in place.

### Boot decision table

| Launch | Persisted valid session? | Result |
|---|---|---|
| Dock / Finder (no `(repo, branch)` context) | yes | Signed-in → repo picker → Workspaces. SignIn skipped. |
| Dock / Finder | no / invalid | **SignIn** screen, offering **"Stay offline"** → local-only → repo picker → Self-Review. |
| `stage open` (carries `(repo, branch)`) | yes | Signed-in, route straight to Self-Review for `(repo, branch)`. |
| `stage open` | no / invalid | **SignIn** screen (with "Stay offline"); the `(repo, branch)` context is carried so either choice lands directly in Self-Review, skipping the repo picker. |

**Note on `stage open` with no session:** the author chose to **show SignIn first** (with "Stay offline") rather than dropping silently into local-only. This trades a one-time cold-start click for a legible, non-degraded-by-surprise boot; after the first sign-in the token persists and every later `stage open` goes straight through. The `stage open` *plumbing* (how the CLI locates and launches the GUI — `bundle.active = false` today, no `.app`; single-instance argv forwarding) is **not** part of this ADR; it is a separate follow-up. This ADR covers only the auth model the GUI honors on boot.

**Local-only mode disables** anything that calls the backend (`require_token`): Workspaces overview, Ready to share, Publish. **It keeps:** repo picker / recents, Self-Review, Debrief, Review notes, branch toggle — all already local and auth-free.

## Considered alternatives

- **Option A — invert the root gate.** Boot always local-only; sign-in becomes lazy at the backend boundary; the dock landing moves from Workspaces to "repo picker → Self-Review". Rejected: a larger restructure that demotes Workspaces as the signed-in home and spreads the sign-in trigger across every backend call site.
- **Option B — keep signIn-first, add a local-only side-door only for `stage open`.** Rejected: makes local-only an invisible special case of one launch path rather than a first-class, user-chosen app state; doesn't fix the glossary contradiction for normal launches.
- **Silent local-only for `stage open` with no session.** Rejected by the author in favour of showing SignIn first (see note above) — silent entry into a degraded mode was judged less legible than one explicit "Stay offline" click.
- **OS keychain now (skip the plaintext stopgap).** Deferred, not rejected: it's the eventual target, but the `keyring` plumbing is larger than this PR; the plaintext file carries a loud `TODO(keychain)` until then, matching the existing `RecentsStore` precedent.

## Consequences

**Positive:**

- The app finally **honors the glossary**: Self-Review/Debrief are reachable with no session, via an explicit, legible choice.
- A returning author **skips sign-in** on every launch; the OAuth loopback runs once, not per-restart.
- Local-only being **non-sticky** keeps a single mental model — "signed in or not yet" — with no separate persisted offline flag to get stuck in.

**Negative:**

- **First local persistence of a secret.** The token sits in plaintext on disk until the keychain migration lands — a known, documented stopgap, not secure storage.
- **The inline-upgrade trigger is owed.** "Hitting Ready to share / Workspaces upgrades local-only to signed-in" is satisfied structurally (any sign-in promotes; signed-in screens stay gated) but has no concrete in-app button yet, because those surfaces aren't reachable from the local-only Self-Review screen today. The trigger attaches when they become reachable.
- **Boot does one network round-trip** (`auth_me`) before the signed-in UI appears; a transient backend failure at boot falls back to SignIn (token retained), which is the connectivity axis and out of scope to smooth over here.

## Reference

- `CONTEXT.md` — **Self-Review**, **Debrief**, **Local-only mode** (new), **Ready to share**.
- ADR-0011 (agent self-review is local + auth-free); ADR-0001 (no GitHub credentials on the client; only the Stage session token).
- `client/src-tauri/src/session.rs` (`SessionStore`); `client/src-tauri/src/recents.rs` (the persistence pattern mirrored).
- `client/src-tauri/src/commands.rs` — `auth_sign_in` (write-through), `auth_bootstrap` (boot validation), `auth_logout` (clear); `client/src/App.tsx` (boot + local-only routing); `client/src/screens/onboarding/SignIn.tsx` ("Stay offline").
- `backend/apps/identity/models.py::Session` (long-lived, no expiry).
