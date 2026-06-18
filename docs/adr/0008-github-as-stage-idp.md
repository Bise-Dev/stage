# ADR-0008 · GitHub as Stage's identity provider

**Status:** superseded by [ADR-0022](0022-local-stage-folder-replaces-backend.md) (was: accepted)
**Date:** 2026-05-26
**Related:** [ADR-0001](./0001-three-tier-topology.md) (three-tier topology), [ADR-0007](./0007-github-app-user-to-server-loopback.md) (GitHub App + loopback + PKCE)

## Context

Stage backend has two distinct authorization concerns:

1. **Identity** — every authenticated backend endpoint needs to know who the user is. Stage-native data (`Workspace`, `Storyline`, `IntroComment`) carries FK ownership and edit permissions keyed by `User`. Without an identity, none of the data plane works.
2. **Credential** — the github_proxy endpoints (and the workspace endpoints that embed storylines in GitHub commits) need to make GitHub API calls on the user's behalf, attributed to that user's GitHub account.

ADR-0007 chose the GitHub App user-to-server token model for concern #2. This ADR addresses concern #1: where does Stage get its identity from?

The choice is whether Stage maintains a separate identity surface (password, email-link, social-login, magic-link, etc.) or treats GitHub as the sole identity provider.

## Decision

**GitHub is Stage's only identity provider.** A user cannot exist in Stage without a GitHub account. The same sign-in ceremony that mints the proxy credential (ADR-0007) also establishes Stage identity:

```
loopback + PKCE → backend exchanges code →
  fetch_user(ghu) → user_upsert_from_github → User row    ← identity layer
  github_identity_upsert(user, payload)                   ← credential layer
  session_issue(user) → stg_…                             ← session issued
```

The Stage `User` row's primary identifier is the GitHub `id` (numeric, immutable). `github_login` is mirrored but treated as cosmetic (logins can be renamed on GitHub).

`BearerSessionAuthentication` is the single identity-resolution surface for the backend. Every authenticated endpoint — github-touching or purely Stage-native — relies on it. The Stage `Session` model represents a *device-bound session*, decoupled from the GitHub credential's lifetime.

## Considered alternatives

- **Stage-owned password / email auth.** Rejected. Stage's purpose is enriching GitHub PR review; a user without a GitHub account cannot meaningfully use the product. Adding a parallel identity surface creates friction (account creation, password reset, email verification) without removing the GitHub-auth requirement for proxy operations.
- **Email magic-link with optional GitHub link.** Rejected. Two-account confusion (which is canonical when a user has both an email account and a GitHub account?), invitation-flow complexity (inviting someone by email when their GitHub identity is what matters), and we still need GitHub auth for every proxy operation. All cost, no win.
- **Multi-IDP (Google / Microsoft / Apple + GitHub).** Rejected for the same reason: GitHub identity is *required* regardless of any other provider, so adding alternatives doesn't reduce the GitHub-auth surface — it just adds identity-matching logic on top.
- **Anonymous local-only mode** (Stage as a pure local PR-review editor with no backend). Deferred to a future "use Stage locally only" follow-up; doesn't change the IDP commitment for authenticated Stage features. When/if that mode lands, it'd be a *no-IDP* mode for purely-local features, not a competing IDP.

## Consequences

**Positive:**

- One sign-in ceremony covers both identity and credential. No "now link your GitHub" step after creating an account.
- Stage `User` identity matches GitHub identity exactly. PR comment attribution, storyline ownership, reviewer mentions all collapse to a single canonical user record — no mapping ambiguity.
- The same GitHub App primitive (ADR-0007) does both jobs. One credential surface, one secret to manage, one rate-limit story.
- ADR-0001's "Backend holds GitHub tokens" gains a cleaner read: the backend holds GitHub tokens *because GitHub is the identity it federates from*, not as an unrelated implementation detail.

**Negative:**

- Users without a GitHub account cannot use Stage. **Accepted** — target audience is GitHub PR reviewers.
- If `github.com` is unreachable, no new sign-ins are possible. Existing Stage sessions keep working for Stage-native operations (Storyline edits, IntroComment writes); only github_proxy calls fail. **Accepted** — Stage's perceived availability is intentionally coupled to GitHub's.
- Org SAML/SSO restrictions can block Stage's GitHub App at the org level (GitHub Apps respect org SAML enforcement). Surface this as a documented limitation; org admins enable Stage by approving the App for the org.
- Account renames on GitHub: handled by keying off `github_user_id` (immutable) rather than `github_login`. The `github_login` field is refreshed on every sign-in so display follows the user's current handle.

## Reference

- The GitHub-App auth redesign spec (§ two-layer model and failure modes) — preserved in git history.
- ADR-0001 three-tier topology.
- ADR-0007 GitHub App + loopback + PKCE.
