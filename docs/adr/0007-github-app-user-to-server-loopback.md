# ADR-0007 · GitHub App user-to-server + loopback + PKCE for client auth

**Status:** accepted
**Date:** 2026-05-26
**Supersedes:** ADR-0005

## Context

The previous auth design (ADR-0005 + OAuth App device flow) had two GitHub identities running side-by-side: an OAuth App user-token that the backend used once to identify the user and then discarded, and a single `GITHUB_ADMIN_PAT` that did every GitHub-proxy action under one bot identity. Every PR comment, merge, label, or reviewer-request via Stage was attributed to that bot — not to the signed-in user.

ADR-0001 had promised "GitHub OAuth tokens are held exclusively by the Stage Backend"; in practice the tokens were thrown away and a PAT did the work.

## Decision

Stage adopts a **single GitHub App** with **user-to-server tokens** as the identity primitive for all GitHub operations, and a **loopback + PKCE** flow for sign-in:

- **GitHub App permissions:** Pull requests R/W, Issues R/W, Contents R, Metadata R.
- **Auth UX:** user clicks Sign in → Tauri binds an ephemeral `127.0.0.1:N` listener → browser opens `https://github.com/login/oauth/authorize?...&redirect_uri=http://127.0.0.1:N/cb&code_challenge=...&code_challenge_method=S256` → user authorizes (+ installs Stage on a repo if needed) → browser redirects to the loopback URL → Tauri ships the auth `code` to the backend → backend exchanges `code` + `client_secret` + verifier for a `ghu_…` user-to-server token + `ghr_…` refresh token.
- **Token storage:** `GitHubIdentity` row per user holds the tokens + expiries. `make_user_gateway(user)` refreshes near-expired tokens transparently.
- **`GITHUB_ADMIN_PAT` is removed.** Every GitHub call is attributed to the signed-in user.

## Considered alternatives

- **OAuth App with broader scopes (`repo`, `read:org`).** Rejected: OAuth scopes are coarse — `repo` is "write to every private repo in every org you're in", with no per-repo gating. Org admins can block OAuth Apps. Future bot mode would require inventing a parallel GitHub App from scratch.
- **Keep device flow with the new GitHub App.** Rejected: device flow's code-paste ceremony adds context switches; the install step for a GitHub App already requires a browser visit, so a loopback flow gives a single continuous browser ceremony with no UX cost.
- **Custom protocol `stage://oauth-callback`.** Rejected: OS-specific registration, brittle cross-platform.

## Consequences

**Positive:**

- Correct user attribution on every GitHub action.
- Per-repo install gating; org admins control Stage's reach.
- Same primitive scales to bot mode (installation tokens) when needed — no parallel system.
- ADR-0001 finally lines up with reality (backend is the sole holder of GitHub credentials).
- Token TTLs (8 h access, 6 mo refresh) bound the blast radius of a leaked token.

**Negative:**

- Two GitHub Apps to maintain (prod + dev), each with its own client secret and private key.
- Refresh logic adds a thin layer on every authenticated proxy request.
- A misbehaving installation (e.g., org admin uninstalls Stage mid-session) surfaces as a 403 from GitHub that the gateway propagates to the client.

## Reference

- Spec: `docs/superpowers/specs/2026-05-26-github-app-auth-redesign-design.md`.
- [GitHub Apps user-to-server tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).
- [RFC 8252 §7.3](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3).
- [`cli/oauth`](https://github.com/cli/oauth) (reference loopback + device-flow impl).
