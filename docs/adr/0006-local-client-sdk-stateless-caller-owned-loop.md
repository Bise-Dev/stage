# ADR-0006 · Local Client SDK is stateless and does not own the device-flow poll loop

**Status:** accepted
**Date:** 2026-05-25

## Context

The Local Client SDK (`client/src-tauri/src/backend.rs`) implements the four `/api/v1/auth/*` endpoints (device-flow start + poll, `auth_me`, `logout`). Two ergonomic questions arise when shaping its public surface:

1. **Who holds the Stage session token between calls?** The SDK could cache it internally (one auth, then implicit on every later call), or stay stateless (caller passes `token: &str` per authed call).
2. **Who drives the device-flow poll loop?** The SDK could expose a single `await`-able method that loops internally until terminal, or expose one-shot `device_poll(&device_code)` and let the caller drive the cadence.

ADR-0001 establishes the three-tier topology and the rule that the Local Client has no GitHub credentials. The Stage session token is the only auth secret the client ever holds, and per `docs/design.md` § 7 it is long-lived (no auto-expiry) until user-initiated logout. ADR-0005 explains why the SDK hand-rolls the device-flow vocabulary instead of importing `oauth2-rs`. This ADR sits below ADR-0005 in the dependency order: now that we own the device-flow code, *how does it shape its public surface*?

## Decision

The SDK is **stateless on the session token** and **does not own the device-flow poll loop**.

- `BackendClient` carries no `token` field. Every authed method (`auth_me`, `logout`) takes `token: &str`. The constructor takes only `base_url`.
- `device_poll(&self, device_code: &str) -> Result<DevicePollOutcome, BackendError>` performs exactly one HTTP round-trip per call. There is no `device_login_and_loop` convenience.
- The caller (today: `examples/auth_smoke.rs`; tomorrow: a Tauri command behind a UI; later: possibly a CLI) owns:
  - Token persistence (keychain / encrypted store / memory).
  - The poll-loop cadence, the deadline check, the `SlowDown` interval-bump, and cancellation.

## Considered alternatives

- **Stateful client with internal token.** Rejected. A `BackendClient` that caches the token after `device_poll → Authorized` needs interior mutability (`Arc<Mutex<Option<String>>>`) plus a way for callers to *also* get the token out so they can persist it across process restart. Two sources of truth: the SDK's in-memory copy plus whatever the caller stored in keychain. Drift between them is a future bug we own.

- **Stateful client with a `Zeroize`-on-drop `Secret<String>` wrapper.** Rejected as ergonomically heavy. The `secrecy` crate adds a wrapper at every header-construction site (`bearer_auth(secret.expose_secret())`) and doesn't actually prevent leaks — the token still leaves the wrapper to enter `reqwest::RequestBuilder::bearer_auth`. The discipline `SessionData` enforces (no `Debug`, no `Clone`) achieves the practical wins without the boilerplate. Open question 4 in the spec records the same call.

- **SDK-owned loop with a `CancellationToken`.** Rejected on cancellation ergonomics. Inside-the-SDK looping requires either a `tokio_util::sync::CancellationToken` parameter (extra dependency), a `Drop`-cancel pattern (cleanup races), or a `select! { ... = client.login() => ..., _ = ui_cancel => ... }` shape (still hoists the loop above the SDK). The caller-driven loop has trivial cancellation: stop calling.

## Consequences

**Positive:**

- The SDK is honest about ownership: the token belongs to whoever called `device_poll → Authorized`, full stop. Future Tauri command layer reads from / writes to keychain; future CLI reads from env; nothing reaches into the SDK to "fix" cached state.
- Cancellation, UX countdown, retry indicators, `SlowDown` interval bump — all live in the caller, where the user-facing UI also lives. The SDK takes no opinions on any of those.
- Test boundaries are crisp: one mock HTTP exchange per `device_poll` call. The poll-loop logic is unit-testable at the caller layer separately.
- `BackendClient` stays `Clone + Send + Sync` with no interior mutability — cheap to hand to many Tauri command handlers via `AppState`.

**Negative:**

- The caller carries more code. Every consumer must implement the same `tokio::time::sleep` + `match outcome` loop. `examples/auth_smoke.rs` shows the canonical shape, but it is not enforced — two consumers could drift. Accepted: we have one consumer today and at most a handful in scope (Tauri command, optional CLI).
- Wrong shape if the SDK ever grows a second polling-flow endpoint (e.g., a long-running export job); we revisit then.

## Reference

- `docs/superpowers/specs/2026-05-24-backend-client-seam-design.md` § 2 (Public API surface) + § 3 (Caller-owned polling loop) — the inline rationale this ADR canonicalises.
- ADR-0001 (three-tier topology) — establishes the no-GitHub-credentials-on-client rule that motivates the Stage session token's central role.
- ADR-0005 (SDK hand-rolls device-flow vocabulary) — predecessor; explains why we own the device-flow code at all.
- `docs/design.md` § 7 — backend-side auth implementation (long-lived session tokens until user-initiated logout).
