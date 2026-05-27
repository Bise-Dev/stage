# Setting up the Stage GitHub App

Stage authenticates against GitHub via a **GitHub App** (not an OAuth App). One App for prod, one for dev. Both register `http://127.0.0.1` as the callback URL.

## Registering the App

1. Open `https://github.com/settings/apps/new`.
2. Name: `Stage` (prod) or `Stage Dev` (dev).
3. Homepage URL: `http://127.0.0.1` (or your prod URL).
4. **User authorization callback URL**: `http://127.0.0.1` (no path; loopback accepts any port at request time).
5. **Expire user authorization tokens**: ✅ enabled.
6. **Request user authorization (OAuth) during installation**: ✅ enabled.
7. **Webhook**: disable (this slice does not handle webhooks).
8. **Permissions:**
   - Pull requests: Read & write
   - Issues: Read & write
   - Contents: Read-only
   - Metadata: Read-only (mandatory)
9. **Where can this GitHub App be installed?**: "Only on this account" for dev; "Any account" for prod.
10. Click **Create GitHub App**.

## Capturing credentials

- **App ID** → `GITHUB_APP_ID`
- **Client ID** → `GITHUB_APP_CLIENT_ID` (backend) and `plugins.stage.githubAppClientId` (client `tauri.conf.json`).
- Click **Generate a new client secret** → `GITHUB_APP_CLIENT_SECRET`.
- Scroll to **Private keys** → **Generate a private key** → downloads a PEM. Paste contents (multi-line) into `GITHUB_APP_PRIVATE_KEY`.

Never commit secrets. Use `.env` (gitignored) for local dev; secret manager for prod.

## Installing on a repo

1. App settings → sidebar → **Install App**.
2. Pick the account (yours for dev).
3. **Only select repositories** → pick the repos Stage may touch.
4. **Install**.

Stage can only operate on repos where it's installed. Users sign in with their normal GitHub account; the App's permissions are intersected with their access on each repo.
