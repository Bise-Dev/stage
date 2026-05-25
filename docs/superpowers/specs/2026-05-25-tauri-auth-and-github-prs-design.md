# Design — Tauri auth wiring + minimal GitHub PR list

**Branch:** `feat/tauri-auth-and-github-prs`
**Date:** 2026-05-25
**Author / driver:** Yann Bouzonie (with brainstorming agent)

## Goal

Reach a minimal end-to-end demo loop for Stage:

1. Launch the Tauri client.
2. Sign in via the github device flow brokered by the Stage backend.
3. Open a local repository (existing UI, unchanged).
4. See a list of the github user's open PRs, fetched through the Stage backend's `/api/v1/github/prs/?role=author` proxy.
5. Log out and return to the sign-in screen.

The slice exercises every wire in the architecture (webview → Tauri command → SDK → backend → GitHub) without committing to features that come later (keychain, offline drafts, real workspace creation, SSO).

## Non-goals

The following are deliberately out of scope and tracked elsewhere:

- **Keychain / persistent token.** Memory-only. Restart = re-auth. `STACK.md` documents the future home (`tauri-plugin-keyring`).
- **SSO button removal.** Yann will land that on its own branch.
- **Author / Reviewer toggle for PR list.** Hardcoded `author` for now.
- **Click-a-PR-to-create-a-workspace bridge.** A click opens the github HTML URL in the browser; workspace creation is a later slice.
- **Boot-time auth check / token refresh.** Memory-only token implies always-fresh on boot. Future keychain landing will introduce a boot-time `auth_me` call.
- **JS test infra (vitest / jest).** None in the repo; not bootstrapping it in this PR.
- **Structured `AppError` serialization for webview.** Stays string-only this PR; tagged JSON is a follow-up.

## Architecture

Three layers change. SDK + backend are unchanged.

```
┌─────────────────────────────────────────────────────────────┐
│ React (webview)                                              │
│  • SignIn: real device-flow UI                               │
│  • WorkspaceScaffold: "My GitHub PRs" section + logout       │
│  • App.tsx: drop onboardingFlag gating                       │
│  • src/lib/auth.ts: pure device-flow orchestrator            │
│  • src/tauri.ts: typed wrappers for new commands             │
└────────────────────────┬────────────────────────────────────┘
                         │ tauri invoke
┌────────────────────────▼────────────────────────────────────┐
│ Rust (src-tauri)                                             │
│  • commands.rs: auth_device_start, auth_device_poll,         │
│                 auth_me, auth_logout, github_prs             │
│  • state.rs: AppState gains api::Client + AuthSession mutex  │
│  • lib.rs: tauri.conf.json backend URL → api::Client setup   │
│  • errors.rs: NotAuthenticated + Backend(String) + From impl │
│  • api/github.rs (new): github_prs SDK method                │
│  • api/types.rs: GithubPrSearchItem + GithubUserRef DTOs     │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP via existing api::Client
┌────────────────────────▼────────────────────────────────────┐
│ Backend (unchanged)                                          │
│  • /api/v1/auth/{device/start,device/poll,me,logout}/        │
│  • /api/v1/github/prs/?role=author  (raw github passthrough) │
└─────────────────────────────────────────────────────────────┘
```

### Architectural decisions (locked during brainstorm)

| Axis | Choice | Reason |
|---|---|---|
| Poll loop placement | JS-side. Two short commands: `auth_device_start`, `auth_device_poll`. | Cleaner cancellation via React unmount + AbortSignal; one channel (no Tauri events plumbing); matches `auth_smoke.rs` precedent and ADR-0006's caller-owned philosophy. |
| Token visibility | Rust-only in `AppState.auth: Mutex<Option<AuthSession>>`. Auth'd commands read internally. | Webview never holds the credential. Future keychain swap is one-line. Eliminates the markdown/diff XSS → token-grab risk class. Matches Tauri v2 + Linear/GitHub Desktop best practice. |
| Backend URL source | `tauri.conf.json` field plumbed through `AppState`. | Matches STACK.md long-term direction for Tauri side. Differs from `STAGE_BACKEND_URL` env used by the non-Tauri smoke binary, which stays the convention for that caller. |
| Logout scope | Call backend `POST /api/v1/auth/logout/` + clear `AppState.auth`. | Server-side session correctly revoked; matches `docs/api.md` contract. |
| PR list placement | Append to `WorkspaceScaffold`. Existing `signIn → openRepo → workspace` flow intact. | Smallest change. Demo touches all existing screens. |
| github_prs response | SDK consumes raw github search items unchanged. UI parses owner/repo from `repository_url`. | Stage backend is a **thin GitHub proxy**: passthrough github JSON, do not normalize. See follow-up note on `docs/api.md` drift. |

## Components

### `state.rs` — AppState additions

```rust
pub struct AppState {
    pub active: Mutex<Option<ActiveRepo>>,
    pub recents: Arc<RecentsStore>,
    pub api: api::Client,                  // new
    pub auth: Mutex<Option<AuthSession>>,  // new
}

pub struct AuthSession {
    pub token: String,
    pub user: api::User,
}

impl AppState {
    pub fn require_token(&self) -> Result<String, AppError> {
        self.auth
            .lock()
            .as_ref()
            .map(|a| a.token.clone())
            .ok_or(AppError::NotAuthenticated)
    }
}
```

- `parking_lot::Mutex` (already used) — short critical sections, never hold across `.await`.
- `AuthSession` lives in `state.rs`. Distinct from SDK's `SessionData` (which dropped `Clone` deliberately in commit `d789f4c`).
- `api::Client` is `Clone`; `reqwest::Client` shares its connection pool across clones.

### `lib.rs` — startup wiring

`tauri.conf.json` gains a field for the backend URL at `plugins.stage.backendUrl` (string). Tauri v2 reserves the top-level `app.*` namespace for its own schema; arbitrary user config lives under `plugins.<name>.*` instead (which is a `HashMap<String, JsonValue>` accessible from any `Manager` via `app.config().plugins`). No actual "stage" plugin is registered — we just borrow the namespace and read the raw value. `lib.rs::run` reads `app.config().plugins.0.get("stage")...` once during `setup` and builds `api::Client` from it. If the key is absent, fall back to `http://localhost:8000` so the dev loop works without `.json` edits.

```rust
.setup(|app| {
    // ...existing recents + dirs...
    let backend_url = read_backend_url_from_config(app)?;
    let api = api::Client::new(backend_url).map_err(|e| /* AppError::Backend */)?;
    app.manage(AppState {
        active: Mutex::new(None),
        recents: Arc::new(recents),
        api,
        auth: Mutex::new(None),
    });
    Ok(())
})
```

Also: register `tauri_plugin_opener::init()` (new plugin dependency for browser auto-open).

### `commands.rs` — five new commands

```rust
#[tauri::command]
async fn auth_device_start(state: State<'_, AppState>)
    -> Result<api::DeviceCode, AppError>
{
    state.api.device_start().await.map_err(Into::into)
}

#[tauri::command]
async fn auth_device_poll(state: State<'_, AppState>, device_code: String)
    -> Result<AuthPollResult, AppError>
{
    let outcome = state.api.device_poll(&device_code).await?;
    Ok(match outcome {
        api::DevicePollOutcome::Pending     => AuthPollResult::Pending,
        api::DevicePollOutcome::SlowDown    => AuthPollResult::SlowDown,
        api::DevicePollOutcome::Expired     => AuthPollResult::Expired,
        api::DevicePollOutcome::Denied      => AuthPollResult::Denied,
        api::DevicePollOutcome::Authorized(s) => {
            let user = s.user.clone();
            *state.auth.lock() = Some(AuthSession {
                token: s.session_token,
                user: user.clone(),
            });
            AuthPollResult::Authorized { user }
        }
    })
}

#[tauri::command]
async fn auth_me(state: State<'_, AppState>) -> Result<api::User, AppError> {
    let token = state.require_token()?;
    state.api.auth_me(&token).await.map_err(Into::into)
}

#[tauri::command]
async fn auth_logout(state: State<'_, AppState>) -> Result<(), AppError> {
    let token = state.require_token()?;
    state.api.logout(&token).await?;
    *state.auth.lock() = None;
    Ok(())
}

#[tauri::command]
async fn github_prs(state: State<'_, AppState>, role: String)
    -> Result<Vec<api::GithubPrSearchItem>, AppError>
{
    let token = state.require_token()?;
    state.api.github_prs(&token, &role).await.map_err(Into::into)
}
```

Webview-facing `AuthPollResult` strips the session token:

```rust
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthPollResult {
    Pending,
    SlowDown,
    Authorized { user: api::User },
    Expired,
    Denied,
}
```

### `api/github.rs` (new) + `api/types.rs` (additions)

```rust
// api/types.rs
#[derive(Deserialize, Serialize, Debug)]
pub struct GithubPrSearchItem {
    pub number: i64,
    pub title: String,
    pub html_url: String,
    pub repository_url: String,
    pub updated_at: String,
    pub user: GithubUserRef,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct GithubUserRef {
    pub login: String,
    pub avatar_url: Option<String>,
}

// api/github.rs
impl Client {
    pub async fn github_prs(&self, token: &str, role: &str)
        -> Result<Vec<GithubPrSearchItem>, Error>
    {
        let mut url = self.base_url.join("api/v1/github/prs/").unwrap();
        url.query_pairs_mut().append_pair("role", role);
        let resp = self.http.get(url).bearer_auth(token).send().await?;
        let status = resp.status();
        if !status.is_success() { return Err(Self::map_error(resp).await); }
        #[derive(Deserialize)]
        struct Envelope { items: Vec<GithubPrSearchItem> }
        let body: Envelope = resp.json().await.map_err(|e| Self::json_err(status, e))?;
        Ok(body.items)
    }
}
```

`api/mod.rs` adds `mod github;` + `pub use types::{GithubPrSearchItem, GithubUserRef};`.

### `errors.rs` additions

```rust
pub enum AppError {
    // ...existing...
    #[error("not authenticated")]
    NotAuthenticated,
    #[error("backend: {0}")]
    Backend(String),
}

impl From<api::Error> for AppError {
    fn from(e: api::Error) -> Self {
        match e {
            api::Error::Unauthenticated         => AppError::NotAuthenticated,
            api::Error::Transport(re)           => AppError::Backend(format!("transport: {re}")),
            api::Error::InvalidBaseUrl(s)       => AppError::Backend(format!("invalid base url: {s}")),
            api::Error::Validation { extra }    => AppError::Backend(format!("validation: {extra}")),
            api::Error::Github { status, extra }=> AppError::Backend(format!("github {status}: {extra}")),
            api::Error::Unexpected { status, message, .. }
                                                => AppError::Backend(format!("backend {status}: {message}")),
        }
    }
}
```

Existing `impl Serialize for AppError` (string form) is unchanged; webview catches errors as strings. Tagged JSON serialization is a deferred follow-up.

### `src/lib/auth.ts` (new) — pure orchestrator

Owns the poll loop in JS. AbortSignal-cancellable. No React imports — testable from anywhere.

```typescript
export type DeviceCode = { device_code, user_code, verification_uri, interval, expires_in };
export type User = { id, github_login, github_user_id, display_name, avatar_url };
export type AuthPollResult =
  | { kind: 'pending' } | { kind: 'slow_down' }
  | { kind: 'authorized'; user: User }
  | { kind: 'expired' } | { kind: 'denied' };

export type DeviceFlowEvent =
  | { kind: 'code-issued'; device: DeviceCode }
  | { kind: 'polling' } | { kind: 'slow_down' };

export type DeviceFlowOutcome =
  | { ok: true; user: User }
  | { ok: false; reason: 'expired' | 'denied' | 'transport'; detail?: string };

export async function runDeviceFlow(
  onEvent: (e: DeviceFlowEvent) => void,
  signal: AbortSignal,
): Promise<DeviceFlowOutcome>;
```

Implementation:
1. Call `authDeviceStart()`. Emit `code-issued`. Auto-open `verification_uri` via `openUrl()`.
2. Compute `deadline = Date.now() + expires_in * 1000`, `interval = device.interval * 1000`.
3. Loop:
   - If `signal.aborted` → return `{ ok: false, reason: 'transport', detail: 'cancelled' }`.
   - If `Date.now() > deadline` → return `{ ok: false, reason: 'expired' }`.
   - Call `authDevicePoll(device.device_code)`. On `authorized` → return user. On `expired` / `denied` → return reason. On `pending` → emit `polling`. On `slow_down` → `interval += 5000`, emit `slow_down`.
   - `await sleep(interval, signal)`.

### `src/tauri.ts` — additions

```typescript
export const authDeviceStart = () => invoke<DeviceCode>('auth_device_start');
export const authDevicePoll  = (deviceCode: string) =>
                              invoke<AuthPollResult>('auth_device_poll', { deviceCode });
export const authMe          = () => invoke<User>('auth_me');
export const authLogout      = () => invoke<void>('auth_logout');
export const githubPrs       = (role: 'author' | 'reviewer') =>
                              invoke<GithubPrSearchItem[]>('github_prs', { role });
```

### `src/screens/onboarding/SignIn.tsx` — real flow

State machine: `idle | starting | awaiting-user | error | success`. On "Continue with GitHub":
- Build an `AbortController`, store in ref.
- Call `runDeviceFlow(onEvent, ac.signal)`.
- On `code-issued` event → state becomes `awaiting-user` with the device code shown.
- On `authorized` outcome → invoke `props.onAuthenticated(user)`.
- On `expired` / `denied` / `transport` → state becomes `error` with retry.
- `useEffect(() => () => ac.abort(), [])` cancels on unmount.

The "Continue with SSO" button + "Skip" link stay in place this PR (out of scope to remove).

### `src/App.tsx` — drop `onboardingFlag`

```tsx
type View = 'signIn' | 'openRepo' | 'workspace';

export function App() {
  const [view, setView] = useState<View>('signIn');
  const [user, setUser] = useState<User | null>(null);

  const onAuthed   = (u: User) => { setUser(u); setView('openRepo'); };
  const onRepoOpen = () => setView('workspace');
  const onLogout   = () => { setUser(null); setView('signIn'); };

  if (view === 'signIn')   return <SignIn onAuthenticated={onAuthed} />;
  if (view === 'openRepo') return <OpenRepository onOpened={onRepoOpen} />;
  return <WorkspaceScaffold user={user!} onLogout={onLogout} />;
}
```

Orphaned by this change:
- `src/lib/onboardingFlag.ts` — used only by `App.tsx`. Delete.

`OpenRepository`'s `onBack` prop becomes unused (it pointed back to mocked SignIn). Delete the prop + the rendered "Back" button. Logout is the new way back to SignIn, and it lives on the next screen.

### `src/screens/workspace/WorkspaceScaffold.tsx` — append PR section + header

New props: `{ user: User; onLogout: () => void }`. New section below watcher events:

```tsx
type PrsState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: GithubPrSearchItem[] }
  | { kind: 'error'; detail: string };

const [prs, setPrs] = useState<PrsState>({ kind: 'loading' });

useEffect(() => {
  let cancelled = false;
  githubPrs('author')
    .then(items => !cancelled && setPrs({ kind: 'ready', items }))
    .catch(e    => !cancelled && setPrs({ kind: 'error', detail: String(e) }));
  return () => { cancelled = true; };
}, []);
```

Render helpers (component-local):
- `parseRepo(repository_url)` → `{owner, repo}` via regex on `/repos/{o}/{r}$`.
- `relativeTime(iso)` → "2h ago" / "1d ago" via `Intl.RelativeTimeFormat`.

Row click opens `html_url` via `openUrl()`.

Logout button in header: `await authLogout(); onLogout();`. Errors from `authLogout` swallowed (logged to console); local logout proceeds regardless.

## Data flow

```
Boot
  AppState { api: Client::new(tauri.conf.json.backendUrl), auth: None }
  App.tsx → view: 'signIn'

User clicks "Continue with GitHub"
  SignIn → runDeviceFlow(onEvent, ac.signal)
    invoke('auth_device_start')
      → state.api.device_start()
      → POST /api/v1/auth/device/start/
      ← { device_code, user_code, verification_uri, interval, expires_in }
    onEvent('code-issued', device)
    openUrl(verification_uri)
    loop:
      invoke('auth_device_poll', { deviceCode })
        → state.api.device_poll(code)
        → POST /api/v1/auth/device/poll/
        ← { status: 'pending' }  OR  { status: 'ok', session_token, user }
      [Authorized] → state.auth = Some({ token, user.clone() });
                   return { kind: 'authorized', user };
      [Pending]    → return { kind: 'pending' }; JS sleeps interval, retries.
      [SlowDown]   → return { kind: 'slow_down' }; JS bumps interval.
      [Expired|Denied] → return that kind; JS terminates loop.
    return outcome

User now authed
  App.tsx → view: 'openRepo'

User opens a repo (existing flow, no change)
  App.tsx → view: 'workspace'

WorkspaceScaffold mounts
  invoke('github_prs', { role: 'author' })
    → state.require_token() → clone token
    → state.api.github_prs(&token, "author")
    → GET /api/v1/github/prs/?role=author with Bearer
    ← { items: [<raw github search items>], count: N }
  setPrs({ kind: 'ready', items })
  render rows

User clicks Logout
  invoke('auth_logout')
    → state.require_token()
    → state.api.logout(&token)
    → POST /api/v1/auth/logout/
    → state.auth = None
  onLogout() → App.tsx → view: 'signIn'
```

## Error handling

| Failure | UX |
|---|---|
| `device_start` transport failure | SignIn `error` state: "Couldn't reach Stage backend. Retry?" |
| `device_poll` Expired | SignIn `error` state: "GitHub code expired. Try again." |
| `device_poll` Denied | SignIn `error` state: "Authorization denied." |
| `device_poll` transport failure mid-loop | SignIn `error` state: "Lost connection during sign-in. Retry?" |
| `github_prs` failure (any) | WorkspaceScaffold PR section: "Failed to load PRs: <detail>". No re-auth fallback this PR. |
| `auth_logout` failure | Swallowed. Local state cleared anyway. Logged to console. |
| Token rejected mid-session | Demo: not expected to fire. If it does → generic error in PR section. Manual logout to recover. |

## Testing strategy

**Rust SDK unit tests** (extend the wiremock pattern from `api/auth.rs::tests`):

- `github_prs`: 200 with items, 200 with empty `items: []`, 200 with bad envelope (no `items` key) → `Error::Unexpected`, 401 → `Error::Unauthenticated`, 500 → `Error::Unexpected`, role query param honored, bearer header exact.

**Rust integration smoke:**

- `examples/github_prs_smoke.rs` mirroring `examples/auth_smoke.rs`: device flow → `github_prs("author")` → print rows. Runs against live backend. Manual.

**Tauri command tests:** skipped. Commands are 3-5 lines of glue; coverage from SDK + manual loop is sufficient at this stage.

**JS tests:** skipped — no JS test infra in the repo. Out of scope.

**Manual verification (gate for declaring done):**

1. `just dev` from repo root.
2. SignIn renders → click "Continue with GitHub".
3. Browser opens to `github.com/login/device`; webview shows user code.
4. Paste code → authorize on github.com.
5. Webview transitions to OpenRepository within `interval` seconds.
6. Pick a repo → WorkspaceScaffold shows.
7. "My GitHub PRs" section populates with open PRs authored by the github user.
8. Click a PR → opens github.com in browser.
9. Click Logout → back to SignIn.
10. Restart app → starts at SignIn (memory-only token confirmed).

## Backend env prerequisites (manual setup, not code)

For the demo to round-trip to real github, `backend/.env` must hold real credentials:

- `GITHUB_OAUTH_CLIENT_ID` + `GITHUB_OAUTH_CLIENT_SECRET` — a github OAuth App with **Device Flow enabled** (Settings → Developer settings → OAuth Apps → "Enable Device Flow").
- `GITHUB_ADMIN_PAT` — a PAT with `repo` + `read:user` so `/api/v1/github/prs/` search succeeds.

These stay local to `.env`; never commit them.

## Follow-ups (not in this PR)

- **`docs/api.md` drift on `/api/v1/github/prs/`.** Doc describes a normalized envelope; backend correctly returns raw github items. Update the doc to reflect the thin-proxy principle. Tiny docs-only commit.
- **Tagged JSON serialization for `AppError`.** Lets the webview programmatically detect `NotAuthenticated` (auto-redirect to SignIn on token expiry).
- **Keychain-backed session.** Per `STACK.md`. Swap `Mutex<Option<AuthSession>>` for a keychain-backed accessor; introduce a boot-time `auth_me` to restore the session.
- **Remove SSO button + "Skip — use Stage locally only" copy.** Separate branch per user.
- **Author/Reviewer toggle on the PR list.**
- **Click-a-PR → workspace creation bridge.**
- **JS test infra (vitest) if the front-end grows.**

## Open items at design close

None. All architectural axes resolved during brainstorm. Implementation plan can proceed.

## Verification (executed 2026-05-25)

End-to-end manual walkthrough against the Stage backend (localhost:8000) + real github OAuth App + admin PAT. Logged-in github user: `datYori`.

| Step | Result | Notes |
|---|---|---|
| 1 — SignIn renders | PASS | |
| 2 — Click → user code shown | PASS | First attempt produced an `incorrect_device_code` on github's side; second attempt clean. |
| 3 — Browser auto-opens | PASS | `tauri-plugin-opener` works as expected. |
| 4 — github.com authorize succeeds | PASS | |
| 5 — Transition to OpenRepository | PASS | After 7 pending polls (~35 s at default 5 s interval). |
| 6 — Open local repo | PASS | |
| 7 — PR list populates | PASS | `GET /api/v1/github/prs/?role=author` returned 4322 bytes. `useEffect` double-fired (React 19 dev StrictMode); `cancelled` flag prevents the late update from corrupting state. |
| 8 — PR click opens browser | PASS | |
| 9 — Logout → SignIn | PASS | `POST /api/v1/auth/logout/` returned 204. |
| 10 — Restart starts at SignIn | PASS | Memory-only token confirmed. |

End-to-end demo target reached.
