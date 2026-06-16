# ADR-0021 · Local Client SDK hand-rolls the device-flow vocabulary

**Status:** superseded by [ADR-0007](./0007-github-app-user-to-server-loopback.md) (2026-05-26)
**Date:** 2026-05-24

## Context

The Local Client needs an SDK to call the Stage Backend's four authentication endpoints (`/api/v1/auth/device/start/`, `/device/poll/`, `/me/`, `/logout/`). The most user-facing part of the SDK is the device-flow polling loop, which has to map GitHub's RFC 8628 terminal-error vocabulary (`authorization_pending`, `slow_down`, `access_denied`, `expired_token`) into a typed outcome the caller can pattern-match.

Several mature Rust crates already implement RFC 8628:

- `oauth2-rs` (ramosbugs) — most reputable; exposes `DeviceCodeErrorResponseType` enum with the exact variants we want.
- `gh-device-flow` (jakewilkins) — GitHub-targeted; active.
- `oauth-device-flows` — generic RFC 8628.
- `yup-oauth2` — Google-shaped.

A reasonable reader will ask: "why didn't they just use `oauth2-rs`?" This ADR records why.

## Decision

The Local Client SDK (`client/src-tauri/src/api/`) hand-rolls:

- The HTTP layer (using `reqwest`).
- The device-flow vocabulary as a 5-variant enum (`DevicePollOutcome { Pending, SlowDown, Authorized(SessionData), Expired, Denied }`).

It does **not** pull in any of the surveyed OAuth crates.

## Considered alternatives

- **`oauth2-rs` as the HTTP client.** Rejected: it talks **directly** to the OAuth provider in RFC 8628 form-encoded shape and expects RFC 8628 response shapes back. Our wire surface is the Stage Backend, not GitHub directly — request body is JSON (`{"device_code": "..."}`), response is `{"status": "ok", "session_token": "stg_..."}` returning Stage session tokens, not OAuth access tokens. The crate can't be redirected by URL alone — the wire shape itself differs. This is a consequence of ADR-0001 (three-tier topology): "the Local Client has no GitHub credentials" forces the client off the GitHub-direct path that every OAuth crate assumes.

- **`oauth2-rs` for its `DeviceCodeErrorResponseType` enum only.** Rejected: pulling oauth2 in for ~10 lines of enum drags 10+ transitive deps + lock-in to a crate not used for anything else in this codebase. Bad cost ratio. RFC 8628 error vocabulary is stable since 2019 — the maintenance burden of hand-rolling 5 variants is negligible.

- **`gh-device-flow`.** Rejected on the same topology grounds (talks directly to `github.com`); also exposes only `GitHubError(String)`, an opaque wrapper less typed than our `DevicePollOutcome`. No win.

- **`oauth-device-flows`, `yup-oauth2`.** Rejected: generic providers, same topology blocker.

## Consequences

**Positive:**

- Zero transitive OAuth-crate deps in the client.
- The SDK's surface matches the Stage Backend's JSON envelope exactly, not RFC 8628's form-encoded shape — fewer translation layers.
- `DevicePollOutcome` exposes Stage's intended UX outcomes (Pending / SlowDown / Authorized / Expired / Denied), without leaking RFC 8628 error-string semantics into callers.

**Negative:**

- If GitHub extends RFC 8628 with new device-flow error codes, we update one match statement; with a crate dep we'd update via `cargo update`. Accepted: RFC 8628 vocabulary has not changed since publication.
- Future contributors familiar with `oauth2-rs` may default to suggesting it; this ADR is the standing answer.

## Reference

The backend↔client seam design (§ crate survey) contains the full crate survey table that backs this decision; preserved in git history.
