# GitHub App auth redesign — design

> **Status:** proposed
> **Date:** 2026-05-26
> **Branch:** `feat/github-app-auth-redesign` (design + plan only; implementation split into 3 stacked PRs)
> **Supersedes:** the auth shape in `docs/superpowers/specs/2026-05-25-tauri-auth-and-github-prs-design.md` (OAuth App + device flow + admin PAT) and ADR-0005 (hand-rolled device-flow vocabulary).
> **References (verified 2026-05-26):**
>
> - [GitHub Apps user-to-server tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
> - [GitHub OAuth Apps loopback support](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
> - [GitHub Apps callback URLs (up to 10 per App)](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)
> - [RFC 8252 §7.3 — Loopback Interface Redirection](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3)
> - [`cli/oauth`](https://github.com/cli/oauth) — reference impl bundling device + loopback web flows

## 1. Why this exists

The current auth shape has two independent GitHub identities co-existing in the backend, and neither lines up with the user the client just authenticated:

1. **`apps/identity/github_oauth.py`** runs the OAuth App device flow with scope `read:user`. The resulting user access token is used once at `apis.py:37` (`fetch_user`) and **thrown away**. The backend never persists per-user GitHub credentials.
2. **`apps/github_proxy/apis.py:16`** and **`apps/workspaces/apis.py:46`** build every `GithubGateway` with `token=env.GITHUB_ADMIN_PAT` — a single bot Personal Access Token. All review comments, merges, reviewer requests, label changes, etc., are attributed to the PAT owner.

Consequence: when user `alice` posts a review comment via Stage, GitHub records it as `stage-bot` (or whoever owns the PAT). Notifications go wrong, blame is wrong, audit is wrong, and the PAT must hold permissions on every repo any Stage user might touch — a single coarse credential with multi-user blast radius.

ADR-0001 line 25 promises: *"GitHub OAuth tokens are held exclusively by the Stage Backend."* That promise is currently false (tokens are discarded, not held), and even if held, OAuth-App scopes are too coarse for the per-repo authorization model Stage actually wants.

## 2. Goals & non-goals

### Goals

- **Correct attribution.** Every action Stage takes on GitHub is attributed to the signed-in Stage user, with that user's `ghu_…` token.
- **Per-repo scoping.** Org admins control which repos Stage can touch (GitHub App installation model).
- **Single primitive, two roles.** Same GitHub App that powers "act as user" today also powers "act as Stage bot" later (installation tokens) — no parallel system to invent.
- **Desktop-native auth UX.** Click "Sign in" → browser opens → one ceremony → back in Stage. No code-paste.
- **Maintain three-tier topology.** Client still has no `client_secret`, no `ghu_`, no `ghr_`. Backend remains the sole holder of GitHub credentials. ADR-0001 becomes accurate.

### Non-goals (deferred follow-ups)

| Follow-up | Why deferred |
|---|---|
| Token encryption at rest (column-level Fernet) | DB-at-rest encryption assumed sufficient for POC; column-level is a separate hardening pass. |
| Tagged-JSON `AppError` for React pattern-matching | Carried from previous slice; wider refactor across all error sites. |
| **Bot mode** (installation token, `GithubAppInstallation` table, JWT signing) | "Both user + bot" future target. Architectural seam (gateway factory) lands in this slice; no code yet. |
| "Disconnect GitHub" button (revoke OAuth grant + delete identity) | UX nicety, not blocking. |
| Empty-installations UX ("Install Stage on a repo" prompt) | Polish; empty list is acceptable for now. |
| Keychain-backed Stage session | Carried from previous slice. |
| Multi-account on same machine | No demand yet. |
| Author/Reviewer toggle in PR list | UI polish. |

## 3. Architecture

### 3.1 Identity primitive

One **GitHub App** named "Stage" (with separate production and development registrations — both use `http://127.0.0.1` as the callback URL, so neither needs a public backend URL).

**App permissions** (request the minimum that covers existing proxy operations):

| Permission | Level | Why |
|---|---|---|
| Pull requests | read & write | comment, post review, request reviewers, patch (close/reopen/draft), merge, create PR |
| Issues | read & write | issue comments on PR threads (GitHub stores PR issue-comments under issues API) |
| Contents | read | file diffs, list files |
| Metadata | read | mandatory for every GitHub App |

**Token shape.** User-to-server access token (`ghu_…`, 8 h TTL) + refresh token (`ghr_…`, 6 mo TTL). Permissions are the intersection of App permissions and the signing user's permissions on each repo — verified against [GitHub Apps user-to-server token docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

### 3.2 Sign-in ceremony (loopback + PKCE)

```
┌─────────────────┐                                  ┌──────────────┐
│  Tauri client   │                                  │   GitHub     │
│ (loopback list.)│◄────redirect with ?code─────────►│ /authorize   │
└────────┬────────┘                                  └──────────────┘
         │  POST /api/v1/auth/web/exchange/
         │  {code, code_verifier, redirect_uri}
         ▼
┌─────────────────────────┐  exchange code+secret+verifier  ┌──────────────┐
│     Stage Backend       │◄──────────────────────────────► │ /access_token│
│   (holds App secrets)   │                                  └──────────────┘
└──────────┬──────────────┘
           │ store {ghu_…, ghr_…, expires_at} on GitHubIdentity row
           │ issue stg_… Stage session
           ▼
┌─────────────────────────────────┐
│    User session in client       │
│  (stg_… in memory only, no kc)  │
└─────────────────────────────────┘
```

### 3.3 Per-call gateway behaviour

```
client ──Bearer stg_X──► backend api ──looks up user.github_identity──► refresh if expired ──Bearer ghu_Y──► GitHub
```

### 3.4 What this replaces

| Removed | Replacement |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID/SECRET` | `GITHUB_APP_CLIENT_ID/SECRET` |
| `GITHUB_ADMIN_PAT` | Per-user `GitHubIdentity.access_token` (refreshed on demand) |
| `apps/identity/github_oauth.py` (device flow) | `apps/identity/github_app.py` (code exchange + refresh) |
| `/api/v1/auth/device/start/`, `.../device/poll/` | `/api/v1/auth/web/exchange/` |
| Client `auth_device_start`, `auth_device_poll`, `DevicePollOutcome` | Client `auth_sign_in`, `auth_sign_in_cancel` |
| OAuth scope `read:user` | Fine-grained App permissions (see 3.1) |
| ADR-0005 (hand-rolled device flow) | ADR-0007 (new) — GitHub App + loopback + PKCE |

### 3.5 What stays

- Three-tier topology — ADR-0001 finally lines up with reality.
- `client_secret` never leaves the backend. Client only ever holds a short-lived auth `code` (single-use, ≤10 min TTL) and the Stage `stg_…` session token.
- Stage `Session` model (`apps/identity/models.py:Session`) unchanged. `BearerSessionAuthentication` unchanged. `User` model unchanged.
- All `GithubGateway` HTTP methods unchanged. The only change is who supplies the token.

### 3.6 Bot-mode seam (future)

When bot mode lands, the same GitHub App mints **installation tokens** via JWT-signed calls to `POST /app/installations/{id}/access_tokens`. A new `GithubAppInstallation` table caches install IDs per org. `make_gateway()` grows two strategies: `as_user(user)` and `as_installation(o, r)`. This slice introduces the factory function so callers can switch strategies later without touching every API view.

## 4. Components by file

### 4.1 Backend (`backend/`)

| File | Change | Responsibility |
|---|---|---|
| `apps/identity/github_oauth.py` → `apps/identity/github_app.py` | RENAME + REWRITE | `authorize_url_helpers` (build URL with PKCE/state) — *optional helper for tests; the client computes URL in practice*. `exchange_code(*, code, code_verifier, redirect_uri) -> dict`. `refresh(*, refresh_token) -> dict`. `fetch_user(*, access_token) -> dict`. `mint_installation_token(*, installation_id)` stubbed (`raise NotImplementedError`) for bot-mode follow-up. |
| `apps/identity/models.py` | ADD | `class GitHubIdentity(BaseModel)`: `user` (`OneToOneField(User, related_name="github_identity")`), `access_token` (TextField), `refresh_token` (TextField), `access_token_expires_at` (DateTimeField), `refresh_token_expires_at` (DateTimeField). DB-level encryption assumed; column-level Fernet deferred. |
| `apps/identity/services.py` | ADD + KEEP | New: `github_identity_upsert(*, user, payload) -> GitHubIdentity` (idempotent; rotates both tokens), `github_identity_ensure_fresh(*, identity) -> GitHubIdentity` (refresh if `access_token_expires_at - now < 60 s`; raise `ApplicationError("github_reauth_required", status=401)` and delete row on `bad_refresh_token`). Keep: `session_issue`, `session_revoke`, `user_upsert_from_github`, `_hash_token`. |
| `apps/identity/apis.py` | REPLACE auth endpoints | Drop `DeviceStartApi`, `DevicePollApi`. Add `AuthWebExchangeApi` (POST `/api/v1/auth/web/exchange/`, input `{code, code_verifier, redirect_uri}`, output `{session_token, user}` like existing `DevicePollOkOutputSerializer`). `AuthMeApi`, `AuthLogoutApi` unchanged. |
| `apps/identity/urls.py` | UPDATE | `device/start/`, `device/poll/` → `web/exchange/`. |
| `apps/identity/auth.py` | UNCHANGED | `BearerSessionAuthentication` keeps using Stage `stg_…` session tokens. |
| `apps/identity/serializers/web_exchange_input.py` | NEW | `code: str`, `code_verifier: str`, `redirect_uri: str` (URL validator). |
| `apps/identity/serializers/device_*` | DELETE | `device_poll_input.py`, `device_poll_ok_output.py`, `device_poll_pending_output.py` removed. |
| `apps/github_proxy/gateway.py` | TWEAK | Constructor signature `__init__(self, token: str)` unchanged. Module gains `make_user_gateway(user: User) -> GithubGateway` factory: loads `user.github_identity`, calls `github_identity_ensure_fresh`, returns `GithubGateway(token=identity.access_token)`. |
| `apps/github_proxy/apis.py` | TWEAK | Module-level `_gateway()` removed. Each `APIView` calls `make_user_gateway(request.user)` instead. |
| `apps/workspaces/apis.py` | TWEAK | Same `_gateway()` → `make_user_gateway(request.user)` swap. |
| `config/settings/env_schemas.py` | REPLACE | Remove `GITHUB_OAUTH_CLIENT_ID/SECRET`, `GITHUB_ADMIN_PAT`. Add `GITHUB_APP_CLIENT_ID: str`, `GITHUB_APP_CLIENT_SECRET: str`, `GITHUB_APP_ID: int`, `GITHUB_APP_PRIVATE_KEY: str` (multiline PEM). `GITHUB_API_BASE` unchanged. |
| `apps/identity/migrations/000X_github_identity.py` | NEW | Creates `identity_githubidentity` table. |
| `apps/identity/factories.py` | ADD | `GitHubIdentityFactory` with sensible defaults (8 h future expiry, 6 mo refresh expiry). |
| `docs/adr/0007-github-app-user-to-server-loopback.md` | NEW | Records the architectural decision; supersedes ADR-0005 (which gets a "Superseded by ADR-0007" header). |
| `docs/api.md` | UPDATE | Replace `/api/v1/auth/device/*` section with `/api/v1/auth/web/exchange/`. |

### 4.2 Client Rust (`client/src-tauri/src/`)

| File | Change | Responsibility |
|---|---|---|
| `api/auth.rs` | REPLACE | Drop `device_start`, `device_poll`, `DevicePollOutcome`. Add `pub async fn web_exchange(&self, code: &str, code_verifier: &str, redirect_uri: &str) -> Result<SessionData, Error>`. Keep `auth_me`, `logout`. |
| `api/types.rs` | TRIM | Remove `DeviceCode`. Keep `SessionData`, `User`, `GithubPrSearchItem`, `GithubUserRef`. |
| `oauth.rs` | NEW (~250 LOC) | `pub fn pkce_pair() -> (String, String)` returns `(verifier, challenge_b64url)` with `verifier` 43–128 ASCII chars from `[A-Za-z0-9-._~]`, `challenge = base64url_no_pad(sha256(verifier))`. `pub fn gen_state() -> String` returns 32-byte random base64url. `pub fn authorize_url(client_id: &str, redirect_uri: &str, state: &str, challenge: &str) -> String`. `LoopbackListener::bind() -> Result<Self, OauthError>` binds `127.0.0.1:0`. `recv(timeout: Duration) -> Result<CallbackParams, OauthError>` accepts one TCP connection, parses the GET line + query string, returns `{code, state, installation_id, setup_action, error}`. `OauthError` enum covers `BindFailed`, `Timeout`, `StateMismatch`, `UserDenied`, `GithubError(String)`, `Cancelled`. |
| `commands.rs` | REPLACE auth cmds | Drop `auth_device_start`, `auth_device_poll`. Add `auth_sign_in(state: tauri::State<'_, AppState>) -> Result<api::User, AppError>` — runs the full ceremony (gen PKCE, bind listener, open browser, await callback, verify state, POST `/auth/web/exchange/`, stash session in AppState, return User). Add `auth_sign_in_cancel(state) -> Result<(), AppError>` — aborts the in-flight task. Keep `auth_me`, `auth_logout`, `github_prs`. |
| `errors.rs` | EXTEND | New variants: `AuthDenied`, `Cancelled`. `From<oauth::OauthError> for AppError` impl. |
| `state.rs` | TWEAK | `AppState.auth_in_flight: parking_lot::Mutex<Option<tokio::task::AbortHandle>>` for cancel support. `AuthSession` unchanged. `require_token()` unchanged. |
| `lib.rs` | TWEAK | Read `plugins.stage.githubAppClientId` from `tauri.conf.json`. Plug into AppState. Update `invoke_handler!` list. |
| `Cargo.toml` | ADD | `base64ct = { version = "1", features = ["alloc"] }`, `sha2 = "0.10"`, `rand = "0.8"`. (`tokio`, `reqwest`, `serde`, `parking_lot` already present.) |
| `tauri.conf.json` | ADD | `plugins.stage.githubAppClientId` (string; placeholder filled by env at build time or hard-coded for dev). |
| `capabilities/default.json` | UNCHANGED | `opener:default` already there. |
| `examples/auth_smoke.rs` | UPDATE | Drop device-flow demo, replace with web-flow demo binary. |

### 4.3 Client React (`client/src/`)

| File | Change | Responsibility |
|---|---|---|
| `tauri.ts` | TRIM + EXTEND | Remove `AuthPollResult`, `DeviceCode`, `authDeviceStart`, `authDevicePoll`. Add `authSignIn(): Promise<User>`, `authSignInCancel(): Promise<void>`. |
| `lib/auth.ts` | REPLACE | Drop `runDeviceFlow`. Add `runWebFlow(onEvent, signal)` — calls `authSignIn`, wires `signal.onabort → authSignInCancel`. Emits two events: `started`, `authenticated` (or `error`). |
| `screens/onboarding/SignIn.tsx` | SIMPLIFY | 3-state machine (`idle` / `signing-in` / `error`). Drop `AwaitingCard`, `StatusCard.code` display — no code to show. Idle: "Sign in with GitHub" button. Signing-in: "Continue in your browser…" + Cancel button. Error: message + Retry. |
| `screens/workspace/WorkspaceScaffold.tsx` | UNCHANGED | Calls `githubPrs('author')`; behaviour identical. |
| `App.tsx`, `OpenRepository.tsx` | UNCHANGED | View routing identical. |

## 5. Data flow

### 5.1 First sign-in (loopback ceremony)

```
React                Tauri-Rust                Browser                GitHub                 Backend
  │ invoke('auth_sign_in')                                                                    │
  ├────────────────►│                                                                         │
  │                 │ (V, C) = pkce_pair(); S = gen_state()                                   │
  │                 │ listener = LoopbackListener::bind()  → http://127.0.0.1:N               │
  │                 │ open_url(authorize_url(client_id, redirect_uri=127.0.0.1:N/cb,          │
  │                 │                         state=S, code_challenge=C))                     │
  │                 ├──────────────────────►│                                                 │
  │                 │                       │  GET /login/oauth/authorize?...                 │
  │                 │                       ├──────────────────────►│                         │
  │                 │                       │  302 to install step (if no install)            │
  │                 │                       │  302 to http://127.0.0.1:N/cb?code=ABC&         │
  │                 │                       │      state=S&installation_id=42                 │
  │                 │◄──────────────────────┤                                                 │
  │                 │ verify state == S                                                       │
  │                 │ tiny HTML response "You can close this tab"                             │
  │                 │ POST /api/v1/auth/web/exchange/                                         │
  │                 │ {code: "ABC", code_verifier: V, redirect_uri: "http://127.0.0.1:N/cb"} │
  │                 ├──────────────────────────────────────────────────────────────────────►│
  │                 │                                       POST /login/oauth/access_token  │
  │                 │                                       (client_id, client_secret,       │
  │                 │                                        code, code_verifier)            │
  │                 │                                              │◄────────────────────────┤
  │                 │                                              │ {access_token: ghu_…,   │
  │                 │                                              │  refresh_token: ghr_…,  │
  │                 │                                              │  expires_in: 28800,     │
  │                 │                                              │  refresh_token_expires_in: 15897600}
  │                 │                                              ├────────────────────────►│
  │                 │                                       GET /user (Bearer ghu_…)         │
  │                 │                                              │◄────────────────────────┤
  │                 │                                              │ profile                  │
  │                 │                                              ├────────────────────────►│
  │                 │                                                            user_upsert_from_github
  │                 │                                                            github_identity_upsert(payload)
  │                 │                                                            session_issue → stg_XXX
  │                 │ {session_token: stg_XXX, user: {...}}                                 │
  │                 │◄──────────────────────────────────────────────────────────────────────┤
  │                 │ AppState.auth = Some(AuthSession{token: stg_XXX, user})               │
  │ user                                                                                     │
  │◄────────────────┤                                                                        │
  re-render → WorkspaceScaffold
```

### 5.2 Returning sign-in (grant + install already exist)

Same flow. GitHub authorize page is a one-click "Authorize Stage" (or skipped entirely if grant is cached). No new install step.

### 5.3 Authenticated proxy call with transparent refresh

```
React → invoke('github_prs', {role}) → Rust commands.rs::github_prs
  token = state.require_token()?           // stg_XXX
  api::Client::github_prs(token, role)
  GET /api/v1/github/prs/?role=author       Authorization: Bearer stg_XXX
      │
      └──► Backend BearerSessionAuthentication resolves request.user
           GithubPullsSearchApi.get:
             gw = make_user_gateway(request.user):
               identity = user.github_identity
               github_identity_ensure_fresh(identity=identity):
                 if access_token_expires_at - now < 60s:
                   payload = github_app.refresh(refresh_token=identity.refresh_token)
                   identity = github_identity_upsert(user=user, payload=payload)
                 return identity
               return GithubGateway(token=identity.access_token)
             gw.search_issues(f"is:pr is:open author:{login}")
             filter via workspaces_existing_for_prs
             return {items, count}
  ◄──── 200 JSON
  React renders.
```

### 5.4 Logout

```
React → invoke('auth_logout') → Rust commands.rs::auth_logout
  token = state.require_token()?
  result = api::Client::logout(token)   // DELETE /api/v1/auth/logout/  Bearer stg_XXX
      Backend revokes Session row. 204.
  state.auth = None                     // ALWAYS clear, even if backend errored
  result.map_err(Into::into)
```

Logout does **not** revoke the GitHub OAuth grant or delete `GitHubIdentity`. The grant is reused on the next sign-in. "Disconnect GitHub entirely" is a deferred follow-up.

### 5.5 Refresh-token expiry edge

Refresh token TTL = 6 months. If both access + refresh are expired (or refresh is revoked on github.com), `github_app.refresh()` returns `{error: "bad_refresh_token"}`. `github_identity_ensure_fresh` deletes the `GitHubIdentity` row and raises `ApplicationError("github_reauth_required", status=401)`. Client maps the 401 to `AppError::NotAuthenticated`; React routes to SignIn. The Stage `Session` is independently revoked by the user signing back in.

## 6. Error handling

### 6.1 Client-side OAuth errors (loopback ceremony, never reach backend)

| Condition | `AppError` variant | UX |
|---|---|---|
| Cannot bind `127.0.0.1:0` (sandbox / firewall) | `Backend("oauth_bind_failed")` | "Couldn't start sign-in. Check firewall." |
| `tauri_plugin_opener::open_url` fails | `Backend("oauth_browser_open_failed")` | "Couldn't open browser." |
| Listener timeout (5 min default, configurable) | `Backend("oauth_timeout")` | "Sign-in timed out. Click Sign in to retry." |
| State mismatch on callback | `Backend("oauth_state_mismatch")` | "Sign-in failed — retry." |
| Callback `?error=access_denied` (user denied at GitHub) | `AuthDenied` *(new)* | "You declined access. Click Sign in to try again." |
| Callback `?error=...` (other GitHub error) | `Backend("oauth_github_error: <slug>")` | Show slug. |
| `auth_sign_in_cancel` called while in flight | `Cancelled` *(new)* | Silent return to idle. |
| Second `auth_sign_in` while one already running | `Backend("oauth_in_flight")` | "Already signing in." |

### 6.2 Backend errors (code exchange or refresh)

| Condition | `ApplicationError` kind | HTTP | Client `AppError` | UX |
|---|---|---|---|---|
| GitHub returns `{error: "bad_verification_code"}` on code exchange | `github_code_invalid` | 400 | `Backend(...)` | "Sign-in failed; retry." |
| GitHub unreachable (5xx / DNS) | `github_unreachable` | 502 | `Backend(...)` | "GitHub unreachable; check connection." |
| `GITHUB_APP_*` env vars missing/wrong (401 from token endpoint with valid code) | `github_app_misconfigured` | 500 | `Backend(...)` | "Server misconfigured; contact admin." Logged at `error` level. |
| Refresh token expired/revoked | `github_reauth_required` | 401 | `NotAuthenticated` | App routes to SignIn screen. `GitHubIdentity` row deleted. |
| User has no `GitHubIdentity` (stale state) | `github_reauth_required` | 401 | `NotAuthenticated` | Same. |
| Stage `Session` invalid / revoked (DRF auth) | DRF default | 401 | `NotAuthenticated` | Same. |

### 6.3 Proxy errors (existing; unchanged surface)

| GitHub returns | Backend raises | HTTP |
|---|---|---|
| 404 | `GithubNotFound` | 404 |
| 403 (rate limit / insufficient perm) | `GithubForbidden` | 403 |
| 409 / 412 (concurrent edit) | `GithubConflict` | 409 / 412 |

### 6.4 Logout

Backend error during `/api/v1/auth/logout/` does **not** block local `state.auth = None`. The existing pattern from the previous slice (always clear local state) is preserved.

### 6.5 New `AppError` variants

```rust
#[error("user denied authorization")]
AuthDenied,
#[error("sign-in cancelled")]
Cancelled,
```

`From<oauth::OauthError> for AppError` maps:
- `OauthError::UserDenied` → `AppError::AuthDenied`
- `OauthError::Cancelled` → `AppError::Cancelled`
- everything else → `AppError::Backend(format!(...))` with a stable string slug.

### 6.6 Pre-existing follow-up (still applies)

Tagged-JSON serialization for `AppError` (so React can `error.kind === 'not_authenticated'` instead of parsing strings) is still deferred. Carried from the previous slice's follow-ups.

### 6.7 Special UX case (not an error)

User signs in but has Stage installed on zero repos. GitHub `/search/issues` returns 200 with `items: []`. PR list shows an empty state. Polished empty-state with "Install Stage on a repo" link is a deferred follow-up; this slice ships a plain empty state.

## 7. Testing strategy

### 7.1 Backend (Django pytest + factories + `pytest-httpx`)

```
tests/identity/
  test_github_app.py        # exchange_code, refresh, fetch_user against mocked httpx
  test_services.py          # github_identity_upsert (insert + rotate),
                            # github_identity_ensure_fresh (fresh skip, near-expiry refresh,
                            # bad_refresh_token → delete + 401)
  test_apis.py              # /auth/web/exchange/: happy, bad code, GitHub 5xx, missing body
                            # /auth/me/, /auth/logout/ unchanged
tests/github_proxy/
  test_apis.py              # make_user_gateway uses request.user's ghu_… (not env PAT)
                            # transparent refresh on near-expired identity
                            # 401 from GitHub maps to github_reauth_required
  test_search.py            # GithubPullsSearchApi still filters via workspaces_existing_for_prs
```

`GitHubIdentityFactory` added to `apps/identity/factories.py`. Existing PR-proxy tests get a fixture that builds an identity with a far-future expiry by default.

### 7.2 Client Rust SDK (`wiremock`)

```
src-tauri/src/api/
  auth.rs                   # web_exchange: 200 OK, 400 github_code_invalid, 401, 502, 500
  github.rs                 # unchanged from previous slice
```

### 7.3 Client Rust `oauth.rs` (new unit tests)

```rust
fn test_pkce_pair_verifier_length_and_alphabet()     // 43–128 chars from [A-Za-z0-9-._~]
fn test_pkce_challenge_is_s256_base64url_no_pad()    // challenge == b64url(sha256(verifier))
fn test_gen_state_unique_and_b64url()                // distinct outputs, base64url alphabet
fn test_authorize_url_contains_all_required_params() // client_id, redirect_uri, state,
                                                     // code_challenge, code_challenge_method=S256
fn test_authorize_url_percent_encodes_redirect_uri()

// Listener integration (uses reqwest to simulate "browser"):
async fn test_listener_receives_callback_returns_parsed()
async fn test_listener_returns_state_mismatch_when_state_differs()
async fn test_listener_timeout_after_configured_duration()
async fn test_listener_returns_user_denied_on_error_access_denied()
```

### 7.4 Tauri command layer

`auth_sign_in` opens a real browser, so unit-testing it directly is impractical. Coverage = `oauth.rs` units + `api.rs` wiremock + manual e2e. (Same trade-off the previous slice made for `auth_device_*`.)

### 7.5 Manual e2e

1. Create **GitHub App "Stage Dev"** on github.com → User authorization Callback URL `http://127.0.0.1`, permissions per §3.1. Generate App private key (PEM). Copy `client_id`, `client_secret`, `app_id`.
2. Install Stage Dev on a test repo (yours) that has ≥ 1 open PR you authored.
3. Backend `.env`: `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY="$(cat key.pem)"`.
4. Client `tauri.conf.json`: `plugins.stage.githubAppClientId = "Iv1.<dev>"`.
5. `just dev` (backend) + `cargo tauri dev` (client).
6. Click **Sign in with GitHub** in the UI → browser opens authorize page → approve.
7. Browser redirects to `http://127.0.0.1:<port>/cb` → "You can close this tab" → Tauri unblocks.
8. `WorkspaceScaffold` renders user + PR list.
9. Click a PR row → opens PR in browser via `opener:default`.
10. **Refresh test:** in DB, `UPDATE identity_githubidentity SET access_token_expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = …;`. Reload PR list. Backend logs `github_identity_refreshed`. List still loads.
11. **Reauth test:** set both `access_token_expires_at` and `refresh_token_expires_at` to past + invalidate refresh token via github.com. Reload PR list. Client gets 401, routes to SignIn screen.
12. Click **Logout** → back to SignIn. Click Sign in again → no second GitHub-authorize prompt (grant cached) → goes straight to `WorkspaceScaffold`.

### 7.6 Cleanup verification

```
grep -rn "GITHUB_ADMIN_PAT\|device_start\|device_poll\|GITHUB_OAUTH" backend/ client/ docs/ \
  | grep -v ".venv\|node_modules\|target\|dist\|.git\|migrations\|0005-local-client"
```

Expected: 0 hits (ADR-0005 stays as historical record with a "Superseded by ADR-0007" header).

## 8. Scope, branch strategy, PR split

### 8.1 In scope

Everything in §4 and §5.

### 8.2 Out of scope

Everything in §2 non-goals.

### 8.3 Branch strategy

- Design + plan live on **`feat/github-app-auth-redesign`**, based on `origin/feat/backend-client-seam` (the parent of the unmerged `feat/tauri-auth-and-github-prs`).
- The unmerged `feat/tauri-auth-and-github-prs` PR stays open as a **known-good e2e reference**. Its e2e flow (device flow + OAuth App + PAT) is the validation anchor — when this redesign's e2e mirrors the same outcomes (sign in → PR list → logout → sign in again), we know we're at parity.
- Final disposition of `feat/tauri-auth-and-github-prs` (merge as historical stepping stone, close without merging, or rebase) is **deferred** to the end of implementation.

### 8.4 PR split (stacked, sequential)

Each PR cuts from the previous one's HEAD. Strict dependency.

**PR 1 — Backend.** Replaces the auth backend.

- Files: every backend change in §4.1.
- Verified via: backend unit tests (§7.1) + `curl` against `/auth/web/exchange/` with a manually-obtained `code` (from a temporary throwaway loopback listener written in Python for the verification step, or via `gh api`).
- Standalone state at merge: backend supports the new auth shape; client is broken (still calls device endpoints). Acceptable as long as PR 2 follows quickly.

**PR 2 — Client seam (Rust).** Replaces the client SDK + Tauri commands.

- Files: every client Rust change in §4.2.
- Verified via: SDK wiremock tests (§7.2) + `oauth.rs` unit tests (§7.3) + `examples/auth_smoke.rs` smoke run against PR 1's backend.
- Standalone state at merge: client SDK calls correct endpoints; React still calls old typed wrappers (broken).

**PR 3 — Client UI (React).** Replaces the React sign-in flow.

- Files: every React change in §4.3 + `tauri.ts` typed wrappers.
- Verified via: full manual e2e (§7.5) end-to-end.
- Standalone state at merge: full app functional with the new auth shape.

### 8.5 Database migration

Net-new `GitHubIdentity` table. No data migration (no pre-existing GitHub tokens in the previous design — they were always discarded). Devs/contributors update their `.env` per a delta note shipped in PR 1's description.

### 8.6 GitHub App registration ceremony (one-time, manual, dev + prod each)

Documented in PR 1's description and in `docs/setup-github-app.md` (new). Steps:
1. github.com → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Name: "Stage" (prod) or "Stage Dev" (dev). Homepage URL: `https://stage.example` or `http://127.0.0.1`.
3. User authorization callback URL: `http://127.0.0.1` (no path; loopback accepts any port).
4. Expire user authorization tokens: enabled.
5. Permissions per §3.1.
6. Where can this GitHub App be installed: "Any account" (or "Only on this account" for dev).
7. Create. Note client ID + app ID. Generate client secret. Generate private key (PEM).
8. Install on a test repo.

## 9. Architectural decisions (key trade-offs)

| Decision | Picked | Alt considered | Why |
|---|---|---|---|
| Identity primitive | **GitHub App** | OAuth App with broader scopes | Future bot mode uses the same App's installation token. OAuth App with `repo` scope is coarse (all private repos in all orgs); GitHub App is per-repo-installable, org-admin friendly. |
| Token persistence | **Per-user `GitHubIdentity` row** | Discard token (status quo); store in keychain | Backend remains sole credential holder (ADR-0001 alignment). DB row enables transparent refresh. Keychain not viable (server, not client-side). |
| Refresh strategy | **Just-in-time, threshold 60 s** | On schedule (cron); on every call | Just-in-time avoids unnecessary GitHub traffic. 60 s threshold avoids races where a token expires mid-request. |
| Auth UX | **Loopback + PKCE** | Device flow (existing); custom protocol (`stage://`) | Loopback is the desktop standard (RFC 8252; gh CLI, JetBrains, GitHub Desktop). PKCE protects code exchange. Custom protocol is OS-specific and fragile. |
| Loopback host | **`127.0.0.1`** | `localhost`; `::1` | Per RFC 8252 §7.3 + GitHub docs: prefer IP literal over `localhost`. IPv6 is optional fallback; bind IPv4 first. |
| Callback URL on App | **`http://127.0.0.1`** (no port) | Specific port | GitHub allows any port at request time for loopback callbacks ("redirect_uri does not need to match the port specified in the callback URL for the app"). Avoids port-collision restarts. |
| Client knows `client_id`? | **Yes** | Server-issued via `/auth/web/start` | `client_id` is not a secret (it's in the redirect URL the browser sees). Avoids an unnecessary round-trip. `client_secret` stays server-side. |
| State + PKCE generation | **Client-side** | Server-issued state | State protects the *client* from cross-request mix-ups; the client is the authoritative party for its own verification. PKCE verifier never leaves the client until exchange. |
| Code exchange location | **Backend** | Client (with public client) | GitHub Apps are confidential clients (`client_secret` exists). Exchange must happen server-side; PKCE is additional protection not a replacement. |
| Bot mode in this slice | **Stub only** | Full impl | Bot mode = future. Architectural seam (`make_gateway` factory) is the only forward-looking surface this slice introduces. |
| `Session` ⇄ `GitHubIdentity` coupling | **Independent lifetimes** | Coupled (revoke session = revoke identity) | A user logging out on one device shouldn't invalidate GitHub tokens needed by another device. Stage `Session` is per-device; `GitHubIdentity` is per-user. |
| Encryption at rest for tokens | **DB-level (deferred column-level)** | Fernet column-level now | POC stage; DB-at-rest is the line. Column-level is a clearly-scoped hardening pass for later. |
| `AppError` shape | **String slugs (status quo)** | Tagged JSON | Tagged-JSON refactor is wider than this slice. Carried follow-up. |

## 10. Follow-ups (collected)

1. Token encryption at rest (column-level Fernet on `GitHubIdentity.access_token`, `refresh_token`).
2. Tagged-JSON `AppError` serialization for React pattern-matching.
3. **Bot mode**: `GithubAppInstallation` table, JWT signing, installation token mint, `as_installation(o, r)` gateway strategy.
4. "Disconnect GitHub" button: call `DELETE /applications/{client_id}/grant` + delete `GitHubIdentity`.
5. Empty-installations UX: detect zero installations on PR list 200/empty + render "Install Stage on a repo" CTA linking to `https://github.com/apps/<slug>/installations/new`.
6. Keychain-backed Stage session (per `STACK.md`).
7. Author/Reviewer toggle in PR list.
8. Click-a-PR → workspace creation bridge.
9. ADR-0001 amendment to formalize "client briefly handles short-lived auth code, never client_secret or access tokens".
10. `docs/api.md` sync: replace `/auth/device/*` section with `/auth/web/exchange/`.

## 11. Disclaimer

This design covers authentication and OAuth flows, which are high-stakes for credential security. The token-storage, refresh, and `client_secret` handling sections in particular must be reviewed by a qualified security engineer before any production rollout. The references in the header have been verified at the time of writing (2026-05-26); always cross-check against current GitHub documentation before implementation.
