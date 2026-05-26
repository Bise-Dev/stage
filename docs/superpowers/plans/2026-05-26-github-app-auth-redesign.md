# GitHub App Auth Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Stage's dual-identity auth (OAuth App device flow + admin PAT) with a single GitHub App user-to-server token model using loopback + PKCE sign-in, so every GitHub action is attributed to the signed-in user.

**Architecture:** Three-tier topology preserved. Backend holds the GitHub App's `client_secret` and per-user `GitHubIdentity` rows (access + refresh tokens with TTLs). Tauri client spawns an ephemeral `127.0.0.1` loopback listener for one-shot OAuth code capture; the code travels to the backend for exchange. Per-call `GithubGateway` is built via `make_user_gateway(user)` which transparently refreshes near-expired tokens. Bot-mode (installation tokens) is left as a single architectural seam in this slice.

**Tech Stack:** Django 5 + DRF + pytest-httpx (backend); Tauri 2 + tokio + reqwest + base64ct + sha2 + rand + wiremock (client Rust); React 19 + biome + Intl.RelativeTimeFormat (client React).

**PR strategy:** Three stacked PRs cut from this branch (`feat/github-app-auth-redesign`). Each PR is mergeable independently in the sense that lint + tests pass, but only PR 3's tip yields a working e2e app.

- **PR 1 (Tasks 1-10):** Backend.
- **PR 2 (Tasks 11-18):** Client Rust (seam).
- **PR 3 (Tasks 19-21):** React UI + manual e2e.

**Reference spec:** `docs/superpowers/specs/2026-05-26-github-app-auth-redesign-design.md`.

---

## Pre-flight: GitHub App registration (manual, one-time)

Before Task 1, register a development GitHub App. This is a manual ceremony, not automatable.

- [ ] **Step P1: Create GitHub App "Stage Dev"**
  - Open `https://github.com/settings/apps/new`.
  - Name: `Stage Dev`.
  - Homepage URL: `http://127.0.0.1`.
  - **User authorization callback URL**: `http://127.0.0.1` (no path; loopback accepts any port at runtime).
  - **Expire user authorization tokens**: ✅ enabled.
  - **Request user authorization (OAuth) during installation**: ✅ enabled.
  - **Webhook → Active**: ❌ disabled (not needed this slice).
  - **Permissions**:
    - Repository → Pull requests: **Read & write**
    - Repository → Issues: **Read & write**
    - Repository → Contents: **Read-only**
    - Repository → Metadata: **Read-only** (mandatory)
  - **Where can this GitHub App be installed?**: "Only on this account" (dev only).
  - Click **Create GitHub App**.

- [ ] **Step P2: Capture credentials**
  - Copy **App ID** (numeric) → use as `GITHUB_APP_ID`.
  - Copy **Client ID** (`Iv1.…` or `Iv23li…`) → use as `GITHUB_APP_CLIENT_ID` (backend) and `plugins.stage.githubAppClientId` (client).
  - Click **Generate a new client secret** → copy → use as `GITHUB_APP_CLIENT_SECRET`. (Never commit.)
  - Scroll to **Private keys** → **Generate a private key** → downloads `stage-dev.YYYY-MM-DD.private-key.pem`. Save in a secure location outside the repo. Use the file contents (multiline PEM) as `GITHUB_APP_PRIVATE_KEY`. (Never commit.)

- [ ] **Step P3: Install on a test repo**
  - On the App's settings page, sidebar → **Install App**.
  - Pick your personal account → **Only select repositories** → choose one repo you own that has ≥ 1 open PR you authored.
  - Click **Install**.

- [ ] **Step P4: Update local backend `.env`**
  - In `backend/.env`, remove `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_ADMIN_PAT`.
  - Add (with real values from step P2):
    ```env
    GITHUB_APP_ID=123456
    GITHUB_APP_CLIENT_ID=Iv1.abcdef0123456789
    GITHUB_APP_CLIENT_SECRET=<paste-secret>
    GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
    <multiline PEM contents>
    -----END RSA PRIVATE KEY-----"
    ```

---

# PR 1 — Backend

## Task 1: Env schema swap

**Files:**
- Modify: `backend/config/settings/env_schemas.py`
- Modify: `backend/.env.example` (if exists; create if not)

- [ ] **Step 1: Update `env_schemas.py`**

```python
# backend/config/settings/env_schemas.py
# Remove these three fields:
#   GITHUB_OAUTH_CLIENT_ID: str = "Iv1.REPLACE_ME"
#   GITHUB_OAUTH_CLIENT_SECRET: str = "REPLACE_ME"
#   GITHUB_ADMIN_PAT: str = "ghp_REPLACE_ME"
#
# Add these four fields (in the same Env class):
    GITHUB_APP_ID: int = 0
    GITHUB_APP_CLIENT_ID: str = "Iv1.REPLACE_ME"
    GITHUB_APP_CLIENT_SECRET: str = "REPLACE_ME"
    GITHUB_APP_PRIVATE_KEY: str = "-----BEGIN RSA PRIVATE KEY-----\nREPLACE_ME\n-----END RSA PRIVATE KEY-----"
#
# GITHUB_API_BASE: str = "https://api.github.com"  — keep unchanged.
```

- [ ] **Step 2: Run pyrefly + ruff**

```bash
cd backend && uv run pre-commit run --all-files
just typecheck
```

Expected: PASS. (References to removed env vars elsewhere in the codebase will start failing later tasks, not this one — fixed task-by-task.)

- [ ] **Step 3: Commit**

```bash
git add backend/config/settings/env_schemas.py backend/.env.example
git commit -m "feat(backend/identity): swap OAuth App + PAT env vars for GitHub App vars"
```

---

## Task 2: GitHubIdentity model + migration + factory

**Files:**
- Modify: `backend/apps/identity/models.py`
- Create: `backend/apps/identity/migrations/0002_githubidentity.py` (generated by Django)
- Modify: `backend/apps/identity/factories.py`
- Create: `backend/tests/identity/test_models.py`

- [ ] **Step 1: Add `GitHubIdentity` model**

```python
# backend/apps/identity/models.py
from django.db import models

from apps.core.models import BaseModel
from apps.users.models import User


class Session(BaseModel):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="sessions")
    token_hash = models.CharField(max_length=64, db_index=True)
    last_used_at = models.DateTimeField(auto_now=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:  # pyrefly: ignore[bad-override]
        db_table = "identity_session"


class GitHubIdentity(BaseModel):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="github_identity")
    access_token = models.TextField()
    refresh_token = models.TextField()
    access_token_expires_at = models.DateTimeField()
    refresh_token_expires_at = models.DateTimeField()

    class Meta:  # pyrefly: ignore[bad-override]
        db_table = "identity_githubidentity"
```

- [ ] **Step 2: Generate migration**

```bash
cd backend && uv run python manage.py makemigrations identity
```

Expected output: `Migrations for 'identity': 0002_githubidentity.py — Create model GitHubIdentity`.

- [ ] **Step 3: Apply migration**

```bash
cd backend && uv run python manage.py migrate identity
```

Expected: `Applying identity.0002_githubidentity... OK`.

- [ ] **Step 4: Add factory**

```python
# backend/apps/identity/factories.py
import datetime as dt

import factory
from django.utils import timezone

from apps.identity.models import GitHubIdentity, Session
from apps.users.factories import UserFactory


class SessionFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Session

    user = factory.SubFactory(UserFactory)
    token_hash = factory.Sequence(lambda n: f"hash{n:062d}")


class GitHubIdentityFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = GitHubIdentity

    user = factory.SubFactory(UserFactory)
    access_token = factory.Sequence(lambda n: f"ghu_test_access_{n}")
    refresh_token = factory.Sequence(lambda n: f"ghr_test_refresh_{n}")
    access_token_expires_at = factory.LazyFunction(
        lambda: timezone.now() + dt.timedelta(hours=8)
    )
    refresh_token_expires_at = factory.LazyFunction(
        lambda: timezone.now() + dt.timedelta(days=180)
    )
```

- [ ] **Step 5: Write model smoke test**

```python
# backend/tests/identity/test_models.py
import pytest
from django.utils import timezone

from apps.identity.factories import GitHubIdentityFactory


@pytest.mark.django_db
def test_github_identity_factory_creates_row():
    identity = GitHubIdentityFactory()
    assert identity.pk is not None
    assert identity.access_token.startswith("ghu_test_access_")
    assert identity.refresh_token.startswith("ghr_test_refresh_")
    assert identity.access_token_expires_at > timezone.now()
    assert identity.refresh_token_expires_at > identity.access_token_expires_at


@pytest.mark.django_db
def test_github_identity_one_per_user():
    identity = GitHubIdentityFactory()
    # OneToOne ⇒ second attempt for same user must fail.
    from django.db import IntegrityError

    with pytest.raises(IntegrityError):
        GitHubIdentityFactory(user=identity.user)
```

- [ ] **Step 6: Run tests**

```bash
cd backend && uv run pytest tests/identity/test_models.py -v
```

Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add backend/apps/identity/models.py backend/apps/identity/migrations/0002_githubidentity.py backend/apps/identity/factories.py backend/tests/identity/test_models.py
git commit -m "feat(backend/identity): add GitHubIdentity model + migration + factory"
```

---

## Task 3: `github_app.py` module (rename from `github_oauth.py`, replace contents)

**Files:**
- Delete: `backend/apps/identity/github_oauth.py`
- Create: `backend/apps/identity/github_app.py`
- Create: `backend/tests/identity/test_github_app.py`

- [ ] **Step 1: Delete old module**

```bash
git rm backend/apps/identity/github_oauth.py
```

- [ ] **Step 2: Create `github_app.py`**

```python
# backend/apps/identity/github_app.py
import httpx
import structlog

from apps.core.exceptions import ApplicationError
from config.settings.env_schemas import env

logger = structlog.get_logger(__name__)

_TOKEN_URL = "https://github.com/login/oauth/access_token"
_USER_URL = f"{env.GITHUB_API_BASE}/user"


def exchange_code(*, code: str, code_verifier: str, redirect_uri: str) -> dict:
    """Exchange an OAuth code for user-to-server tokens. Returns the GitHub payload."""
    r = httpx.post(
        _TOKEN_URL,
        data={
            "client_id": env.GITHUB_APP_CLIENT_ID,
            "client_secret": env.GITHUB_APP_CLIENT_SECRET,
            "code": code,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
        },
        headers={"Accept": "application/json"},
        timeout=10.0,
    )
    r.raise_for_status()
    body = r.json()
    err = body.get("error")
    if err:
        logger.warning("github_code_exchange_error", error=err)
        raise ApplicationError(
            "github_code_invalid",
            extra={"error": err},
            status=400,
        )
    logger.info("github_code_exchange_ok")
    return body


def refresh(*, refresh_token: str) -> dict:
    """Refresh a user-to-server token. Returns the new GitHub payload."""
    r = httpx.post(
        _TOKEN_URL,
        data={
            "client_id": env.GITHUB_APP_CLIENT_ID,
            "client_secret": env.GITHUB_APP_CLIENT_SECRET,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        headers={"Accept": "application/json"},
        timeout=10.0,
    )
    r.raise_for_status()
    body = r.json()
    err = body.get("error")
    if err:
        logger.warning("github_refresh_error", error=err)
        raise ApplicationError(
            "github_reauth_required",
            extra={"error": err},
            status=401,
        )
    logger.info("github_refresh_ok")
    return body


def fetch_user(*, access_token: str) -> dict:
    r = httpx.get(
        _USER_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/vnd.github+json",
        },
        timeout=10.0,
    )
    r.raise_for_status()
    return r.json()


def mint_installation_token(*, installation_id: int) -> dict:
    """Mints an installation access token (bot-mode). Out of scope this slice."""
    raise NotImplementedError("Bot-mode installation tokens land in a follow-up.")
```

- [ ] **Step 3: Write tests**

```python
# backend/tests/identity/test_github_app.py
import pytest
from pytest_httpx import HTTPXMock

from apps.core.exceptions import ApplicationError
from apps.identity import github_app


def test_exchange_code_returns_payload_on_ok(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://github.com/login/oauth/access_token",
        method="POST",
        json={
            "access_token": "ghu_AAA",
            "refresh_token": "ghr_BBB",
            "expires_in": 28800,
            "refresh_token_expires_in": 15897600,
            "token_type": "bearer",
            "scope": "",
        },
    )
    result = github_app.exchange_code(
        code="abc",
        code_verifier="verifier_xyz",
        redirect_uri="http://127.0.0.1:1234/cb",
    )
    assert result["access_token"] == "ghu_AAA"
    assert result["refresh_token"] == "ghr_BBB"
    assert result["expires_in"] == 28800


def test_exchange_code_raises_on_bad_verification_code(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://github.com/login/oauth/access_token",
        method="POST",
        json={"error": "bad_verification_code"},
    )
    with pytest.raises(ApplicationError) as exc:
        github_app.exchange_code(
            code="bad",
            code_verifier="v",
            redirect_uri="http://127.0.0.1:1234/cb",
        )
    assert exc.value.message == "github_code_invalid"
    assert exc.value.extra == {"error": "bad_verification_code"}
    assert exc.value.status == 400


def test_refresh_returns_payload_on_ok(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://github.com/login/oauth/access_token",
        method="POST",
        json={
            "access_token": "ghu_CCC",
            "refresh_token": "ghr_DDD",
            "expires_in": 28800,
            "refresh_token_expires_in": 15897600,
            "token_type": "bearer",
        },
    )
    result = github_app.refresh(refresh_token="ghr_BBB")
    assert result["access_token"] == "ghu_CCC"
    assert result["refresh_token"] == "ghr_DDD"


def test_refresh_raises_reauth_required_on_bad_refresh_token(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://github.com/login/oauth/access_token",
        method="POST",
        json={"error": "bad_refresh_token"},
    )
    with pytest.raises(ApplicationError) as exc:
        github_app.refresh(refresh_token="ghr_dead")
    assert exc.value.message == "github_reauth_required"
    assert exc.value.status == 401


def test_fetch_user_returns_profile(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://api.github.com/user",
        method="GET",
        json={"id": 42, "login": "alice", "name": "Alice", "avatar_url": "https://a"},
    )
    result = github_app.fetch_user(access_token="ghu_X")
    assert result["login"] == "alice"


def test_mint_installation_token_is_stub():
    with pytest.raises(NotImplementedError):
        github_app.mint_installation_token(installation_id=1)
```

- [ ] **Step 4: Run tests**

```bash
cd backend && uv run pytest tests/identity/test_github_app.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/apps/identity/github_app.py backend/apps/identity/github_oauth.py backend/tests/identity/test_github_app.py
git commit -m "feat(backend/identity): add github_app module (exchange_code, refresh, fetch_user)"
```

---

## Task 4: `identity/services.py` — token upsert + refresh

**Files:**
- Modify: `backend/apps/identity/services.py`
- Create: `backend/tests/identity/test_services_github_identity.py`

- [ ] **Step 1: Extend `services.py`**

```python
# backend/apps/identity/services.py
import datetime as dt
import hashlib
import secrets

from django.db import transaction
from django.utils import timezone

from apps.identity import github_app
from apps.identity.models import GitHubIdentity, Session
from apps.users.models import User


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


@transaction.atomic
def session_issue(*, user: User) -> tuple[str, Session]:
    raw = "stg_" + secrets.token_urlsafe(32)
    session = Session.objects.create(user=user, token_hash=_hash_token(raw))
    return raw, session


@transaction.atomic
def session_revoke(*, session: Session) -> None:
    session.revoked_at = timezone.now()
    session.save(update_fields=["revoked_at", "updated_at"])


@transaction.atomic
def user_upsert_from_github(*, github_payload: dict) -> User:
    user, _ = User.objects.update_or_create(
        github_user_id=github_payload["id"],
        defaults={
            "username": github_payload["login"],
            "github_login": github_payload["login"],
            "display_name": github_payload.get("name") or "",
            "avatar_url": github_payload.get("avatar_url") or "",
            "last_login_at": timezone.now(),
        },
    )
    return user


@transaction.atomic
def github_identity_upsert(*, user: User, payload: dict) -> GitHubIdentity:
    now = timezone.now()
    identity, _ = GitHubIdentity.objects.update_or_create(
        user=user,
        defaults={
            "access_token": payload["access_token"],
            "refresh_token": payload["refresh_token"],
            "access_token_expires_at": now + dt.timedelta(seconds=payload["expires_in"]),
            "refresh_token_expires_at": now
            + dt.timedelta(seconds=payload["refresh_token_expires_in"]),
        },
    )
    return identity


def github_identity_ensure_fresh(*, identity: GitHubIdentity) -> GitHubIdentity:
    """Refresh the access token if it expires within 60 s. Deletes identity + raises on bad_refresh_token."""
    from apps.core.exceptions import ApplicationError

    threshold = timezone.now() + dt.timedelta(seconds=60)
    if identity.access_token_expires_at > threshold:
        return identity
    user = identity.user
    try:
        new_payload = github_app.refresh(refresh_token=identity.refresh_token)
    except ApplicationError as exc:
        if exc.message == "github_reauth_required":
            identity.delete()
        raise
    return github_identity_upsert(user=user, payload=new_payload)
```

- [ ] **Step 2: Write tests**

```python
# backend/tests/identity/test_services_github_identity.py
import datetime as dt

import pytest
from django.utils import timezone
from pytest_httpx import HTTPXMock

from apps.core.exceptions import ApplicationError
from apps.identity.factories import GitHubIdentityFactory
from apps.identity.models import GitHubIdentity
from apps.identity.services import github_identity_ensure_fresh, github_identity_upsert
from apps.users.factories import UserFactory


@pytest.mark.django_db
def test_github_identity_upsert_creates_row_when_missing():
    user = UserFactory()
    payload = {
        "access_token": "ghu_NEW",
        "refresh_token": "ghr_NEW",
        "expires_in": 28800,
        "refresh_token_expires_in": 15897600,
    }
    identity = github_identity_upsert(user=user, payload=payload)
    assert identity.user_id == user.pk
    assert identity.access_token == "ghu_NEW"
    assert identity.refresh_token == "ghr_NEW"


@pytest.mark.django_db
def test_github_identity_upsert_rotates_existing_row():
    identity = GitHubIdentityFactory()
    payload = {
        "access_token": "ghu_ROTATED",
        "refresh_token": "ghr_ROTATED",
        "expires_in": 28800,
        "refresh_token_expires_in": 15897600,
    }
    updated = github_identity_upsert(user=identity.user, payload=payload)
    assert updated.pk == identity.pk
    assert updated.access_token == "ghu_ROTATED"
    assert updated.refresh_token == "ghr_ROTATED"
    assert GitHubIdentity.objects.count() == 1


@pytest.mark.django_db
def test_github_identity_ensure_fresh_skips_refresh_when_far_from_expiry(httpx_mock: HTTPXMock):
    identity = GitHubIdentityFactory()  # default: 8 h in the future
    result = github_identity_ensure_fresh(identity=identity)
    assert result.pk == identity.pk
    assert result.access_token == identity.access_token
    # No HTTP call was made — httpx_mock would have failed if one was unmatched.


@pytest.mark.django_db
def test_github_identity_ensure_fresh_refreshes_near_expiry(httpx_mock: HTTPXMock):
    identity = GitHubIdentityFactory(
        access_token_expires_at=timezone.now() + dt.timedelta(seconds=10)
    )
    httpx_mock.add_response(
        url="https://github.com/login/oauth/access_token",
        method="POST",
        json={
            "access_token": "ghu_REFRESHED",
            "refresh_token": "ghr_REFRESHED",
            "expires_in": 28800,
            "refresh_token_expires_in": 15897600,
            "token_type": "bearer",
        },
    )
    result = github_identity_ensure_fresh(identity=identity)
    assert result.access_token == "ghu_REFRESHED"
    assert result.refresh_token == "ghr_REFRESHED"


@pytest.mark.django_db
def test_github_identity_ensure_fresh_deletes_row_on_bad_refresh(httpx_mock: HTTPXMock):
    identity = GitHubIdentityFactory(
        access_token_expires_at=timezone.now() - dt.timedelta(minutes=1)
    )
    httpx_mock.add_response(
        url="https://github.com/login/oauth/access_token",
        method="POST",
        json={"error": "bad_refresh_token"},
    )
    with pytest.raises(ApplicationError) as exc:
        github_identity_ensure_fresh(identity=identity)
    assert exc.value.message == "github_reauth_required"
    assert not GitHubIdentity.objects.filter(pk=identity.pk).exists()
```

- [ ] **Step 3: Run tests**

```bash
cd backend && uv run pytest tests/identity/test_services_github_identity.py -v
```

Expected: 5 passed.

- [ ] **Step 4: Commit**

```bash
git add backend/apps/identity/services.py backend/tests/identity/test_services_github_identity.py
git commit -m "feat(backend/identity): add github_identity_upsert + ensure_fresh services"
```

---

## Task 5: `AuthWebExchangeApi` + serializer + URL

**Files:**
- Create: `backend/apps/identity/serializers/web_exchange_input.py`
- Modify: `backend/apps/identity/apis.py`
- Modify: `backend/apps/identity/urls.py`
- Modify: `backend/tests/identity/test_apis.py` (create if missing — likely exists from previous device-flow tests)

- [ ] **Step 1: Create input serializer**

```python
# backend/apps/identity/serializers/web_exchange_input.py
from rest_framework import serializers


class WebExchangeInputSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=512)
    code_verifier = serializers.CharField(min_length=43, max_length=128)
    redirect_uri = serializers.URLField()
```

- [ ] **Step 2: Add `AuthWebExchangeApi` to `apis.py`**

Replace `apis.py` contents with:

```python
# backend/apps/identity/apis.py
from typing import ClassVar

from rest_framework import authentication, status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.identity.github_app import exchange_code, fetch_user
from apps.identity.models import Session
from apps.identity.selectors import _hash_token
from apps.identity.serializers.device_poll_ok_output import DevicePollOkOutputSerializer
from apps.identity.serializers.user_output import UserOutputSerializer
from apps.identity.serializers.web_exchange_input import WebExchangeInputSerializer
from apps.identity.services import (
    github_identity_upsert,
    session_issue,
    session_revoke,
    user_upsert_from_github,
)


class AuthWebExchangeApi(APIView):
    permission_classes = [AllowAny]
    authentication_classes: ClassVar[list[type[authentication.BaseAuthentication]]] = []  # pyrefly: ignore[bad-override]

    def post(self, request: Request) -> Response:
        serializer = WebExchangeInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = exchange_code(
            code=serializer.validated_data["code"],
            code_verifier=serializer.validated_data["code_verifier"],
            redirect_uri=serializer.validated_data["redirect_uri"],
        )
        gh_user = fetch_user(access_token=payload["access_token"])
        user = user_upsert_from_github(github_payload=gh_user)
        github_identity_upsert(user=user, payload=payload)
        raw, _ = session_issue(user=user)
        return Response(
            DevicePollOkOutputSerializer({
                "status": "ok",
                "session_token": raw,
                "user": user,
            }).data,
        )


class AuthMeApi(APIView):
    def get(self, request: Request) -> Response:
        return Response(UserOutputSerializer(request.user).data)


class AuthLogoutApi(APIView):
    def post(self, request: Request) -> Response:
        raw = request.auth
        if raw:
            session = Session.objects.filter(
                token_hash=_hash_token(str(raw)),
                revoked_at__isnull=True,
            ).first()
            if session:
                session_revoke(session=session)
        return Response(status=status.HTTP_204_NO_CONTENT)
```

Note: `DevicePollOkOutputSerializer` is reused for now (same shape `{status, session_token, user}`); renaming it is deferred (see Task 6).

- [ ] **Step 3: Update `urls.py`**

```python
# backend/apps/identity/urls.py
from django.urls import path

from apps.identity import apis

app_name = "identity"

urlpatterns = [
    path("auth/web/exchange/", apis.AuthWebExchangeApi.as_view(), name="auth_web_exchange"),
    path("auth/me/", apis.AuthMeApi.as_view(), name="auth_me"),
    path("auth/logout/", apis.AuthLogoutApi.as_view(), name="auth_logout"),
]
```

- [ ] **Step 4: Write integration tests**

```python
# backend/tests/identity/test_apis.py
import pytest
from django.urls import reverse
from pytest_httpx import HTTPXMock
from rest_framework.test import APIClient

from apps.identity.models import GitHubIdentity, Session
from apps.users.models import User


@pytest.mark.django_db
def test_auth_web_exchange_creates_user_identity_and_session(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://github.com/login/oauth/access_token",
        method="POST",
        json={
            "access_token": "ghu_TESTAA",
            "refresh_token": "ghr_TESTBB",
            "expires_in": 28800,
            "refresh_token_expires_in": 15897600,
            "token_type": "bearer",
        },
    )
    httpx_mock.add_response(
        url="https://api.github.com/user",
        method="GET",
        json={
            "id": 99,
            "login": "carol",
            "name": "Carol",
            "avatar_url": "https://a.example/carol.png",
        },
    )
    client = APIClient()
    resp = client.post(
        reverse("identity:auth_web_exchange"),
        {
            "code": "abc",
            "code_verifier": "v" * 43,
            "redirect_uri": "http://127.0.0.1:8765/cb",
        },
        format="json",
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["session_token"].startswith("stg_")
    assert body["user"]["github_login"] == "carol"
    user = User.objects.get(github_login="carol")
    assert GitHubIdentity.objects.filter(user=user, access_token="ghu_TESTAA").exists()
    assert Session.objects.filter(user=user).count() == 1


@pytest.mark.django_db
def test_auth_web_exchange_returns_400_on_bad_verification_code(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://github.com/login/oauth/access_token",
        method="POST",
        json={"error": "bad_verification_code"},
    )
    client = APIClient()
    resp = client.post(
        reverse("identity:auth_web_exchange"),
        {
            "code": "bad",
            "code_verifier": "v" * 43,
            "redirect_uri": "http://127.0.0.1:8765/cb",
        },
        format="json",
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["message"] == "github_code_invalid"


@pytest.mark.django_db
def test_auth_web_exchange_rejects_short_verifier():
    client = APIClient()
    resp = client.post(
        reverse("identity:auth_web_exchange"),
        {
            "code": "abc",
            "code_verifier": "too-short",
            "redirect_uri": "http://127.0.0.1:8765/cb",
        },
        format="json",
    )
    assert resp.status_code == 400
```

- [ ] **Step 5: Run tests**

```bash
cd backend && uv run pytest tests/identity/test_apis.py -v
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/apps/identity/serializers/web_exchange_input.py backend/apps/identity/apis.py backend/apps/identity/urls.py backend/tests/identity/test_apis.py
git commit -m "feat(backend/identity): add /auth/web/exchange/ endpoint"
```

---

## Task 6: Remove device-flow remnants

**Files:**
- Delete: `backend/apps/identity/serializers/device_poll_input.py`
- Delete: `backend/apps/identity/serializers/device_poll_ok_output.py`
- Delete: `backend/apps/identity/serializers/device_poll_pending_output.py`
- Create: `backend/apps/identity/serializers/web_exchange_output.py`
- Modify: `backend/apps/identity/apis.py` (swap output serializer to the renamed one)
- Modify: `backend/tests/identity/test_apis.py` (drop any device-flow tests; rename uses)

- [ ] **Step 1: Create renamed output serializer**

```python
# backend/apps/identity/serializers/web_exchange_output.py
from rest_framework import serializers

from apps.identity.serializers.user_output import UserOutputSerializer


class WebExchangeOutputSerializer(serializers.Serializer):
    status = serializers.CharField()
    session_token = serializers.CharField()
    user = UserOutputSerializer()
```

- [ ] **Step 2: Swap the import in `apis.py`**

In `backend/apps/identity/apis.py`, change:
```python
from apps.identity.serializers.device_poll_ok_output import DevicePollOkOutputSerializer
```
to
```python
from apps.identity.serializers.web_exchange_output import WebExchangeOutputSerializer
```
and replace `DevicePollOkOutputSerializer({...})` with `WebExchangeOutputSerializer({...})`.

- [ ] **Step 3: Delete device-flow files**

```bash
git rm backend/apps/identity/serializers/device_poll_input.py
git rm backend/apps/identity/serializers/device_poll_ok_output.py
git rm backend/apps/identity/serializers/device_poll_pending_output.py
```

- [ ] **Step 4: Drop any device-flow tests**

If `backend/tests/identity/test_apis.py` has `test_device_*` tests carried over from the previous slice, delete those test functions. The two valid ones from Task 5 (web exchange) stay.

- [ ] **Step 5: Run tests + lint**

```bash
cd backend && uv run pytest tests/identity/ -v && uv run pre-commit run --all-files && just typecheck
```

Expected: PASS, no references to removed names.

- [ ] **Step 6: Commit**

```bash
git add backend/apps/identity/serializers/ backend/apps/identity/apis.py backend/tests/identity/test_apis.py
git commit -m "refactor(backend/identity): drop device-flow serializers, rename output to WebExchangeOutput"
```

---

## Task 7: `make_user_gateway` factory

**Files:**
- Modify: `backend/apps/github_proxy/gateway.py`
- Create: `backend/tests/github_proxy/test_gateway_factory.py`

- [ ] **Step 1: Add `make_user_gateway` to `gateway.py`**

Append to `backend/apps/github_proxy/gateway.py` (do NOT touch the existing `GithubGateway` class):

```python
# Append at bottom of backend/apps/github_proxy/gateway.py
from apps.core.exceptions import ApplicationError as _ApplicationError  # noqa: E402
from apps.identity.services import github_identity_ensure_fresh as _ensure_fresh  # noqa: E402
from apps.users.models import User as _User  # noqa: E402


def make_user_gateway(user: "_User") -> "GithubGateway":
    """Build a GithubGateway authenticated as the given user. Transparently refreshes near-expired tokens."""
    if not hasattr(user, "github_identity"):
        raise _ApplicationError("github_reauth_required", status=401)
    try:
        identity = user.github_identity
    except _User.github_identity.RelatedObjectDoesNotExist:
        raise _ApplicationError("github_reauth_required", status=401)
    identity = _ensure_fresh(identity=identity)
    return GithubGateway(token=identity.access_token)
```

(Naming with underscores avoids polluting the module's public surface; mirrors patterns elsewhere in the codebase.)

- [ ] **Step 2: Write factory tests**

```python
# backend/tests/github_proxy/test_gateway_factory.py
import datetime as dt

import pytest
from django.utils import timezone
from pytest_httpx import HTTPXMock

from apps.core.exceptions import ApplicationError
from apps.github_proxy.gateway import make_user_gateway
from apps.identity.factories import GitHubIdentityFactory
from apps.users.factories import UserFactory


@pytest.mark.django_db
def test_make_user_gateway_uses_user_token():
    identity = GitHubIdentityFactory(access_token="ghu_FRESH")
    gw = make_user_gateway(identity.user)
    # Inspect httpx client headers (read-only access).
    auth_header = gw._client.headers["Authorization"]
    assert auth_header == "token ghu_FRESH"
    gw.close()


@pytest.mark.django_db
def test_make_user_gateway_refreshes_near_expiry(httpx_mock: HTTPXMock):
    identity = GitHubIdentityFactory(
        access_token="ghu_STALE",
        access_token_expires_at=timezone.now() + dt.timedelta(seconds=10),
    )
    httpx_mock.add_response(
        url="https://github.com/login/oauth/access_token",
        method="POST",
        json={
            "access_token": "ghu_REFRESHED",
            "refresh_token": "ghr_NEW",
            "expires_in": 28800,
            "refresh_token_expires_in": 15897600,
            "token_type": "bearer",
        },
    )
    gw = make_user_gateway(identity.user)
    assert gw._client.headers["Authorization"] == "token ghu_REFRESHED"
    gw.close()


@pytest.mark.django_db
def test_make_user_gateway_raises_reauth_required_when_no_identity():
    user = UserFactory()  # no GitHubIdentity
    with pytest.raises(ApplicationError) as exc:
        make_user_gateway(user)
    assert exc.value.message == "github_reauth_required"
    assert exc.value.status == 401
```

- [ ] **Step 3: Run tests**

```bash
cd backend && uv run pytest tests/github_proxy/test_gateway_factory.py -v
```

Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add backend/apps/github_proxy/gateway.py backend/tests/github_proxy/test_gateway_factory.py
git commit -m "feat(backend/github_proxy): add make_user_gateway factory with transparent refresh"
```

---

## Task 8: Swap `_gateway()` → `make_user_gateway(request.user)` in proxy + workspaces

**Files:**
- Modify: `backend/apps/github_proxy/apis.py`
- Modify: `backend/apps/workspaces/apis.py`
- Modify: existing tests under `backend/tests/github_proxy/` and `backend/tests/workspaces/` (rely on `GitHubIdentityFactory` fixtures going forward)

- [ ] **Step 1: Update `github_proxy/apis.py`**

Replace the local `_gateway()` helper:
```python
# REMOVE:
def _gateway() -> GithubGateway:
    return GithubGateway(token=env.GITHUB_ADMIN_PAT)

# Drop the unused import:
from config.settings.env_schemas import env
```

Add the new import:
```python
from apps.github_proxy.gateway import make_user_gateway
```

Replace every `with _gateway() as g:` with `with make_user_gateway(request.user) as g:`. Each `APIView`'s method body becomes:

```python
class PullRequestDetailApi(APIView):
    def get(self, request: Request, o: str, r: str, n: int) -> Response:
        with make_user_gateway(request.user) as g:
            return Response(g.get_pr(o, r, n))
```

…and analogously for `PullRequestFilesApi`, `PullRequestFileDiffApi`, `PullRequestFileCommentsApi`, `PullRequestCommentsApi`, `PullRequestReviewsApi`, `PullRequestChecksApi`, `PullRequestCommentCreateApi`, `PullRequestReviewCreateApi`, `GithubPullsSearchApi`, `PullRequestActionApi`.

- [ ] **Step 2: Update `workspaces/apis.py`**

Same pattern: remove the `_gateway()` helper and `env` import, add `from apps.github_proxy.gateway import make_user_gateway`, and replace each `with _gateway() as g:` with `with make_user_gateway(request.user) as g:`.

- [ ] **Step 3: Update existing proxy/workspace test fixtures to attach a `GitHubIdentity`**

In every test under `backend/tests/github_proxy/` and `backend/tests/workspaces/` that currently authenticates a user via `APIClient.force_authenticate(user=…)`, also create an identity:

```python
# Pattern to apply per test (or via fixture):
from apps.identity.factories import GitHubIdentityFactory

user = UserFactory()
GitHubIdentityFactory(user=user)
client = APIClient()
client.force_authenticate(user=user)
```

If a conftest exists at `backend/tests/conftest.py`, prefer adding a fixture:

```python
# backend/tests/conftest.py — append (do not duplicate if a similar fixture already exists)
import pytest
from apps.identity.factories import GitHubIdentityFactory
from apps.users.factories import UserFactory


@pytest.fixture
def authed_user(db):
    user = UserFactory()
    GitHubIdentityFactory(user=user)
    return user
```

Tests then take `authed_user` instead of building a user manually.

- [ ] **Step 4: Run the full backend test suite**

```bash
cd backend && uv run pytest -v
```

Expected: all green. Any failures here mean a test was missed in Step 3 — patch it and re-run.

- [ ] **Step 5: Run lint + typecheck**

```bash
cd backend && uv run pre-commit run --all-files && just typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/apps/github_proxy/apis.py backend/apps/workspaces/apis.py backend/tests/
git commit -m "refactor(backend/proxy): use make_user_gateway(request.user) instead of admin PAT"
```

---

## Task 9: ADRs

**Files:**
- Create: `docs/adr/0007-github-app-user-to-server-loopback.md`
- Modify: `docs/adr/0005-local-client-sdk-hand-rolls-device-flow.md` (add superseded header)

- [ ] **Step 1: Create ADR-0007**

```markdown
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
```

- [ ] **Step 2: Add superseded header to ADR-0005**

In `docs/adr/0005-local-client-sdk-hand-rolls-device-flow.md`, change the status line at the top of the file:

```markdown
# ADR-0005 · Local Client SDK hand-rolls the device-flow vocabulary

**Status:** superseded by [ADR-0007](./0007-github-app-user-to-server-loopback.md) (2026-05-26)
**Date:** 2026-05-24
```

Leave the rest of the file unchanged.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0007-github-app-user-to-server-loopback.md docs/adr/0005-local-client-sdk-hand-rolls-device-flow.md
git commit -m "docs(adr): ADR-0007 (GitHub App + loopback + PKCE), supersedes ADR-0005"
```

---

## Task 10: Docs updates + setup guide

**Files:**
- Modify: `docs/api.md`
- Create: `docs/setup-github-app.md`

- [ ] **Step 1: Update `docs/api.md`**

Find the `### POST /api/v1/auth/device/start/` and `### POST /api/v1/auth/device/poll/` sections (and the surrounding intro paragraph mentioning the device flow). Replace the whole block with:

```markdown
### POST /api/v1/auth/web/exchange/

Exchanges an OAuth `code` (captured by the client's loopback listener after the user authorized Stage at `https://github.com/login/oauth/authorize`) for a Stage session.

**Request body:**

```json
{
  "code": "abc123",
  "code_verifier": "<43-128 char PKCE verifier>",
  "redirect_uri": "http://127.0.0.1:54321/cb"
}
```

**200 OK response:**

```json
{
  "status": "ok",
  "session_token": "stg_<43-char base64url>",
  "user": {
    "id": 12,
    "github_login": "alice",
    "display_name": "Alice",
    "avatar_url": "https://avatars.githubusercontent.com/u/123"
  }
}
```

**400 errors:** `github_code_invalid`, validation (short verifier, missing field).
**502:** `github_unreachable`.
**500:** `github_app_misconfigured`.

See [ADR-0007](adr/0007-github-app-user-to-server-loopback.md) for design.
```

If `docs/api.md` has a normalization-style description of `/github/prs/` that still talks about a custom envelope (`repo_owner`, `repo_name`, etc.), this remains drift — note in the commit message that the proxy doc still needs a follow-up sync.

- [ ] **Step 2: Create `docs/setup-github-app.md`**

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add docs/api.md docs/setup-github-app.md
git commit -m "docs: replace /auth/device docs with /auth/web/exchange + add setup-github-app.md"
```

---

## Task 10b: PR 1 wrap — run full backend suite + open PR

- [ ] **Step 1: Run full verify pipeline**

```bash
cd backend && uv run pre-commit run --all-files && just typecheck && just test
```

Expected: PASS across the board.

- [ ] **Step 2: Inspect for residual references**

```bash
grep -rn "GITHUB_ADMIN_PAT\|device_start\|device_poll\|GITHUB_OAUTH" backend/ docs/ \
  | grep -v ".venv\|node_modules\|target\|dist\|.git\|migrations\|0005-local-client"
```

Expected: 0 hits.

- [ ] **Step 3: Open PR 1**

```bash
git push -u origin feat/github-app-auth-redesign
gh pr create --title "feat(backend): GitHub App user-to-server auth (PR 1/3)" --body "$(cat <<'EOF'
## Summary

- Replace OAuth App device flow + GITHUB_ADMIN_PAT with a single GitHub App user-to-server token model.
- New \`GitHubIdentity\` model holds per-user \`ghu_…\` + \`ghr_…\` tokens with TTLs.
- \`make_user_gateway(user)\` transparently refreshes near-expired tokens before each proxy call.
- New \`/auth/web/exchange/\` endpoint exchanges OAuth code + PKCE verifier for a Stage session.
- ADR-0007 records the design and supersedes ADR-0005.

## Test plan
- [ ] \`cd backend && uv run pytest -v\` → all green
- [ ] \`cd backend && uv run pre-commit run --all-files\` → clean
- [ ] \`just typecheck\` → clean
- [ ] Manual: hit \`/auth/web/exchange/\` via curl with a real code from a throwaway loopback listener; verify session + identity rows created.

PR 2 (client Rust seam) follows; PR 3 (UI) after that.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR 2 — Client Rust seam

> **Branch base for PR 2:** the merged tip of PR 1.
> **Note:** during local development of PR 2, you can branch from PR 1's branch even before it merges; the steps below assume you're on a branch that has PR 1's commits.

## Task 11: Cargo dependencies + Tauri config

**Files:**
- Modify: `client/src-tauri/Cargo.toml`
- Modify: `client/src-tauri/tauri.conf.json`

- [ ] **Step 1: Add dependencies to `Cargo.toml`**

In `client/src-tauri/Cargo.toml`, under `[dependencies]`, add:

```toml
base64ct = { version = "1", features = ["alloc"] }
sha2 = "0.10"
rand = "0.8"
```

(`tokio`, `reqwest`, `serde`, `parking_lot`, `tauri-plugin-opener` are already present from the previous slice.)

- [ ] **Step 2: Resolve deps**

```bash
cd client/src-tauri && cargo check
```

Expected: download + compile clean; no warnings about unused deps yet (they'll be used in Task 12).

- [ ] **Step 3: Add `githubAppClientId` to `tauri.conf.json`**

Edit `client/src-tauri/tauri.conf.json` so the `plugins` section becomes:

```json
"plugins": {
  "stage": {
    "backendUrl": "http://localhost:8000",
    "githubAppClientId": "Iv1.REPLACE_WITH_DEV_APP_CLIENT_ID"
  }
}
```

(The real value should match the App's Client ID from the pre-flight ceremony.)

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/Cargo.toml client/src-tauri/Cargo.lock client/src-tauri/tauri.conf.json
git commit -m "chore(client): add base64ct + sha2 + rand deps and githubAppClientId config"
```

---

## Task 12: `oauth.rs` — PKCE helpers + state + authorize URL

**Files:**
- Create: `client/src-tauri/src/oauth.rs`
- Modify: `client/src-tauri/src/lib.rs` (register the new module)

- [ ] **Step 1: Create `oauth.rs` skeleton with PKCE + state + URL helpers**

```rust
// client/src-tauri/src/oauth.rs
use base64ct::{Base64UrlUnpadded, Encoding};
use rand::RngCore;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum OauthError {
    #[error("could not bind loopback listener: {0}")]
    BindFailed(std::io::Error),
    #[error("timeout waiting for callback")]
    Timeout,
    #[error("state mismatch on callback")]
    StateMismatch,
    #[error("user denied authorization")]
    UserDenied,
    #[error("github oauth error: {0}")]
    GithubError(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("sign-in cancelled")]
    Cancelled,
}

pub fn pkce_pair() -> (String, String) {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let verifier = Base64UrlUnpadded::encode_string(&buf);
    let challenge = Base64UrlUnpadded::encode_string(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn gen_state() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    Base64UrlUnpadded::encode_string(&buf)
}

pub fn authorize_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
) -> String {
    // Build manually rather than depending on url crate; only 4 params, all URL-safe.
    format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256",
        client_id,
        urlencoding_encode(redirect_uri),
        state,
        code_challenge,
    )
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_pair_verifier_has_expected_length() {
        let (verifier, challenge) = pkce_pair();
        // 32 bytes → base64url-no-pad → 43 chars
        assert_eq!(verifier.len(), 43);
        assert_eq!(challenge.len(), 43);
    }

    #[test]
    fn pkce_pair_uses_b64url_alphabet() {
        let (verifier, challenge) = pkce_pair();
        let allowed = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
        assert!(verifier.chars().all(allowed));
        assert!(challenge.chars().all(allowed));
    }

    #[test]
    fn pkce_challenge_is_sha256_of_verifier() {
        let (verifier, challenge) = pkce_pair();
        let expected = Base64UrlUnpadded::encode_string(&Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, expected);
    }

    #[test]
    fn gen_state_produces_unique_values() {
        assert_ne!(gen_state(), gen_state());
    }

    #[test]
    fn authorize_url_contains_required_params() {
        let url = authorize_url("Iv1.abc", "http://127.0.0.1:1234/cb", "ST", "CC");
        assert!(url.starts_with("https://github.com/login/oauth/authorize?"));
        assert!(url.contains("client_id=Iv1.abc"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Fcb"));
        assert!(url.contains("state=ST"));
        assert!(url.contains("code_challenge=CC"));
        assert!(url.contains("code_challenge_method=S256"));
    }
}
```

- [ ] **Step 2: Register module**

In `client/src-tauri/src/lib.rs`, add near the top with the other `mod` declarations:

```rust
mod oauth;
```

- [ ] **Step 3: Run tests**

```bash
cd client/src-tauri && cargo test oauth::tests --lib
```

Expected: 5 passed.

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/oauth.rs client/src-tauri/src/lib.rs
git commit -m "feat(client/oauth): add PKCE pair + state + authorize URL helpers"
```

---

## Task 13: `oauth.rs` — `LoopbackListener`

**Files:**
- Modify: `client/src-tauri/src/oauth.rs`

- [ ] **Step 1: Add `LoopbackListener` + `recv` + tests**

Append to `client/src-tauri/src/oauth.rs` (above the `#[cfg(test)] mod tests` block):

```rust
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::time::timeout;

pub struct CallbackParams {
    pub code: String,
    pub state: String,
}

pub struct LoopbackListener {
    listener: TcpListener,
    redirect_uri: String,
}

impl LoopbackListener {
    pub async fn bind() -> Result<Self, OauthError> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(OauthError::BindFailed)?;
        let port = listener.local_addr().map_err(OauthError::BindFailed)?.port();
        let redirect_uri = format!("http://127.0.0.1:{}/cb", port);
        Ok(Self { listener, redirect_uri })
    }

    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    pub async fn recv(self, deadline: Duration, expected_state: &str) -> Result<CallbackParams, OauthError> {
        let (mut socket, _peer) = timeout(deadline, self.listener.accept())
            .await
            .map_err(|_| OauthError::Timeout)?
            .map_err(|e| OauthError::BindFailed(e))?;

        // Read the request line (e.g., "GET /cb?code=...&state=... HTTP/1.1").
        let mut reader = BufReader::new(&mut socket);
        let mut request_line = String::new();
        reader
            .read_line(&mut request_line)
            .await
            .map_err(OauthError::Io)?;

        // Drain remaining headers (best-effort; we don't care about them).
        let mut sink = Vec::new();
        let _ = reader.read_to_end(&mut sink).await; // returns when peer closes

        // Parse the path + query: "GET /cb?... HTTP/1.1".
        let path = request_line
            .split_whitespace()
            .nth(1)
            .ok_or_else(|| OauthError::GithubError("malformed request line".into()))?;
        let query = path
            .split_once('?')
            .map(|(_, q)| q)
            .unwrap_or("");

        let mut code: Option<String> = None;
        let mut state: Option<String> = None;
        let mut err: Option<String> = None;
        for pair in query.split('&') {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let v_decoded = urldecode_safe(v);
            match k {
                "code" => code = Some(v_decoded),
                "state" => state = Some(v_decoded),
                "error" => err = Some(v_decoded),
                _ => {}
            }
        }

        // Always respond before returning, so the browser shows a friendly message.
        let body = "<!doctype html><html><body><p>You can close this tab.</p></body></html>";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;

        if let Some(e) = err {
            if e == "access_denied" {
                return Err(OauthError::UserDenied);
            }
            return Err(OauthError::GithubError(e));
        }
        let code = code.ok_or_else(|| OauthError::GithubError("missing code".into()))?;
        let state = state.ok_or_else(|| OauthError::GithubError("missing state".into()))?;
        if state != expected_state {
            return Err(OauthError::StateMismatch);
        }
        Ok(CallbackParams { code, state })
    }
}

fn urldecode_safe(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(b);
                i += 3;
                continue;
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}
```

- [ ] **Step 2: Add listener tests inside the existing `mod tests`**

Append inside the `#[cfg(test)] mod tests { ... }` block (alongside the PKCE tests):

```rust
    #[tokio::test]
    async fn listener_receives_callback_and_returns_parsed() {
        let listener = LoopbackListener::bind().await.expect("bind");
        let redirect = listener.redirect_uri().to_string();

        // Spawn the listener task.
        let recv_handle = tokio::spawn(async move {
            listener
                .recv(Duration::from_secs(5), "STATE_OK")
                .await
        });

        // Simulate the browser callback.
        let url = format!("{}?code=ABC&state=STATE_OK&installation_id=42", redirect);
        let _ = reqwest::get(&url).await;

        let result = recv_handle.await.expect("join");
        let params = result.expect("ok");
        assert_eq!(params.code, "ABC");
        assert_eq!(params.state, "STATE_OK");
    }

    #[tokio::test]
    async fn listener_returns_state_mismatch_when_state_differs() {
        let listener = LoopbackListener::bind().await.expect("bind");
        let redirect = listener.redirect_uri().to_string();
        let recv_handle = tokio::spawn(async move {
            listener
                .recv(Duration::from_secs(5), "EXPECTED")
                .await
        });
        let url = format!("{}?code=ABC&state=DIFFERENT", redirect);
        let _ = reqwest::get(&url).await;
        let result = recv_handle.await.expect("join");
        assert!(matches!(result, Err(OauthError::StateMismatch)));
    }

    #[tokio::test]
    async fn listener_returns_user_denied_on_access_denied_error() {
        let listener = LoopbackListener::bind().await.expect("bind");
        let redirect = listener.redirect_uri().to_string();
        let recv_handle = tokio::spawn(async move {
            listener
                .recv(Duration::from_secs(5), "STATE")
                .await
        });
        let url = format!("{}?error=access_denied", redirect);
        let _ = reqwest::get(&url).await;
        let result = recv_handle.await.expect("join");
        assert!(matches!(result, Err(OauthError::UserDenied)));
    }

    #[tokio::test]
    async fn listener_times_out_when_no_callback() {
        let listener = LoopbackListener::bind().await.expect("bind");
        let result = listener
            .recv(Duration::from_millis(100), "STATE")
            .await;
        assert!(matches!(result, Err(OauthError::Timeout)));
    }
```

- [ ] **Step 3: Run tests**

```bash
cd client/src-tauri && cargo test oauth::tests --lib
```

Expected: 9 passed (5 from Task 12 + 4 new listener tests).

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/oauth.rs
git commit -m "feat(client/oauth): add LoopbackListener with state + user-denied + timeout handling"
```

---

## Task 14: SDK — `api::Client::web_exchange` (+ drop device methods, trim types)

**Files:**
- Modify: `client/src-tauri/src/api/auth.rs`
- Modify: `client/src-tauri/src/api/types.rs`
- Modify: `client/src-tauri/src/api/mod.rs` (if it re-exports types — check)

- [ ] **Step 1: Replace `auth.rs` with web-exchange version**

Replace the contents of `client/src-tauri/src/api/auth.rs` with:

```rust
// client/src-tauri/src/api/auth.rs
use serde::Deserialize;

use crate::api::types::{SessionData, User};
use crate::api::{Client, Error};

impl Client {
    pub async fn web_exchange(
        &self,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
    ) -> Result<SessionData, Error> {
        let url = self.base_url.join("api/v1/auth/web/exchange/").unwrap();
        let resp = self
            .http
            .post(url)
            .json(&serde_json::json!({
                "code": code,
                "code_verifier": code_verifier,
                "redirect_uri": redirect_uri,
            }))
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json::<SessionData>()
            .await
            .map_err(|e| Self::json_err(status, e))
    }

    pub async fn auth_me(&self, token: &str) -> Result<User, Error> {
        let url = self.base_url.join("api/v1/auth/me/").unwrap();
        let resp = self.http.get(url).bearer_auth(token).send().await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json::<User>().await.map_err(|e| Self::json_err(status, e))
    }

    pub async fn logout(&self, token: &str) -> Result<(), Error> {
        let url = self.base_url.join("api/v1/auth/logout/").unwrap();
        let resp = self.http.post(url).bearer_auth(token).send().await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::api::Client;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn web_exchange_returns_session_data_on_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/web/exchange/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "ok",
                "session_token": "stg_AAAA",
                "user": {
                    "id": 7,
                    "github_login": "alice",
                    "display_name": "Alice",
                    "avatar_url": "https://a.example/alice.png"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(&server.uri()).unwrap();
        let result = client
            .web_exchange("code_abc", &"v".repeat(43), "http://127.0.0.1:1234/cb")
            .await
            .expect("ok");
        assert_eq!(result.session_token, "stg_AAAA");
        assert_eq!(result.user.github_login, "alice");
    }

    #[tokio::test]
    async fn web_exchange_maps_400_github_code_invalid_to_domain_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/web/exchange/"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "message": "github_code_invalid",
                "extra": {"error": "bad_verification_code"}
            })))
            .mount(&server)
            .await;
        let client = Client::new(&server.uri()).unwrap();
        let result = client
            .web_exchange("bad", &"v".repeat(43), "http://127.0.0.1:1234/cb")
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn web_exchange_maps_502_to_backend_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/web/exchange/"))
            .respond_with(ResponseTemplate::new(502))
            .mount(&server)
            .await;
        let client = Client::new(&server.uri()).unwrap();
        let result = client
            .web_exchange("c", &"v".repeat(43), "http://127.0.0.1:1234/cb")
            .await;
        assert!(result.is_err());
    }
}
```

- [ ] **Step 2: Trim `types.rs`**

In `client/src-tauri/src/api/types.rs`, remove `DeviceCode` and any device-flow types. Keep `SessionData`, `User`, `GithubPrSearchItem`, `GithubUserRef`, `ErrorBody`.

The final shape:

```rust
// client/src-tauri/src/api/types.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub github_login: String,
    pub display_name: String,
    pub avatar_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionData {
    pub session_token: String,
    pub user: User,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GithubUserRef {
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GithubPrSearchItem {
    pub number: i64,
    pub title: String,
    pub html_url: String,
    pub repository_url: String,
    pub updated_at: String,
    pub user: GithubUserRef,
}

#[derive(Debug, Deserialize)]
pub struct ErrorBody {
    pub message: String,
    #[serde(default)]
    pub extra: serde_json::Value,
}
```

- [ ] **Step 3: Update `api/mod.rs` re-exports if needed**

Check `client/src-tauri/src/api/mod.rs` — if it has `pub use types::{..., DeviceCode, ...}`, drop `DeviceCode`. Keep `SessionData`, `User`, `GithubPrSearchItem`, `GithubUserRef`.

- [ ] **Step 4: Run tests + clippy**

```bash
cd client/src-tauri && cargo test --lib && cargo clippy --all-targets
```

Expected: PASS. Any reference to deleted `device_start` / `device_poll` / `DeviceCode` in commands.rs or examples will fail compilation — those are fixed in Tasks 16 / 18.

If the build breaks at this stage on `commands.rs` references, that's expected; proceed to Task 15-16 to fix.

- [ ] **Step 5: Commit (with broken-build acknowledgement in body)**

Note: this commit intentionally leaves the build broken because `commands.rs` still calls `device_start` / `device_poll`. Fixed in Task 16.

```bash
git add client/src-tauri/src/api/auth.rs client/src-tauri/src/api/types.rs client/src-tauri/src/api/mod.rs
git commit -m "feat(client/api): replace device_start/poll with web_exchange (build red until Task 16)"
```

Alternative if you want every commit green: stage Tasks 14, 15, 16 as a single commit, but the writing-plans guidance favours small, focused commits.

---

## Task 15: `errors.rs` + `state.rs` — new variants and abort handle

**Files:**
- Modify: `client/src-tauri/src/errors.rs`
- Modify: `client/src-tauri/src/state.rs`

- [ ] **Step 1: Add `AuthDenied` + `Cancelled` to `AppError`**

In `client/src-tauri/src/errors.rs`, add to the `AppError` enum:

```rust
#[error("user denied authorization")]
AuthDenied,
#[error("sign-in cancelled")]
Cancelled,
```

Add the `From<oauth::OauthError>` impl below the existing `From` impls:

```rust
// client/src-tauri/src/errors.rs (additional impl)
use crate::oauth::OauthError;

impl From<OauthError> for AppError {
    fn from(err: OauthError) -> Self {
        match err {
            OauthError::UserDenied => AppError::AuthDenied,
            OauthError::Cancelled => AppError::Cancelled,
            OauthError::StateMismatch => AppError::Backend("oauth_state_mismatch".into()),
            OauthError::Timeout => AppError::Backend("oauth_timeout".into()),
            OauthError::BindFailed(e) => AppError::Backend(format!("oauth_bind_failed: {e}")),
            OauthError::GithubError(s) => AppError::Backend(format!("oauth_github_error: {s}")),
            OauthError::Io(e) => AppError::Backend(format!("oauth_io_error: {e}")),
        }
    }
}
```

- [ ] **Step 2: Add `auth_in_flight` to `AppState`**

In `client/src-tauri/src/state.rs`, add the field:

```rust
use parking_lot::Mutex;
use std::sync::Arc;
use tokio::task::AbortHandle;

use crate::api;
use crate::errors::AppError;
use crate::recents::RecentsStore;

pub struct ActiveRepo { /* unchanged */ }
pub struct AuthSession {
    pub token: String,
    pub user: api::User,
}

pub struct AppState {
    pub active: Mutex<Option<ActiveRepo>>,
    pub recents: Arc<RecentsStore>,
    pub api: api::Client,
    pub auth: Mutex<Option<AuthSession>>,
    pub auth_in_flight: Mutex<Option<AbortHandle>>,
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

(Keep `ActiveRepo` definition unchanged — only the `AppState` struct gains the new field.)

- [ ] **Step 3: Initialize `auth_in_flight` in `lib.rs`**

Where `AppState` is constructed in `client/src-tauri/src/lib.rs`, add `auth_in_flight: Mutex::new(None)` to the literal.

- [ ] **Step 4: Build (will still be red from Task 14)**

```bash
cd client/src-tauri && cargo build
```

Errors should now only be about `commands.rs` calling removed device methods. That's fixed in Task 16.

- [ ] **Step 5: Commit**

```bash
git add client/src-tauri/src/errors.rs client/src-tauri/src/state.rs client/src-tauri/src/lib.rs
git commit -m "feat(client): add AuthDenied/Cancelled variants + AppState.auth_in_flight"
```

---

## Task 16: `commands.rs` — `auth_sign_in` + `auth_sign_in_cancel`, drop device commands

**Files:**
- Modify: `client/src-tauri/src/commands.rs`
- Modify: `client/src-tauri/src/lib.rs` (update `invoke_handler!`)

- [ ] **Step 1: Replace auth commands in `commands.rs`**

Remove `auth_device_start` and `auth_device_poll`, and the `AuthPollResult` enum. Add:

```rust
// client/src-tauri/src/commands.rs
use std::time::Duration;

use crate::api;
use crate::errors::AppError;
use crate::oauth::{authorize_url, gen_state, pkce_pair, LoopbackListener};
use crate::state::{AppState, AuthSession};

#[tauri::command]
pub async fn auth_sign_in(state: tauri::State<'_, AppState>) -> Result<api::User, AppError> {
    // Reject a second concurrent sign-in.
    {
        let in_flight = state.auth_in_flight.lock();
        if in_flight.is_some() {
            return Err(AppError::Backend("oauth_in_flight".into()));
        }
    }

    let (verifier, challenge) = pkce_pair();
    let state_param = gen_state();
    let listener = LoopbackListener::bind().await?;
    let redirect_uri = listener.redirect_uri().to_string();

    let client_id = state.github_app_client_id.clone();
    let url = authorize_url(&client_id, &redirect_uri, &state_param, &challenge);
    tauri_plugin_opener::open_url(&url, None::<String>)
        .map_err(|e| AppError::Backend(format!("oauth_browser_open_failed: {e}")))?;

    // Run the listener inside an abortable task so cancel works.
    let recv_future = listener.recv(Duration::from_secs(300), &state_param);
    let handle = tokio::spawn(async move { recv_future.await });
    {
        *state.auth_in_flight.lock() = Some(handle.abort_handle());
    }

    let recv_result = handle.await;
    {
        *state.auth_in_flight.lock() = None;
    }

    let params = match recv_result {
        Ok(inner) => inner?, // OauthError → AppError via From
        Err(join_err) if join_err.is_cancelled() => return Err(AppError::Cancelled),
        Err(other) => return Err(AppError::Backend(format!("oauth_join_error: {other}"))),
    };

    let session = state
        .api
        .web_exchange(&params.code, &verifier, &redirect_uri)
        .await?;

    let user = session.user.clone();
    *state.auth.lock() = Some(AuthSession {
        token: session.session_token,
        user: user.clone(),
    });
    Ok(user)
}

#[tauri::command]
pub async fn auth_sign_in_cancel(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    if let Some(handle) = state.auth_in_flight.lock().take() {
        handle.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn auth_me(state: tauri::State<'_, AppState>) -> Result<api::User, AppError> {
    let token = state.require_token()?;
    let user = state.api.auth_me(&token).await?;
    Ok(user)
}

#[tauri::command]
pub async fn auth_logout(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let token = state.require_token()?;
    let result = state.api.logout(&token).await;
    *state.auth.lock() = None;
    result.map_err(Into::into)
}

#[tauri::command]
pub async fn github_prs(
    state: tauri::State<'_, AppState>,
    role: String,
) -> Result<Vec<api::GithubPrSearchItem>, AppError> {
    let token = state.require_token()?;
    let items = state.api.github_prs(&token, &role).await?;
    Ok(items)
}
```

Note: this references `state.github_app_client_id` — added in Step 2.

- [ ] **Step 2: Plumb `github_app_client_id` through `AppState` + `lib.rs`**

In `client/src-tauri/src/state.rs`, add a field on `AppState`:

```rust
pub github_app_client_id: String,
```

In `client/src-tauri/src/lib.rs`, where `AppState` is constructed, read the value from the Tauri config (alongside the existing `backendUrl` read) and pass it in:

```rust
let github_app_client_id = app
    .config()
    .plugins
    .0
    .get("stage")
    .and_then(|v| v.get("githubAppClientId"))
    .and_then(|v| v.as_str())
    .ok_or_else(|| std::io::Error::other("plugins.stage.githubAppClientId not set"))?
    .to_string();
```

Then in the `AppState { ... }` literal, add `github_app_client_id`.

- [ ] **Step 3: Update `invoke_handler!`**

In `client/src-tauri/src/lib.rs`, change the invoke_handler list — remove `auth_device_start`, `auth_device_poll`; add `auth_sign_in`, `auth_sign_in_cancel`:

```rust
.invoke_handler(tauri::generate_handler![
    // ... existing non-auth commands (open_repository, list_recents, etc.) unchanged ...
    auth_sign_in,
    auth_sign_in_cancel,
    auth_me,
    auth_logout,
    github_prs,
])
```

- [ ] **Step 4: Build + tests**

```bash
cd client/src-tauri && cargo build && cargo test --lib
```

Expected: PASS. Build is green for the first time since Task 14.

- [ ] **Step 5: Lint**

```bash
cd client/src-tauri && cargo clippy --all-targets
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src-tauri/src/commands.rs client/src-tauri/src/state.rs client/src-tauri/src/lib.rs
git commit -m "feat(client/cmds): replace device commands with auth_sign_in + auth_sign_in_cancel"
```

---

## Task 17: `examples/auth_smoke.rs` rewrite

**Files:**
- Modify: `client/src-tauri/examples/auth_smoke.rs`

- [ ] **Step 1: Replace example with a web-flow smoke binary**

The smoke binary won't open a real browser; it prints the authorize URL for the developer to paste into a browser manually, then waits for the callback to land on a printed loopback URL.

```rust
// client/src-tauri/examples/auth_smoke.rs
use std::time::Duration;

use stage_lib::api;
use stage_lib::oauth::{authorize_url, gen_state, pkce_pair, LoopbackListener};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let backend_url = std::env::var("STAGE_BACKEND_URL").unwrap_or_else(|_| "http://localhost:8000".into());
    let client_id = std::env::var("STAGE_GITHUB_APP_CLIENT_ID")
        .expect("set STAGE_GITHUB_APP_CLIENT_ID to the dev GitHub App's Client ID");

    let api_client = api::Client::new(&backend_url)?;
    let (verifier, challenge) = pkce_pair();
    let state = gen_state();
    let listener = LoopbackListener::bind().await?;
    let redirect = listener.redirect_uri().to_string();
    let url = authorize_url(&client_id, &redirect, &state, &challenge);

    println!("Open this URL in your browser to authorize:\n  {}\n", url);
    println!("Waiting for callback on {} …", redirect);

    let params = listener.recv(Duration::from_secs(300), &state).await?;
    println!("Received code = {} …", &params.code[..8]);

    let session = api_client.web_exchange(&params.code, &verifier, &redirect).await?;
    println!("Signed in as @{} (session token: {}…)",
        session.user.github_login,
        &session.session_token[..12],
    );
    Ok(())
}
```

(`stage_lib` is the crate name — check `Cargo.toml`'s `[package] name`; substitute the actual crate name if it differs.)

- [ ] **Step 2: Build the example**

```bash
cd client/src-tauri && cargo build --example auth_smoke
```

Expected: PASS.

- [ ] **Step 3 (optional, requires real dev App + browser): Run the smoke**

```bash
cd client/src-tauri && STAGE_GITHUB_APP_CLIENT_ID="Iv1.<your-dev-client-id>" cargo run --example auth_smoke
```

Open the URL it prints, approve, observe the binary print the signed-in `@login`.

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/examples/auth_smoke.rs
git commit -m "test(client/examples): rewrite auth_smoke for web-flow"
```

---

## Task 18: PR 2 wrap — full test pass + open PR

- [ ] **Step 1: Full client Rust verify**

```bash
cd client/src-tauri && cargo build && cargo test --lib && cargo clippy --all-targets
```

Expected: PASS.

- [ ] **Step 2: Residual-reference check**

```bash
grep -rn "device_start\|device_poll\|DevicePoll\|DeviceCode\|AuthPollResult" client/src-tauri/src client/src-tauri/examples
```

Expected: 0 hits.

- [ ] **Step 3: Open PR 2**

```bash
git push  # branch already tracks origin
gh pr create --title "feat(client): GitHub App user-to-server auth, Rust seam (PR 2/3)" --body "$(cat <<'EOF'
## Summary

- Replace device-flow SDK methods + Tauri commands with web-flow:
  - \`oauth.rs\`: PKCE pair, state, authorize URL, \`LoopbackListener\` (127.0.0.1 ephemeral port).
  - \`api::Client::web_exchange\` → backend's new \`/auth/web/exchange/\`.
  - \`auth_sign_in\` + \`auth_sign_in_cancel\` Tauri commands.
- AppState gains \`auth_in_flight\` (abort handle) + \`github_app_client_id\` (from \`tauri.conf.json\`).
- AppError gains \`AuthDenied\` + \`Cancelled\` variants; \`From<oauth::OauthError>\` impl.
- \`examples/auth_smoke.rs\` rewritten for manual web-flow validation.

## Test plan
- [ ] \`cd client/src-tauri && cargo test --lib\` → all green (oauth + api/auth + api/github)
- [ ] \`cargo clippy --all-targets\` → clean
- [ ] Manual smoke: \`STAGE_GITHUB_APP_CLIENT_ID=... cargo run --example auth_smoke\`
- [ ] Depends on PR 1 being merged or stacked.

PR 3 (React UI) follows.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR 3 — React UI

## Task 19: `tauri.ts` + `lib/auth.ts`

**Files:**
- Modify: `client/src/tauri.ts`
- Modify: `client/src/lib/auth.ts`

- [ ] **Step 1: Update typed wrappers**

In `client/src/tauri.ts`, remove `AuthPollResult`, `DeviceCode`, `authDeviceStart`, `authDevicePoll`. Add:

```typescript
// client/src/tauri.ts
import { invoke } from '@tauri-apps/api/core';

export type User = {
  id: number;
  github_login: string;
  display_name: string;
  avatar_url: string;
};

export type GithubUserRef = {
  login: string;
  avatar_url: string | null;
};

export type GithubPrSearchItem = {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  updated_at: string;
  user: GithubUserRef;
};

// Auth
export const authSignIn = () => invoke<User>('auth_sign_in');
export const authSignInCancel = () => invoke<void>('auth_sign_in_cancel');
export const authMe = () => invoke<User>('auth_me');
export const authLogout = () => invoke<void>('auth_logout');

// GitHub
export const githubPrs = (role: 'author' | 'reviewer') =>
  invoke<GithubPrSearchItem[]>('github_prs', { role });

// ... keep any other existing wrappers (open_repository, list_recents, etc.) unchanged ...
```

- [ ] **Step 2: Replace `lib/auth.ts`**

```typescript
// client/src/lib/auth.ts
import { authSignIn, authSignInCancel, type User } from '../tauri';

export type AuthEvent =
  | { kind: 'started' }
  | { kind: 'authenticated'; user: User }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

export async function runWebFlow(
  onEvent: (event: AuthEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    onEvent({ kind: 'cancelled' });
    return;
  }

  const onAbort = () => {
    authSignInCancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort);

  onEvent({ kind: 'started' });
  try {
    const user = await authSignIn();
    onEvent({ kind: 'authenticated', user });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('cancelled')) {
      onEvent({ kind: 'cancelled' });
    } else {
      onEvent({ kind: 'error', message });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
```

- [ ] **Step 3: Typecheck**

```bash
cd client && nvm use && npm run typecheck
```

Expected: PASS (assuming biome + tsc).

- [ ] **Step 4: Commit**

```bash
git add client/src/tauri.ts client/src/lib/auth.ts
git commit -m "feat(client/ui): replace device-flow auth lib with runWebFlow"
```

---

## Task 20: `SignIn.tsx` simplification

**Files:**
- Modify: `client/src/screens/onboarding/SignIn.tsx`

- [ ] **Step 1: Rewrite SignIn screen**

Replace the entire file with:

```tsx
// client/src/screens/onboarding/SignIn.tsx
import { useEffect, useRef, useState } from 'react';

import { type AuthEvent, runWebFlow } from '../../lib/auth';
import { type User } from '../../tauri';

type SignInState =
  | { kind: 'idle' }
  | { kind: 'signing-in' }
  | { kind: 'error'; message: string };

type Props = {
  onAuthenticated: (user: User) => void;
};

export function SignIn({ onAuthenticated }: Props) {
  const [state, setState] = useState<SignInState>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const startSignIn = () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ kind: 'signing-in' });

    runWebFlow((event: AuthEvent) => {
      switch (event.kind) {
        case 'started':
          break;
        case 'authenticated':
          setState({ kind: 'idle' });
          onAuthenticated(event.user);
          break;
        case 'cancelled':
          setState({ kind: 'idle' });
          break;
        case 'error':
          setState({ kind: 'error', message: event.message });
          break;
      }
    }, controller.signal).catch(() => {
      // runWebFlow already routes errors through onEvent
    });
  };

  const cancelSignIn = () => {
    abortRef.current?.abort();
    setState({ kind: 'idle' });
  };

  return (
    <div className="signin-screen">
      <h1>Sign in to Stage</h1>
      {state.kind === 'idle' && (
        <button type="button" onClick={startSignIn}>
          Sign in with GitHub
        </button>
      )}
      {state.kind === 'signing-in' && (
        <div>
          <p>Continue in your browser to finish signing in…</p>
          <button type="button" onClick={cancelSignIn}>
            Cancel
          </button>
        </div>
      )}
      {state.kind === 'error' && (
        <div>
          <p>Sign-in failed: {state.message}</p>
          <button type="button" onClick={startSignIn}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
```

(Keep using whatever CSS class names are already established. Strip any subcomponents — `IdleCard`, `StatusCard`, `AwaitingCard` — that were specific to the device flow.)

- [ ] **Step 2: Run lint + typecheck**

```bash
cd client && npm run lint && npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/screens/onboarding/SignIn.tsx
git commit -m "feat(client/ui): simplify SignIn to idle/signing-in/error states"
```

---

## Task 21: Manual e2e verification (surface to user)

**This task is manual; surface to the user when reached.**

Validate that the new auth shape achieves parity with the previous slice's known-good e2e.

- [ ] **Step 1: Pre-flight checks**
  - GitHub App "Stage Dev" created (see Pre-flight P1–P3).
  - `backend/.env` has all 4 `GITHUB_APP_*` vars.
  - `client/src-tauri/tauri.conf.json` has `plugins.stage.githubAppClientId` set.

- [ ] **Step 2: Start backend**

```bash
cd backend && just dev
```

Expected: backend on `http://localhost:8000`. Log "starting development server".

- [ ] **Step 3: Start client**

```bash
cd client && nvm use && cargo tauri dev
```

Expected: client window opens to SignIn screen.

- [ ] **Step 4: Sign-in ceremony**
  - Click **Sign in with GitHub**.
  - Browser opens to `https://github.com/login/oauth/authorize?...`.
  - Click **Authorize** (and install on a test repo if first time).
  - Browser shows "You can close this tab".
  - Client transitions to WorkspaceScaffold with your `@github_login` in header.

- [ ] **Step 5: PR list**
  - WorkspaceScaffold lists 1+ open PRs you authored on a Stage-installed repo.
  - Click a PR row → opens the PR URL in the system browser.

- [ ] **Step 6: Refresh test**

```sql
-- run via psql or your favourite DB tool
UPDATE identity_githubidentity
SET access_token_expires_at = NOW() - INTERVAL '1 minute'
WHERE user_id = (SELECT id FROM users_user WHERE github_login = '<your-login>');
```

Reload the PR list in Stage. Backend log should show `github_refresh_ok` followed by the search call. List loads.

- [ ] **Step 7: Reauth test**

```sql
UPDATE identity_githubidentity
SET access_token_expires_at = NOW() - INTERVAL '1 minute',
    refresh_token_expires_at = NOW() - INTERVAL '1 minute'
WHERE user_id = (SELECT id FROM users_user WHERE github_login = '<your-login>');
```

Reload PR list. Backend returns 401 `github_reauth_required`. Client routes back to SignIn. `GitHubIdentity` row deleted.

- [ ] **Step 8: Logout**
  - Click **Logout** in WorkspaceScaffold.
  - Returns to SignIn.
  - Click **Sign in with GitHub** again — should bypass the `/authorize` prompt (grant cached) and go straight to WorkspaceScaffold.

- [ ] **Step 9: Cancel test**
  - Click **Sign in with GitHub**.
  - Before approving in browser, click **Cancel** in the client.
  - Client returns to idle (no error toast).
  - Backend logs no `code_exchange_*` events.

- [ ] **Step 10: Record results**

Update the spec's "Status" header from "proposed" to "accepted" and append a Verification section similar to the previous slice's commit `27bd466`. Commit:

```bash
git add docs/superpowers/specs/2026-05-26-github-app-auth-redesign-design.md
git commit -m "docs(spec): record e2e verification PASS for github-app loopback auth"
```

- [ ] **Step 11: Open PR 3**

```bash
git push
gh pr create --title "feat(client/ui): GitHub App user-to-server auth, React UI (PR 3/3)" --body "$(cat <<'EOF'
## Summary

- Replace device-flow SignIn screen with the loopback web-flow:
  - \`runWebFlow\` orchestrator (AbortSignal-aware).
  - 3-state SignIn (idle / signing-in / error).
- Drop \`AuthPollResult\`, \`DeviceCode\` from typed wrappers.

## Test plan
- [ ] \`cd client && npm run lint && npm run typecheck\` → clean
- [ ] Full e2e per the manual checklist in this PR description.
- [ ] Depends on PR 1 + PR 2 being merged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Closing the loop

Once PR 3 merges and the e2e tests pass on `main`, decide the fate of the unmerged `feat/tauri-auth-and-github-prs` branch (close or merge-as-historical-step). That decision is intentionally deferred — it doesn't block this slice.
