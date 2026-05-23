# Local-Review Backend v1 Implementation Plan (v3, boilerplate-aligned)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Django REST backend per:

- **Spec v3:** [`docs/superpowers/specs/2026-05-23-local-review-backend-design-v3.md`](../specs/2026-05-23-local-review-backend-design-v3.md)
- **Contract (canonical):** [`docs/data-model.md`](../../data-model.md) + [`docs/api.md`](../../api.md)
- **Decisions log:** `docs/decisions/2026-05-23-foundational-decisions.md` (D1–D32)
- **Boilerplate baseline:** `backend/CONTEXT.md`, `backend/CLAUDE.md`, `backend/docs/adr/0001-architecture-and-styleguide-baseline.md`

**Starting point:** The `backend/` directory already contains a runnable Django 5.2 + DRF + structlog + Postgres scaffold (forked from `brunovollmer/Django-Starter`). It ships an `apps/items/` reference impl that we delete on fork, and a HackSoft-style services/selectors/apis split that all new code must follow.

**Architecture (post-implementation):**
- `apps.core` (boilerplate) — `BaseModel`, `ApplicationError`, exception handler, `/health/`
- `apps.users` (boilerplate, **extended**) — `User(AbstractUser)` + github fields
- `apps.admin` (boilerplate) — Unfold registrations
- `apps.identity` (**new**) — `Session`, github device-flow, Bearer auth, auth endpoints
- `apps.workspaces` (**new**) — `Workspace`, `Storyline`, `StorylineFile`, `IntroComment`, workspace-anchored endpoints, open-pr orchestration
- `apps.github_proxy` (**new**) — `GithubGateway`, PR-anchored endpoints, github search

**Tech Stack:** Python 3.13 (uv), Django 5.2, DRF 3.15+, structlog, drf-spectacular, factory-boy, pytest + pytest-django + respx, PyGithub + httpx, Postgres.

**Conventions (enforced):**
- Writes in `services.py`, reads in `selectors.py`. Both kw-only typed.
- One `APIView` per HTTP operation in `apis.py`, named `<Entity><Action>Api`.
- Domain errors via `ApplicationError(message, extra={}, status=N)` — the boilerplate handler renders `{"message": ..., "extra": ...}`.
- Models inherit `apps.core.models.BaseModel`. Exception: `users.User` extends `AbstractUser`.
- Tests in `tests/<app>/test_*.py` (mirror app tree).
- Factories in `apps/<app>/factories.py`.
- Logging via `structlog.get_logger(__name__)` with event names + kwargs (no f-strings).
- After every task: `uv run pre-commit run --all-files && just typecheck && just test` must pass.

---

## Phase boundaries

| Phase | Tasks | Working outcome |
|---|---|---|
| 0 · Boilerplate housekeeping | T1–T2 | Items removed, deps + env extended, Stage docs cross-linked |
| 1 · Identity + device-flow auth | T3–T8 | Users extended, Session model, Bearer auth, login + `/me` + logout |
| 2 · GithubGateway core | T9 | PR fetch + file list + error hierarchy |
| 3 · Workspace CRUD | T10–T12 | Create / list / lookup / get / patch + empty storyline seed |
| 4 · Storyline | T13–T16 | Create / read w/ stale flags / write w/ etag / single-file read |
| 5 · IntroComments | T17–T18 | Threaded post / edit / soft-delete / resolve, depth-1 invariant |
| 6 · GithubGateway writes | T19 | Comment / review / PR-state methods |
| 7 · Open-PR + Reopen-PR | T20 | Atomic orchestration; `pr_number` set; warnings array |
| 8 · PR-anchored read proxy | T21 | `/api/v1/repos/.../pulls/{n}/*` GETs |
| 9 · PR-anchored write proxy | T22 | comment / review write-through + PR actions |
| 10 · Github search | T23 | `/api/v1/github/prs?role=` |
| 11 · Polish | T24 | Smoke test + tag |

End of each phase = green `just verify` + working binary. Stop at any phase boundary if needed.

---

## Phase 0 · Boilerplate housekeeping

### Task 1: Delete reference app, add Stage deps, extend env schema

**Files:**
- Delete: `backend/apps/items/`, `backend/tests/items/`, `backend/TODO.md`
- Modify: `backend/pyproject.toml`, `backend/config/settings/env_schemas.py`, `backend/config/urls.py`, `backend/.env.example`

- [ ] **Step 1:** Remove reference app (boilerplate explicitly marks it as deletable on fork).

```bash
rm -rf backend/apps/items backend/tests/items
```

- [ ] **Step 2:** In `backend/config/urls.py`, drop the `items/` include.

Open `backend/config/urls.py` and delete the line:

```python
    path("items/", include("apps.items.urls")),
```

- [ ] **Step 3:** In `backend/config/settings/base.py`, drop `apps.items.apps.ItemsConfig` from `INSTALLED_APPS`.

- [ ] **Step 4:** Delete `backend/TODO.md` (predates v3 docs).

```bash
rm backend/TODO.md
```

- [ ] **Step 5:** Add Stage dependencies to `backend/pyproject.toml`:

```bash
cd backend
uv add "PyGithub>=2.5" "httpx>=0.28"
uv add --dev "respx>=0.22"
```

- [ ] **Step 6:** Extend `backend/config/settings/env_schemas.py`:

```python
from pydantic_settings import BaseSettings, SettingsConfigDict


class Env(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    DJANGO_SECRET_KEY: str = "dev-insecure-change-me"
    DJANGO_DEBUG: bool = True
    DJANGO_ALLOWED_HOSTS: list[str] = ["*"]

    POSTGRES_DB: str = "stage"
    POSTGRES_USER: str = "stage"
    POSTGRES_PASSWORD: str = "stage"
    POSTGRES_HOST: str = "localhost"
    POSTGRES_PORT: int = 5432

    GITHUB_ADMIN_PAT: str = "ghp_REPLACE_ME"
    GITHUB_OAUTH_CLIENT_ID: str = "Iv1.REPLACE_ME"
    GITHUB_OAUTH_CLIENT_SECRET: str = "REPLACE_ME"
    GITHUB_API_BASE: str = "https://api.github.com"
    SESSION_TOKEN_TTL_DAYS: int = 30


env = Env()
```

- [ ] **Step 7:** Append to `backend/.env.example`:

```
GITHUB_ADMIN_PAT=ghp_REPLACE_ME
GITHUB_OAUTH_CLIENT_ID=Iv1.REPLACE_ME
GITHUB_OAUTH_CLIENT_SECRET=REPLACE_ME
```

- [ ] **Step 8:** Verify the project still boots and existing tests still pass.

```bash
cd backend && just verify
```

Expected: green (items tests are gone; no test references them).

- [ ] **Step 9:** Commit.

```bash
git add backend/
git commit -m "chore(backend): remove items reference app, add Stage deps + env vars"
```

---

### Task 2: Scaffold three new apps (identity, workspaces, github_proxy)

**Files:**
- Create: `backend/apps/{identity,workspaces,github_proxy}/{__init__.py,apps.py,urls.py,services.py,selectors.py,apis.py,factories.py}`
- Create: `backend/apps/{identity,workspaces,github_proxy}/serializers/__init__.py`
- Create: `backend/tests/{identity,workspaces,github_proxy}/__init__.py`
- Modify: `backend/config/settings/base.py`, `backend/config/urls.py`

- [ ] **Step 1:** Use `manage.py startapp` for each new app (gives correct migrations folder + apps.py shape):

```bash
cd backend
mkdir -p apps/identity apps/workspaces apps/github_proxy
uv run python manage.py startapp identity apps/identity
uv run python manage.py startapp workspaces apps/workspaces
uv run python manage.py startapp github_proxy apps/github_proxy
```

- [ ] **Step 2:** Fix each `apps/<name>/apps.py` (`startapp` writes the wrong `name`):

```python
# apps/identity/apps.py
from django.apps import AppConfig


class IdentityConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.identity"
```

Repeat for `workspaces` (`WorkspacesConfig`) and `github_proxy` (`GithubProxyConfig`).

- [ ] **Step 3:** For each new app, delete `views.py`, `tests.py`, and `admin.py` (we follow the boilerplate split: writes in `services.py`, reads in `selectors.py`, HTTP in `apis.py`; admin lives in `apps.admin`).

```bash
cd backend
rm apps/identity/{views.py,tests.py,admin.py}
rm apps/workspaces/{views.py,tests.py,admin.py}
rm apps/github_proxy/{views.py,tests.py,admin.py}
```

- [ ] **Step 4:** For each new app, create empty module files:

```bash
cd backend
for app in identity workspaces github_proxy; do
  touch apps/$app/{urls.py,services.py,selectors.py,apis.py,factories.py}
  mkdir -p apps/$app/serializers
  touch apps/$app/serializers/__init__.py
done
```

Each `apps/<app>/urls.py` starts as:

```python
from django.urls import path

app_name = "<app>"

urlpatterns: list = []
```

(Replace `<app>` with the literal app name.)

- [ ] **Step 5:** Create empty `tests/<app>/__init__.py` for each:

```bash
cd backend
mkdir -p tests/{identity,workspaces,github_proxy}
touch tests/identity/__init__.py tests/workspaces/__init__.py tests/github_proxy/__init__.py
```

- [ ] **Step 6:** Register apps in `backend/config/settings/base.py`. After `"apps.items.apps.ItemsConfig"` was removed in Task 1, append the three new apps:

```python
INSTALLED_APPS = [
    "unfold",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "drf_spectacular",
    "apps.core.apps.CoreConfig",
    "apps.users.apps.UsersConfig",
    "apps.admin.apps.CustomAdminConfig",
    "apps.identity.apps.IdentityConfig",
    "apps.workspaces.apps.WorkspacesConfig",
    "apps.github_proxy.apps.GithubProxyConfig",
]
```

- [ ] **Step 7:** Wire URL includes in `backend/config/urls.py`. The `api_v1_patterns` list becomes:

```python
api_v1_patterns = [
    path("schema/", SpectacularAPIView.as_view(), name="schema"),
    path("docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
    path("redoc/", SpectacularRedocView.as_view(url_name="schema"), name="redoc"),
    path("auth/", include("apps.identity.urls")),
    path("", include("apps.workspaces.urls")),
    path("", include("apps.github_proxy.urls")),
]
```

- [ ] **Step 8:** Confirm boilerplate's `REST_FRAMEWORK` setting in `backend/config/settings/base.py` already has `DEFAULT_SCHEMA_CLASS` + `EXCEPTION_HANDLER`. Leave it untouched here. `DEFAULT_AUTHENTICATION_CLASSES` / `DEFAULT_PERMISSION_CLASSES` are added in Task 6 once `apps.identity.auth.BearerSessionAuthentication` exists (adding them now would break `manage.py check` at import time).

- [ ] **Step 9:** Smoke — `just verify` should still be green (no models added yet, just empty apps).

- [ ] **Step 10:** Commit.

```bash
git add backend/
git commit -m "scaffold(backend): identity, workspaces, github_proxy apps + url wiring"
```

---

## Phase 1 · Identity + device-flow auth

### Task 3: Extend `users.User` with github fields

**Files:**
- Modify: `backend/apps/users/models.py`, `backend/apps/users/factories.py`
- Modify: `backend/apps/admin/admin.py` (if it registers UserAdmin; check first)
- Create: `backend/tests/users/test_user_model.py` (extend existing)
- New migration via makemigrations

- [ ] **Step 1:** Failing test at `backend/tests/users/test_user_model.py`:

```python
from typing import cast

import pytest

from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_user_has_github_fields() -> None:
    user = cast(User, UserFactory(github_login="alice", github_user_id=42))
    assert user.github_login == "alice"
    assert user.github_user_id == 42
    assert user.display_name == ""
    assert user.avatar_url == ""
    assert user.last_login_at is None


@pytest.mark.django_db
def test_user_github_login_unique() -> None:
    UserFactory(github_login="alice", github_user_id=1)
    with pytest.raises(Exception):
        UserFactory(github_login="alice", github_user_id=2)


@pytest.mark.django_db
def test_user_github_user_id_unique() -> None:
    UserFactory(github_login="alice", github_user_id=1)
    with pytest.raises(Exception):
        UserFactory(github_login="bob", github_user_id=1)
```

- [ ] **Step 2:** Run — fail (fields not on model).

```bash
cd backend && uv run pytest tests/users/test_user_model.py -v
```

- [ ] **Step 3:** Extend `backend/apps/users/models.py`:

```python
from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    github_login = models.CharField(max_length=39, unique=True, null=True, blank=True)
    github_user_id = models.BigIntegerField(unique=True, null=True, blank=True)
    display_name = models.CharField(max_length=255, blank=True, default="")
    avatar_url = models.URLField(blank=True, default="")
    last_login_at = models.DateTimeField(null=True, blank=True)
```

`null=True` on the unique github columns lets non-github admin users (e.g. `createsuperuser`) co-exist (D26 admin PAT story does not preclude classic admin accounts).

- [ ] **Step 4:** Extend `backend/apps/users/factories.py`:

```python
import factory
from factory.django import DjangoModelFactory

from apps.users.models import User


class UserFactory(DjangoModelFactory):
    class Meta:
        model = User

    username = factory.Sequence(lambda n: f"user{n}")
    email = factory.LazyAttribute(lambda obj: f"{obj.username}@example.com")
    first_name = factory.Faker("first_name")
    last_name = factory.Faker("last_name")
    github_login = factory.Sequence(lambda n: f"gh-user{n}")
    github_user_id = factory.Sequence(lambda n: 1_000_000 + n)
    display_name = factory.Faker("name")
    avatar_url = factory.LazyAttribute(lambda obj: f"https://avatars.githubusercontent.com/u/{obj.github_user_id}")
```

- [ ] **Step 5:** Generate + apply migration:

```bash
cd backend
uv run python manage.py makemigrations users
uv run python manage.py migrate
```

- [ ] **Step 6:** Run test — pass.

```bash
uv run pytest tests/users/test_user_model.py -v
```

- [ ] **Step 7:** Commit.

```bash
git add backend/apps/users/ backend/tests/users/
git commit -m "feat(users): add github_login/github_user_id/display_name/avatar_url"
```

---

### Task 4: Session model (apps.identity)

**Files:**
- Create: `backend/apps/identity/models.py`, `backend/apps/identity/factories.py`, `backend/tests/identity/test_session_model.py`

- [ ] **Step 1:** Failing test at `backend/tests/identity/test_session_model.py`:

```python
from typing import cast

import pytest

from apps.identity.factories import SessionFactory
from apps.identity.models import Session
from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_session_links_to_user() -> None:
    user = cast(User, UserFactory())
    session = cast(Session, SessionFactory(user=user))
    assert session.user_id == user.pk
    assert session.revoked_at is None
    assert session.token_hash


@pytest.mark.django_db
def test_session_token_hash_is_indexed() -> None:
    Session._meta.get_field("token_hash")  # raises if absent
```

- [ ] **Step 2:** Run — fail.

- [ ] **Step 3:** `backend/apps/identity/models.py`:

```python
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
```

- [ ] **Step 4:** `backend/apps/identity/factories.py`:

```python
import hashlib
import secrets

import factory
from factory.django import DjangoModelFactory

from apps.identity.models import Session
from apps.users.factories import UserFactory


class SessionFactory(DjangoModelFactory):
    class Meta:
        model = Session

    user = factory.SubFactory(UserFactory)
    token_hash = factory.LazyFunction(lambda: hashlib.sha256(secrets.token_urlsafe(32).encode()).hexdigest())
```

- [ ] **Step 5:** Migrate + test pass.

```bash
cd backend
uv run python manage.py makemigrations identity
uv run python manage.py migrate
uv run pytest tests/identity/test_session_model.py -v
```

- [ ] **Step 6:** Commit.

```bash
git add backend/apps/identity/ backend/tests/identity/
git commit -m "feat(identity): Session model + factory"
```

---

### Task 5: Github device-flow client

**Files:**
- Create: `backend/apps/identity/github_oauth.py`, `backend/tests/identity/test_github_oauth.py`

- [ ] **Step 1:** Failing tests at `backend/tests/identity/test_github_oauth.py`:

```python
import pytest
import respx
from httpx import Response

from apps.core.exceptions import ApplicationError
from apps.identity.github_oauth import device_poll, device_start, fetch_user


@respx.mock
def test_device_start_returns_codes() -> None:
    respx.post("https://github.com/login/device/code").mock(
        return_value=Response(200, json={
            "device_code": "dev_abc",
            "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "interval": 5,
            "expires_in": 900,
        }),
    )
    out = device_start()
    assert out["user_code"] == "ABCD-1234"


@respx.mock
def test_device_poll_returns_none_when_pending() -> None:
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=Response(200, json={"error": "authorization_pending"}),
    )
    assert device_poll(device_code="dev_abc") is None


@respx.mock
def test_device_poll_returns_token_when_complete() -> None:
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=Response(200, json={"access_token": "gho_x", "token_type": "bearer"}),
    )
    out = device_poll(device_code="dev_abc")
    assert out is not None and out["access_token"] == "gho_x"


@respx.mock
def test_device_poll_raises_application_error_on_terminal() -> None:
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=Response(200, json={"error": "expired_token"}),
    )
    with pytest.raises(ApplicationError) as exc_info:
        device_poll(device_code="dev_abc")
    assert exc_info.value.status == 400


@respx.mock
def test_fetch_user() -> None:
    respx.get("https://api.github.com/user").mock(
        return_value=Response(200, json={
            "login": "octocat",
            "id": 583231,
            "name": "Octo",
            "avatar_url": "https://x",
        }),
    )
    out = fetch_user(access_token="gho_x")
    assert out["login"] == "octocat"
```

- [ ] **Step 2:** Run — fail.

- [ ] **Step 3:** `backend/apps/identity/github_oauth.py`:

```python
import httpx
import structlog

from apps.core.exceptions import ApplicationError
from config.settings.env_schemas import env

logger = structlog.get_logger(__name__)

_DEVICE_CODE_URL = "https://github.com/login/device/code"
_TOKEN_URL = "https://github.com/login/oauth/access_token"
_USER_URL = f"{env.GITHUB_API_BASE}/user"

_TERMINAL_ERRORS = {"expired_token", "access_denied", "incorrect_device_code", "unsupported_grant_type"}
_PENDING_ERRORS = {"authorization_pending", "slow_down"}


def device_start() -> dict:
    r = httpx.post(
        _DEVICE_CODE_URL,
        data={"client_id": env.GITHUB_OAUTH_CLIENT_ID, "scope": "read:user"},
        headers={"Accept": "application/json"},
        timeout=10.0,
    )
    r.raise_for_status()
    body = r.json()
    logger.info("device_flow_started", user_code=body.get("user_code"))
    return body


def device_poll(*, device_code: str) -> dict | None:
    r = httpx.post(
        _TOKEN_URL,
        data={
            "client_id": env.GITHUB_OAUTH_CLIENT_ID,
            "client_secret": env.GITHUB_OAUTH_CLIENT_SECRET,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        },
        headers={"Accept": "application/json"},
        timeout=10.0,
    )
    r.raise_for_status()
    body = r.json()
    if "access_token" in body:
        logger.info("device_flow_completed")
        return body
    err = body.get("error")
    if err in _PENDING_ERRORS:
        return None
    logger.warning("device_flow_terminal_error", error=err)
    raise ApplicationError(
        "device flow terminated",
        extra={"github_error": err or "unknown"},
        status=400,
    )


def fetch_user(*, access_token: str) -> dict:
    r = httpx.get(
        _USER_URL,
        headers={
            "Authorization": f"token {access_token}",
            "Accept": "application/vnd.github+json",
        },
        timeout=10.0,
    )
    r.raise_for_status()
    return r.json()
```

- [ ] **Step 4:** Run — pass.

- [ ] **Step 5:** Commit.

```bash
git add backend/apps/identity/github_oauth.py backend/tests/identity/test_github_oauth.py
git commit -m "feat(identity): github device-flow client (httpx + ApplicationError)"
```

---

### Task 6: Session service + selectors + Bearer auth class

**Files:**
- Create: `backend/apps/identity/services.py`, `backend/apps/identity/selectors.py`, `backend/apps/identity/auth.py`
- Create: `backend/tests/identity/test_session_services.py`, `backend/tests/identity/test_session_selectors.py`
- Modify: `backend/config/settings/base.py` (uncomment the auth class line from Task 2)

- [ ] **Step 1:** Failing tests at `backend/tests/identity/test_session_services.py`:

```python
from typing import cast

import pytest

from apps.identity.selectors import session_find_user
from apps.identity.services import session_issue, session_revoke
from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_session_issue_returns_token_and_persists_only_hash() -> None:
    user = cast(User, UserFactory())
    raw, session = session_issue(user=user)

    assert isinstance(raw, str) and raw.startswith("stg_")
    assert len(raw) > 20
    session.refresh_from_db()
    assert session.token_hash and session.token_hash != raw


@pytest.mark.django_db
def test_session_revoke_sets_timestamp() -> None:
    user = cast(User, UserFactory())
    _, session = session_issue(user=user)
    session_revoke(session=session)
    session.refresh_from_db()
    assert session.revoked_at is not None
```

And `backend/tests/identity/test_session_selectors.py`:

```python
from typing import cast

import pytest

from apps.identity.selectors import session_find_user
from apps.identity.services import session_issue, session_revoke
from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_session_find_user_returns_user_for_valid_token() -> None:
    user = cast(User, UserFactory())
    raw, _ = session_issue(user=user)
    assert session_find_user(raw_token=raw) == user


@pytest.mark.django_db
def test_session_find_user_returns_none_for_revoked() -> None:
    user = cast(User, UserFactory())
    raw, session = session_issue(user=user)
    session_revoke(session=session)
    assert session_find_user(raw_token=raw) is None


@pytest.mark.django_db
def test_session_find_user_returns_none_for_unknown() -> None:
    assert session_find_user(raw_token="not-a-real-token") is None
```

- [ ] **Step 2:** Run — fail.

- [ ] **Step 3:** `backend/apps/identity/services.py`:

```python
import hashlib
import secrets

from django.db import transaction
from django.utils import timezone

from apps.identity.models import Session
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
```

- [ ] **Step 4:** `backend/apps/identity/selectors.py`:

```python
import hashlib

from django.utils import timezone

from apps.identity.models import Session
from apps.users.models import User


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def session_find_user(*, raw_token: str) -> User | None:
    try:
        session = Session.objects.select_related("user").get(
            token_hash=_hash_token(raw_token),
            revoked_at__isnull=True,
        )
    except Session.DoesNotExist:
        return None
    Session.objects.filter(pk=session.pk).update(last_used_at=timezone.now())
    return session.user
```

- [ ] **Step 5:** `backend/apps/identity/auth.py`:

```python
from rest_framework import authentication, exceptions
from rest_framework.request import Request

from apps.identity.selectors import session_find_user


class BearerSessionAuthentication(authentication.BaseAuthentication):
    keyword = "Bearer"

    def authenticate(self, request: Request):
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not header.startswith(self.keyword + " "):
            return None
        raw = header.split(" ", 1)[1].strip()
        user = session_find_user(raw_token=raw)
        if user is None:
            raise exceptions.AuthenticationFailed("invalid or revoked token")
        return (user, raw)
```

- [ ] **Step 6:** Wire DRF auth defaults now that `BearerSessionAuthentication` exists. Extend `REST_FRAMEWORK` in `backend/config/settings/base.py`:

```python
REST_FRAMEWORK = {
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "EXCEPTION_HANDLER": "apps.core.exception_handlers.application_exception_handler",
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "apps.identity.auth.BearerSessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
}
```

Smoke:

```bash
cd backend && uv run python manage.py check
```

- [ ] **Step 7:** Run tests — pass.

```bash
uv run pytest tests/identity/ -v
```

- [ ] **Step 8:** Commit.

```bash
git add backend/apps/identity/ backend/tests/identity/ backend/config/
git commit -m "feat(identity): session_issue/revoke + session_find_user + Bearer auth class"
```

---

### Task 7: Auth APIView classes (DeviceStartApi, DevicePollApi, AuthMeApi, AuthLogoutApi)

**Files:**
- Modify: `backend/apps/identity/services.py` (add `user_upsert_from_github`)
- Create: `backend/apps/identity/apis.py`, `backend/apps/identity/urls.py`
- Create: `backend/apps/identity/serializers/{device_poll_input.py,device_poll_pending_output.py,device_poll_ok_output.py,user_output.py}`
- Create: `backend/tests/identity/test_apis.py`

- [ ] **Step 1:** Add to `backend/apps/identity/services.py`:

```python
from django.db import transaction
from django.utils import timezone

from apps.users.models import User


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
```

- [ ] **Step 2:** Serializers — one per file under `backend/apps/identity/serializers/`:

```python
# device_poll_input.py
from rest_framework import serializers


class DevicePollInputSerializer(serializers.Serializer):
    device_code = serializers.CharField()
```

```python
# user_output.py
from rest_framework import serializers

from apps.users.models import User


class UserOutputSerializer(serializers.ModelSerializer):
    class Meta:  # pyrefly: ignore[bad-override]
        model = User
        fields = (
            "id",
            "github_login",
            "github_user_id",
            "display_name",
            "avatar_url",
        )
```

```python
# device_poll_ok_output.py
from rest_framework import serializers

from apps.identity.serializers.user_output import UserOutputSerializer


class DevicePollOkOutputSerializer(serializers.Serializer):
    status = serializers.CharField(default="ok")
    session_token = serializers.CharField()
    user = UserOutputSerializer()
```

```python
# device_poll_pending_output.py
from rest_framework import serializers


class DevicePollPendingOutputSerializer(serializers.Serializer):
    status = serializers.CharField(default="pending")
```

- [ ] **Step 3:** Failing tests at `backend/tests/identity/test_apis.py`:

```python
from typing import cast
from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_device_start_proxies_github() -> None:
    client = APIClient()
    with patch("apps.identity.apis.device_start", return_value={"user_code": "ABCD-1234"}):
        resp = client.post("/api/v1/auth/device/start/")
    assert resp.status_code == 200
    assert resp.json()["user_code"] == "ABCD-1234"


@pytest.mark.django_db
def test_device_poll_pending() -> None:
    client = APIClient()
    with patch("apps.identity.apis.device_poll", return_value=None):
        resp = client.post("/api/v1/auth/device/poll/", {"device_code": "x"}, format="json")
    assert resp.status_code == 200
    assert resp.json()["status"] == "pending"


@pytest.mark.django_db
def test_device_poll_success_upserts_user_and_returns_token() -> None:
    client = APIClient()
    with (
        patch("apps.identity.apis.device_poll", return_value={"access_token": "gho_x"}),
        patch("apps.identity.apis.fetch_user", return_value={
            "login": "octocat",
            "id": 583231,
            "name": "Octo",
            "avatar_url": "https://x",
        }),
    ):
        resp = client.post("/api/v1/auth/device/poll/", {"device_code": "x"}, format="json")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["session_token"].startswith("stg_")
    assert User.objects.filter(github_user_id=583231).exists()


@pytest.mark.django_db
def test_me_requires_auth() -> None:
    client = APIClient()
    resp = client.get("/api/v1/auth/me/")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_me_returns_user_payload() -> None:
    user = cast(User, UserFactory(github_login="alice"))
    raw, _ = session_issue(user=user)
    client = APIClient()
    resp = client.get("/api/v1/auth/me/", HTTP_AUTHORIZATION=f"Bearer {raw}")
    assert resp.status_code == 200
    assert resp.json()["github_login"] == "alice"


@pytest.mark.django_db
def test_logout_revokes_session() -> None:
    user = cast(User, UserFactory())
    raw, _ = session_issue(user=user)
    client = APIClient()
    resp = client.post("/api/v1/auth/logout/", HTTP_AUTHORIZATION=f"Bearer {raw}")
    assert resp.status_code == 204
    me = client.get("/api/v1/auth/me/", HTTP_AUTHORIZATION=f"Bearer {raw}")
    assert me.status_code == 401
```

- [ ] **Step 4:** Run — fail.

- [ ] **Step 5:** `backend/apps/identity/apis.py`:

```python
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.identity.github_oauth import device_poll, device_start, fetch_user
from apps.identity.models import Session
from apps.identity.selectors import _hash_token
from apps.identity.serializers.device_poll_input import DevicePollInputSerializer
from apps.identity.serializers.device_poll_ok_output import DevicePollOkOutputSerializer
from apps.identity.serializers.device_poll_pending_output import DevicePollPendingOutputSerializer
from apps.identity.serializers.user_output import UserOutputSerializer
from apps.identity.services import session_issue, session_revoke, user_upsert_from_github


class DeviceStartApi(APIView):
    permission_classes = [AllowAny]
    authentication_classes: list = []

    def post(self, request: Request) -> Response:
        return Response(device_start())


class DevicePollApi(APIView):
    permission_classes = [AllowAny]
    authentication_classes: list = []

    def post(self, request: Request) -> Response:
        serializer = DevicePollInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = device_poll(device_code=serializer.validated_data["device_code"])
        if result is None:
            return Response(DevicePollPendingOutputSerializer({"status": "pending"}).data)
        gh_user = fetch_user(access_token=result["access_token"])
        user = user_upsert_from_github(github_payload=gh_user)
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
                token_hash=_hash_token(raw), revoked_at__isnull=True,
            ).first()
            if session:
                session_revoke(session=session)
        return Response(status=status.HTTP_204_NO_CONTENT)
```

- [ ] **Step 6:** `backend/apps/identity/urls.py`:

```python
from django.urls import path

from apps.identity.apis import AuthLogoutApi, AuthMeApi, DevicePollApi, DeviceStartApi

app_name = "identity"

urlpatterns = [
    path("device/start/", DeviceStartApi.as_view(), name="device-start"),
    path("device/poll/", DevicePollApi.as_view(), name="device-poll"),
    path("me/", AuthMeApi.as_view(), name="me"),
    path("logout/", AuthLogoutApi.as_view(), name="logout"),
]
```

- [ ] **Step 7:** Run all identity tests — pass.

```bash
cd backend && uv run pytest tests/identity/ -v
```

- [ ] **Step 8:** Commit.

```bash
git add backend/apps/identity/ backend/tests/identity/
git commit -m "feat(identity): device-flow + me + logout APIView classes"
```

---

### Task 8: User admin registration (housekeeping)

**Files:** modify `backend/apps/admin/admin.py` (it already exists and registers UserAdmin)

- [ ] **Step 1:** Check whether the existing `apps/admin/admin.py` references `User`. From the boilerplate, `apps/users/admin.py` registers it; the same registration is sufficient because the model class is shared. No change needed unless the new github fields should appear in admin list view.

- [ ] **Step 2:** (Optional polish) In `backend/apps/admin/admin.py`, add list_display for the github fields. Skip if not needed for v1.

- [ ] **Step 3:** Smoke `just verify` — pass.

- [ ] **Step 4:** (No commit if nothing changed.)

---

## Phase 2 · GithubGateway core

### Task 9: GithubGateway scaffold (read methods + error hierarchy)

**Files:**
- Create: `backend/apps/github_proxy/gateway.py`, `backend/apps/github_proxy/exceptions.py`
- Create: `backend/tests/github_proxy/test_gateway_reads.py`

- [ ] **Step 1:** Failing tests at `backend/tests/github_proxy/test_gateway_reads.py`:

```python
import pytest
import respx
from httpx import Response

from apps.github_proxy.exceptions import GithubError, GithubNotFound
from apps.github_proxy.gateway import GithubGateway


@respx.mock
def test_get_pr() -> None:
    respx.get("https://api.github.com/repos/o/r/pulls/1").mock(
        return_value=Response(200, json={"number": 1, "user": {"login": "alice"}}),
    )
    g = GithubGateway(token="t")
    assert g.get_pr("o", "r", 1)["number"] == 1


@respx.mock
def test_get_pr_404_raises_github_not_found() -> None:
    respx.get("https://api.github.com/repos/o/r/pulls/99").mock(
        return_value=Response(404, json={"message": "Not Found"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubNotFound):
        g.get_pr("o", "r", 99)


@respx.mock
def test_list_pr_files() -> None:
    respx.get("https://api.github.com/repos/o/r/pulls/1/files").mock(
        return_value=Response(200, json=[{"filename": "a.py"}, {"filename": "b.py"}]),
    )
    g = GithubGateway(token="t")
    assert len(g.list_pr_files("o", "r", 1)) == 2


@respx.mock
def test_422_raises_generic_github_error() -> None:
    respx.get("https://api.github.com/repos/o/r/pulls/1").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.get_pr("o", "r", 1)
    assert exc.value.status_code == 422


@respx.mock
def test_list_check_runs() -> None:
    respx.get("https://api.github.com/repos/o/r/commits/abc/check-runs").mock(
        return_value=Response(200, json={"check_runs": []}),
    )
    g = GithubGateway(token="t")
    assert g.list_check_runs("o", "r", "abc") == {"check_runs": []}


@respx.mock
def test_search_issues() -> None:
    respx.get("https://api.github.com/search/issues").mock(
        return_value=Response(200, json={"items": []}),
    )
    g = GithubGateway(token="t")
    assert g.search_issues("q") == {"items": []}
```

- [ ] **Step 2:** Run — fail.

- [ ] **Step 3:** `backend/apps/github_proxy/exceptions.py`:

```python
class GithubError(Exception):
    def __init__(self, status_code: int, message: str, body: dict | None = None) -> None:
        self.status_code = status_code
        self.message = message
        self.body = body or {}
        super().__init__(f"{status_code}: {message}")


class GithubNotFound(GithubError):
    pass


class GithubForbidden(GithubError):
    pass


class GithubConflict(GithubError):
    pass
```

- [ ] **Step 4:** `backend/apps/github_proxy/gateway.py`:

```python
from typing import Any

import httpx
import structlog

from apps.github_proxy.exceptions import GithubConflict, GithubError, GithubForbidden, GithubNotFound
from config.settings.env_schemas import env

logger = structlog.get_logger(__name__)

_STATUS_TO_EXC = {404: GithubNotFound, 403: GithubForbidden, 409: GithubConflict, 412: GithubConflict}


class GithubGateway:
    def __init__(self, token: str) -> None:
        self._client = httpx.Client(
            base_url=env.GITHUB_API_BASE,
            headers={
                "Authorization": f"token {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=15.0,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "GithubGateway":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        resp = self._client.request(method, path, **kwargs)
        if resp.status_code < 400:
            return resp
        try:
            body = resp.json()
            msg = body.get("message", resp.text)
        except Exception:
            body, msg = {}, resp.text
        logger.warning("github_error", method=method, path=path, status=resp.status_code, message=msg)
        cls = _STATUS_TO_EXC.get(resp.status_code, GithubError)
        raise cls(resp.status_code, msg, body)

    def get_pr(self, o: str, r: str, n: int) -> dict[str, Any]:
        return self._request("GET", f"/repos/{o}/{r}/pulls/{n}").json()

    def list_pr_files(self, o: str, r: str, n: int) -> list[dict[str, Any]]:
        return self._request("GET", f"/repos/{o}/{r}/pulls/{n}/files").json()

    def get_file_diff(self, o: str, r: str, n: int, path: str) -> dict[str, Any] | None:
        for f in self.list_pr_files(o, r, n):
            if f["filename"] == path:
                return f
        return None

    def list_issue_comments(self, o: str, r: str, n: int) -> list[dict]:
        return self._request("GET", f"/repos/{o}/{r}/issues/{n}/comments").json()

    def list_review_comments(self, o: str, r: str, n: int) -> list[dict]:
        return self._request("GET", f"/repos/{o}/{r}/pulls/{n}/comments").json()

    def list_reviews(self, o: str, r: str, n: int) -> list[dict]:
        return self._request("GET", f"/repos/{o}/{r}/pulls/{n}/reviews").json()

    def list_check_runs(self, o: str, r: str, head_sha: str) -> dict:
        return self._request("GET", f"/repos/{o}/{r}/commits/{head_sha}/check-runs").json()

    def list_workflow_runs(self, o: str, r: str, head_sha: str) -> dict:
        return self._request("GET", f"/repos/{o}/{r}/actions/runs", params={"head_sha": head_sha}).json()

    def search_issues(self, query: str) -> dict:
        return self._request("GET", "/search/issues", params={"q": query}).json()
```

- [ ] **Step 5:** Run — pass.

- [ ] **Step 6:** Commit.

```bash
git add backend/apps/github_proxy/ backend/tests/github_proxy/
git commit -m "feat(github_proxy): GithubGateway read methods + error hierarchy"
```

---

## Phase 3 · Workspace CRUD

### Task 10: Workspace model

**Files:**
- Create: `backend/apps/workspaces/models.py`, `backend/apps/workspaces/factories.py`
- Create: `backend/tests/workspaces/test_workspace_model.py`

- [ ] **Step 1:** Failing tests at `backend/tests/workspaces/test_workspace_model.py`:

```python
import uuid
from typing import cast

import pytest

from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Workspace


@pytest.mark.django_db
def test_workspace_has_uuid_id_from_base_model() -> None:
    ws = cast(Workspace, WorkspaceFactory())
    assert isinstance(ws.id, uuid.UUID)
    assert ws.pr_number is None


@pytest.mark.django_db
def test_workspace_unique_per_repo_head_ref() -> None:
    creator = cast(User, UserFactory())
    WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="feat/x", created_by=creator)
    with pytest.raises(Exception):
        WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="feat/x", created_by=creator)


@pytest.mark.django_db
def test_workspace_unique_per_repo_pr_when_pr_set() -> None:
    creator = cast(User, UserFactory())
    WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="a", pr_number=42, created_by=creator)
    with pytest.raises(Exception):
        WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="b", pr_number=42, created_by=creator)
```

- [ ] **Step 2:** Run — fail.

- [ ] **Step 3:** `backend/apps/workspaces/models.py`:

```python
from django.db import models

from apps.core.models import BaseModel
from apps.users.models import User


class Workspace(BaseModel):
    repo_owner = models.CharField(max_length=255)
    repo_name = models.CharField(max_length=255)
    head_ref = models.CharField(max_length=255)
    base_ref = models.CharField(max_length=255)
    pr_number = models.IntegerField(null=True, blank=True)
    pr_opened_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="created_workspaces")
    last_active_at = models.DateTimeField(auto_now=True)

    class Meta:  # pyrefly: ignore[bad-override]
        db_table = "workspace"
        constraints = [
            models.UniqueConstraint(
                fields=["repo_owner", "repo_name", "head_ref"],
                name="uniq_workspace_repo_head",
            ),
            models.UniqueConstraint(
                fields=["repo_owner", "repo_name", "pr_number"],
                name="uniq_workspace_repo_pr",
                condition=models.Q(pr_number__isnull=False),
            ),
        ]
```

- [ ] **Step 4:** `backend/apps/workspaces/factories.py`:

```python
import factory
from factory.django import DjangoModelFactory

from apps.users.factories import UserFactory
from apps.workspaces.models import Workspace


class WorkspaceFactory(DjangoModelFactory):
    class Meta:
        model = Workspace

    repo_owner = factory.Sequence(lambda n: f"owner{n}")
    repo_name = factory.Sequence(lambda n: f"repo{n}")
    head_ref = factory.Sequence(lambda n: f"feat/x{n}")
    base_ref = "main"
    created_by = factory.SubFactory(UserFactory)
```

- [ ] **Step 5:** Migrate + tests pass.

```bash
cd backend
uv run python manage.py makemigrations workspaces
uv run python manage.py migrate
uv run pytest tests/workspaces/test_workspace_model.py -v
```

- [ ] **Step 6:** Commit.

```bash
git add backend/apps/workspaces/ backend/tests/workspaces/
git commit -m "feat(workspaces): Workspace model (BaseModel + uniqueness constraints)"
```

---

### Task 11: Workspace services + selectors + API classes (create/list/lookup/get/patch)

**Files:**
- Create: `backend/apps/workspaces/services.py` (workspace_create, workspace_update_local_phase)
- Create: `backend/apps/workspaces/selectors.py` (workspace_list, workspace_get, workspace_lookup)
- Create: `backend/apps/workspaces/apis.py` (Workspace{Create,List,Lookup,Detail,Update}Api)
- Create: `backend/apps/workspaces/serializers/{workspace_create_input.py,workspace_update_input.py,workspace_output.py,workspace_lookup_output.py}`
- Modify: `backend/apps/workspaces/urls.py`
- Create: `backend/tests/workspaces/{test_workspace_services.py,test_workspace_selectors.py,test_workspace_apis.py}`

- [ ] **Step 1:** Failing tests at `backend/tests/workspaces/test_workspace_services.py`:

```python
from typing import cast

import pytest

from apps.core.exceptions import ApplicationError
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Workspace
from apps.workspaces.services import workspace_create, workspace_update_local_phase


@pytest.mark.django_db
def test_workspace_create_persists_with_creator() -> None:
    creator = cast(User, UserFactory())
    ws = workspace_create(
        creator=creator, repo_owner="o", repo_name="r",
        head_ref="feat/x", base_ref="main",
    )
    assert ws.created_by_id == creator.pk
    assert ws.pr_number is None
    assert Workspace.objects.filter(pk=ws.pk).exists()


@pytest.mark.django_db
def test_workspace_create_rejects_duplicate() -> None:
    creator = cast(User, UserFactory())
    WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="feat/x", created_by=creator)
    with pytest.raises(ApplicationError) as exc:
        workspace_create(creator=creator, repo_owner="o", repo_name="r", head_ref="feat/x", base_ref="main")
    assert exc.value.status == 409


@pytest.mark.django_db
def test_workspace_update_local_phase_changes_head_ref() -> None:
    ws = cast(Workspace, WorkspaceFactory(head_ref="feat/x"))
    updated = workspace_update_local_phase(workspace=ws, head_ref="feat/y")
    assert updated.head_ref == "feat/y"


@pytest.mark.django_db
def test_workspace_update_local_phase_rejects_when_pr_open() -> None:
    ws = cast(Workspace, WorkspaceFactory(pr_number=42))
    with pytest.raises(ApplicationError) as exc:
        workspace_update_local_phase(workspace=ws, head_ref="other")
    assert exc.value.status == 409
```

And at `backend/tests/workspaces/test_workspace_selectors.py`:

```python
from typing import cast

import pytest

from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Workspace
from apps.workspaces.selectors import workspace_get, workspace_list, workspace_lookup


@pytest.mark.django_db
def test_workspace_list_returns_all() -> None:
    WorkspaceFactory()
    WorkspaceFactory()
    assert workspace_list().count() == 2


@pytest.mark.django_db
def test_workspace_lookup_hit() -> None:
    ws = cast(Workspace, WorkspaceFactory(repo_owner="o", repo_name="r", pr_number=42))
    assert workspace_lookup(repo_owner="o", repo_name="r", pr_number=42) == ws


@pytest.mark.django_db
def test_workspace_lookup_miss() -> None:
    assert workspace_lookup(repo_owner="o", repo_name="r", pr_number=99) is None


@pytest.mark.django_db
def test_workspace_get_raises_when_missing() -> None:
    from apps.workspaces.models import Workspace as _W
    import uuid
    with pytest.raises(_W.DoesNotExist):
        workspace_get(workspace_id=uuid.uuid4())
```

And at `backend/tests/workspaces/test_workspace_apis.py`:

```python
from typing import cast

import pytest
from rest_framework.test import APIClient

from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Workspace


@pytest.fixture
def authed_client(db) -> tuple[APIClient, User]:
    user = cast(User, UserFactory())
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client, user


@pytest.mark.django_db
def test_workspace_create_api_201(authed_client) -> None:
    client, _ = authed_client
    resp = client.post(
        "/api/v1/workspaces/",
        {"repo_owner": "o", "repo_name": "r", "head_ref": "feat/x", "base_ref": "main"},
        format="json",
    )
    assert resp.status_code == 201
    assert resp.json()["head_ref"] == "feat/x"
    assert Workspace.objects.filter(repo_owner="o", head_ref="feat/x").exists()


@pytest.mark.django_db
def test_workspace_create_duplicate_returns_409(authed_client) -> None:
    client, user = authed_client
    WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="feat/x", created_by=user)
    resp = client.post(
        "/api/v1/workspaces/",
        {"repo_owner": "o", "repo_name": "r", "head_ref": "feat/x", "base_ref": "main"},
        format="json",
    )
    assert resp.status_code == 409


@pytest.mark.django_db
def test_workspace_list_api(authed_client) -> None:
    client, _ = authed_client
    WorkspaceFactory()
    resp = client.get("/api/v1/workspaces/")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1


@pytest.mark.django_db
def test_workspace_lookup_api_hit(authed_client) -> None:
    client, user = authed_client
    ws = WorkspaceFactory(repo_owner="o", repo_name="r", pr_number=42, created_by=user)
    resp = client.get("/api/v1/workspaces/lookup/?repo_owner=o&repo_name=r&pr_number=42")
    assert resp.status_code == 200
    assert resp.json()["workspace_id"] == str(ws.id)


@pytest.mark.django_db
def test_workspace_lookup_api_miss(authed_client) -> None:
    client, _ = authed_client
    resp = client.get("/api/v1/workspaces/lookup/?repo_owner=o&repo_name=r&pr_number=99")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_workspace_detail_api(authed_client) -> None:
    client, _ = authed_client
    ws = WorkspaceFactory()
    resp = client.get(f"/api/v1/workspaces/{ws.id}/")
    assert resp.status_code == 200
    assert resp.json()["id"] == str(ws.id)


@pytest.mark.django_db
def test_workspace_update_api(authed_client) -> None:
    client, _ = authed_client
    ws = WorkspaceFactory(head_ref="feat/x")
    resp = client.patch(f"/api/v1/workspaces/{ws.id}/", {"head_ref": "feat/y"}, format="json")
    assert resp.status_code == 200
    ws.refresh_from_db()
    assert ws.head_ref == "feat/y"
```

- [ ] **Step 2:** Run — fail.

- [ ] **Step 3:** `backend/apps/workspaces/services.py`:

```python
from django.db import IntegrityError, transaction

from apps.core.exceptions import ApplicationError
from apps.users.models import User
from apps.workspaces.models import Workspace


@transaction.atomic
def workspace_create(
    *,
    creator: User,
    repo_owner: str,
    repo_name: str,
    head_ref: str,
    base_ref: str,
) -> Workspace:
    try:
        return Workspace.objects.create(
            created_by=creator,
            repo_owner=repo_owner,
            repo_name=repo_name,
            head_ref=head_ref,
            base_ref=base_ref,
        )
    except IntegrityError as exc:
        raise ApplicationError(
            "Workspace already exists for that repo + head_ref",
            extra={"repo_owner": repo_owner, "repo_name": repo_name, "head_ref": head_ref},
            status=409,
        ) from exc


@transaction.atomic
def workspace_update_local_phase(
    *,
    workspace: Workspace,
    head_ref: str | None = None,
    base_ref: str | None = None,
) -> Workspace:
    if workspace.pr_number is not None:
        raise ApplicationError(
            "head_ref / base_ref not editable once a PR is open",
            extra={"workspace_id": str(workspace.id)},
            status=409,
        )
    if head_ref is not None:
        workspace.head_ref = head_ref
    if base_ref is not None:
        workspace.base_ref = base_ref
    try:
        workspace.save(update_fields=["head_ref", "base_ref", "updated_at"])
    except IntegrityError as exc:
        raise ApplicationError(
            "Update collides with existing workspace",
            extra={"workspace_id": str(workspace.id)},
            status=409,
        ) from exc
    return workspace
```

- [ ] **Step 4:** `backend/apps/workspaces/selectors.py`:

```python
import uuid

from django.db.models import QuerySet

from apps.workspaces.models import Workspace


def workspace_list() -> QuerySet[Workspace]:
    return (
        Workspace.objects.select_related("created_by")
        .all()
        .order_by("-last_active_at")
    )


def workspace_get(*, workspace_id: uuid.UUID) -> Workspace:
    return Workspace.objects.select_related("created_by").get(pk=workspace_id)


def workspace_lookup(*, repo_owner: str, repo_name: str, pr_number: int) -> Workspace | None:
    return (
        Workspace.objects.select_related("created_by")
        .filter(repo_owner=repo_owner, repo_name=repo_name, pr_number=pr_number)
        .first()
    )
```

- [ ] **Step 5:** Serializers. One per file in `backend/apps/workspaces/serializers/`:

```python
# workspace_create_input.py
from rest_framework import serializers


class WorkspaceCreateInputSerializer(serializers.Serializer):
    repo_owner = serializers.CharField(max_length=255)
    repo_name = serializers.CharField(max_length=255)
    head_ref = serializers.CharField(max_length=255)
    base_ref = serializers.CharField(max_length=255, required=False, default="main")
```

```python
# workspace_update_input.py
from rest_framework import serializers


class WorkspaceUpdateInputSerializer(serializers.Serializer):
    head_ref = serializers.CharField(max_length=255, required=False)
    base_ref = serializers.CharField(max_length=255, required=False)
```

```python
# workspace_output.py
from rest_framework import serializers

from apps.workspaces.models import Workspace


class WorkspaceOutputSerializer(serializers.ModelSerializer):
    created_by = serializers.SerializerMethodField()

    class Meta:  # pyrefly: ignore[bad-override]
        model = Workspace
        fields = (
            "id",
            "repo_owner",
            "repo_name",
            "head_ref",
            "base_ref",
            "pr_number",
            "pr_opened_at",
            "created_by",
            "created_at",
            "last_active_at",
        )

    def get_created_by(self, obj: Workspace) -> dict:
        u = obj.created_by
        return {"id": u.pk, "github_login": u.github_login}
```

```python
# workspace_lookup_output.py
from rest_framework import serializers


class WorkspaceLookupOutputSerializer(serializers.Serializer):
    workspace_id = serializers.UUIDField()
    created_by = serializers.DictField()
```

- [ ] **Step 6:** `backend/apps/workspaces/apis.py`:

```python
import uuid

from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.exceptions import ApplicationError
from apps.workspaces.selectors import workspace_get, workspace_list, workspace_lookup
from apps.workspaces.serializers.workspace_create_input import WorkspaceCreateInputSerializer
from apps.workspaces.serializers.workspace_lookup_output import WorkspaceLookupOutputSerializer
from apps.workspaces.serializers.workspace_output import WorkspaceOutputSerializer
from apps.workspaces.serializers.workspace_update_input import WorkspaceUpdateInputSerializer
from apps.workspaces.services import workspace_create, workspace_update_local_phase


class WorkspaceCreateApi(APIView):
    def post(self, request: Request) -> Response:
        serializer = WorkspaceCreateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        ws = workspace_create(creator=request.user, **serializer.validated_data)
        return Response(WorkspaceOutputSerializer(ws).data, status=status.HTTP_201_CREATED)


class WorkspaceListApi(APIView):
    def get(self, request: Request) -> Response:
        qs = workspace_list()
        return Response(WorkspaceOutputSerializer(qs, many=True).data)


class WorkspaceLookupApi(APIView):
    def get(self, request: Request) -> Response:
        o = request.query_params.get("repo_owner")
        r = request.query_params.get("repo_name")
        pr = request.query_params.get("pr_number")
        if not all([o, r, pr]):
            raise ApplicationError(
                "repo_owner, repo_name, pr_number are required",
                extra={"received": dict(request.query_params)},
                status=400,
            )
        ws = workspace_lookup(repo_owner=o, repo_name=r, pr_number=int(pr))
        if ws is None:
            raise ApplicationError("Not found", status=404)
        return Response(
            WorkspaceLookupOutputSerializer({
                "workspace_id": ws.id,
                "created_by": {"id": ws.created_by_id, "github_login": ws.created_by.github_login},
            }).data,
        )


class WorkspaceDetailApi(APIView):
    def get(self, request: Request, workspace_id: uuid.UUID) -> Response:
        ws = workspace_get(workspace_id=workspace_id)
        return Response(WorkspaceOutputSerializer(ws).data)


class WorkspaceUpdateApi(APIView):
    def patch(self, request: Request, workspace_id: uuid.UUID) -> Response:
        ws = workspace_get(workspace_id=workspace_id)
        serializer = WorkspaceUpdateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        updated = workspace_update_local_phase(workspace=ws, **serializer.validated_data)
        return Response(WorkspaceOutputSerializer(updated).data)
```

- [ ] **Step 7:** `backend/apps/workspaces/urls.py`:

```python
from django.urls import path

from apps.workspaces.apis import (
    WorkspaceCreateApi,
    WorkspaceDetailApi,
    WorkspaceListApi,
    WorkspaceLookupApi,
    WorkspaceUpdateApi,
)

app_name = "workspaces"

urlpatterns = [
    path("workspaces/", WorkspaceListApi.as_view(), name="list"),
    path("workspaces/create/", WorkspaceCreateApi.as_view(), name="create"),
    path("workspaces/lookup/", WorkspaceLookupApi.as_view(), name="lookup"),
    path("workspaces/<uuid:workspace_id>/", WorkspaceDetailApi.as_view(), name="detail"),
    path("workspaces/<uuid:workspace_id>/update/", WorkspaceUpdateApi.as_view(), name="update"),
]
```

> Style note: the boilerplate uses `/create/`, `/update/`, `/archive/`, `/delete/` per-verb URLs (see `apps/items/urls.py`). We keep that style here. The contract doc `docs/api.md` lists shorter URLs (e.g. `POST /api/v1/workspaces` for create); update `docs/api.md` to match this style **OR** keep flat URLs by routing POST through a single APIView per resource. We pick the boilerplate style and update `docs/api.md` accordingly in Task 24.

- [ ] **Step 8:** Run — pass.

```bash
cd backend && uv run pytest tests/workspaces/ -v
```

- [ ] **Step 9:** Commit.

```bash
git add backend/apps/workspaces/ backend/tests/workspaces/
git commit -m "feat(workspaces): create/list/lookup/detail/update endpoints + services + selectors"
```

---

### Task 12: Seed empty Storyline on workspace create

**Files:**
- Modify: `backend/apps/workspaces/services.py` (extend `workspace_create` to call `storyline_create`)
- Modify: `backend/apps/workspaces/models.py` (add `Storyline`, `StorylineFile`)
- Create: `backend/apps/workspaces/storyline/services.py` is NOT needed — keep services flat per styleguide; place `storyline_create` inside `apps/workspaces/services.py`.
- Append to: `backend/tests/workspaces/test_workspace_services.py`

> Models for Storyline / StorylineFile arrive here so the `workspace_create` integration test passes; the **full** field set (with `intro_text`, `title`, `etag`, etc.) is defined in Task 13. For now we add the minimum needed.

- [ ] **Step 1:** Failing test appended to `backend/tests/workspaces/test_workspace_services.py`:

```python
@pytest.mark.django_db
def test_workspace_create_seeds_empty_storyline() -> None:
    from apps.workspaces.models import Storyline
    creator = cast(User, UserFactory())
    ws = workspace_create(
        creator=creator, repo_owner="o", repo_name="r",
        head_ref="feat/x", base_ref="main",
    )
    assert Storyline.objects.filter(workspace=ws).exists()
    assert ws.storyline.files.count() == 0
```

- [ ] **Step 2:** Run — fail (models missing).

- [ ] **Step 3:** Add to `backend/apps/workspaces/models.py`:

```python
class Storyline(BaseModel):
    workspace = models.OneToOneField(Workspace, on_delete=models.CASCADE, related_name="storyline")
    raw_json = models.TextField(default="{}")
    etag = models.CharField(max_length=36)
    updated_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="storyline_updates")

    class Meta:  # pyrefly: ignore[bad-override]
        db_table = "storyline"


class StorylineFile(BaseModel):
    storyline = models.ForeignKey(Storyline, on_delete=models.CASCADE, related_name="files")
    diff_file_path = models.CharField(max_length=1024)
    order_index = models.IntegerField()
    title = models.CharField(max_length=255, blank=True, default="")
    intro_text = models.TextField(blank=True, default="")

    class Meta:  # pyrefly: ignore[bad-override]
        db_table = "storyline_file"
        ordering = ["order_index"]
        constraints = [
            models.UniqueConstraint(fields=["storyline", "diff_file_path"], name="uniq_storyline_file_path"),
        ]
```

- [ ] **Step 4:** Add to `backend/apps/workspaces/services.py`:

```python
import json
import uuid

from apps.workspaces.models import Storyline, Workspace


def _new_etag() -> str:
    return str(uuid.uuid4())


@transaction.atomic
def storyline_create(*, workspace: Workspace, author: User) -> Storyline:
    return Storyline.objects.create(
        workspace=workspace,
        raw_json=json.dumps({"files": []}),
        etag=_new_etag(),
        updated_by=author,
    )
```

Modify `workspace_create` to call it inside the same transaction:

```python
@transaction.atomic
def workspace_create(...) -> Workspace:
    try:
        ws = Workspace.objects.create(...)
    except IntegrityError as exc:
        raise ApplicationError(..., status=409) from exc
    storyline_create(workspace=ws, author=creator)
    return ws
```

- [ ] **Step 5:** Migrate + tests pass.

```bash
cd backend
uv run python manage.py makemigrations workspaces
uv run python manage.py migrate
uv run pytest tests/workspaces/test_workspace_services.py -v
```

- [ ] **Step 6:** Commit.

```bash
git add backend/apps/workspaces/ backend/tests/workspaces/
git commit -m "feat(workspaces): seed empty Storyline + StorylineFile on workspace_create"
```

---

## Phase 4 · Storyline

### Task 13: Storyline + StorylineFile model assertions (constraints already exist; cover with explicit tests)

**Files:** `backend/tests/workspaces/test_storyline_model.py`

- [ ] **Step 1:** Tests at `backend/tests/workspaces/test_storyline_model.py`:

```python
from typing import cast

import pytest

from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Storyline, StorylineFile, Workspace


@pytest.mark.django_db
def test_storyline_is_one_to_one_with_workspace() -> None:
    ws = cast(Workspace, WorkspaceFactory())
    # storyline already created by workspace_create; using factory directly skips that path
    # so we create one here explicitly:
    user = cast(User, UserFactory())
    Storyline.objects.create(workspace=ws, etag="e", updated_by=user)
    with pytest.raises(Exception):
        Storyline.objects.create(workspace=ws, etag="e2", updated_by=user)


@pytest.mark.django_db
def test_storyline_file_unique_path_per_storyline() -> None:
    ws = cast(Workspace, WorkspaceFactory())
    user = cast(User, UserFactory())
    s = Storyline.objects.create(workspace=ws, etag="e", updated_by=user)
    StorylineFile.objects.create(storyline=s, diff_file_path="a.py", order_index=0)
    with pytest.raises(Exception):
        StorylineFile.objects.create(storyline=s, diff_file_path="a.py", order_index=1)
```

- [ ] **Step 2:** Run — pass (models exist from Task 12). Commit.

```bash
git add backend/tests/workspaces/test_storyline_model.py
git commit -m "test(workspaces): cover Storyline OneToOne + StorylineFile uniqueness"
```

---

### Task 14: Storyline service (replace) + selector (read with stale flag)

**Files:**
- Modify: `backend/apps/workspaces/services.py` (add `storyline_replace`)
- Modify: `backend/apps/workspaces/selectors.py` (add `storyline_read`, `workspace_is_frozen`)
- Create: `backend/tests/workspaces/{test_storyline_services.py,test_storyline_selectors.py}`

- [ ] **Step 1:** Failing tests at `backend/tests/workspaces/test_storyline_services.py`:

```python
from typing import cast
from unittest.mock import MagicMock

import pytest

from apps.core.exceptions import ApplicationError
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Storyline, StorylineFile, Workspace
from apps.workspaces.services import storyline_create, storyline_replace


@pytest.fixture
def author_ws(db) -> tuple[Workspace, User]:
    user = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(created_by=user))
    storyline_create(workspace=ws, author=user)
    return ws, user


def test_storyline_replace_rejects_non_creator(author_ws) -> None:
    ws, _ = author_ws
    bob = cast(User, UserFactory())
    gateway = MagicMock()
    with pytest.raises(ApplicationError) as exc:
        storyline_replace(workspace=ws, user=bob, files=[], if_match=ws.storyline.etag, gateway=gateway)
    assert exc.value.status == 403


def test_storyline_replace_rejects_stale_etag(author_ws) -> None:
    ws, user = author_ws
    gateway = MagicMock()
    with pytest.raises(ApplicationError) as exc:
        storyline_replace(workspace=ws, user=user, files=[], if_match="wrong", gateway=gateway)
    assert exc.value.status == 409
    assert exc.value.message == "etag_mismatch"


def test_storyline_replace_rejects_frozen(author_ws) -> None:
    ws, user = author_ws
    ws.pr_number = 1
    ws.save(update_fields=["pr_number"])
    gateway = MagicMock()
    gateway.get_pr.return_value = {"state": "closed", "merged": False}
    with pytest.raises(ApplicationError) as exc:
        storyline_replace(workspace=ws, user=user, files=[], if_match=ws.storyline.etag, gateway=gateway)
    assert exc.value.status == 409
    assert exc.value.message == "workspace_frozen"


def test_storyline_replace_swaps_files_and_returns_new_etag(author_ws) -> None:
    ws, user = author_ws
    StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="old.py", order_index=0)
    gateway = MagicMock()
    old = ws.storyline.etag
    new = storyline_replace(
        workspace=ws, user=user,
        files=[{"diff_file_path": "new.py", "order_index": 0, "title": "T", "intro_text": "i"}],
        if_match=old, gateway=gateway,
    )
    assert new != old
    ws.refresh_from_db()
    assert ws.storyline.files.count() == 1
    assert ws.storyline.files.first().diff_file_path == "new.py"
```

And at `backend/tests/workspaces/test_storyline_selectors.py`:

```python
from typing import cast
from unittest.mock import MagicMock

import pytest

from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import StorylineFile, Workspace
from apps.workspaces.selectors import storyline_read
from apps.workspaces.services import storyline_create


@pytest.fixture
def author_ws(db) -> tuple[Workspace, User]:
    user = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(created_by=user))
    storyline_create(workspace=ws, author=user)
    return ws, user


def test_storyline_read_local_phase_no_stale(author_ws) -> None:
    ws, _ = author_ws
    StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="a.py", order_index=0, intro_text="hi")
    gateway = MagicMock()
    data, etag = storyline_read(workspace=ws, gateway=gateway)
    assert etag
    assert data["files"][0]["stale"] is False
    gateway.list_pr_files.assert_not_called()


def test_storyline_read_public_phase_marks_stale(author_ws) -> None:
    ws, _ = author_ws
    ws.pr_number = 5
    ws.save(update_fields=["pr_number"])
    StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="gone.py", order_index=0, intro_text="x")
    gateway = MagicMock()
    gateway.list_pr_files.return_value = [{"filename": "still_here.py"}]
    gateway.get_pr.return_value = {"head": {"sha": "abc"}}
    data, _ = storyline_read(workspace=ws, gateway=gateway)
    assert data["files"][0]["stale"] is True
    assert data["files"][0]["stale_reason"] == "file_removed"
```

- [ ] **Step 2:** Run — fail.

- [ ] **Step 3:** Add to `backend/apps/workspaces/services.py`:

```python
@transaction.atomic
def storyline_replace(
    *,
    workspace: Workspace,
    user: User,
    files: list[dict],
    if_match: str,
    gateway,
) -> str:
    if user.pk != workspace.created_by_id:
        raise ApplicationError(
            "Only the workspace creator can edit the storyline",
            extra={"workspace_id": str(workspace.id)},
            status=403,
        )

    if workspace.pr_number is not None:
        pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
        if pr.get("state") == "closed":
            raise ApplicationError(
                "workspace_frozen",
                extra={"workspace_id": str(workspace.id)},
                status=409,
            )

    s = Storyline.objects.select_for_update().get(workspace=workspace)
    if s.etag != if_match:
        raise ApplicationError(
            "etag_mismatch",
            extra={"current_etag": s.etag},
            status=409,
        )

    StorylineFile.objects.filter(storyline=s).delete()
    StorylineFile.objects.bulk_create([
        StorylineFile(
            storyline=s,
            diff_file_path=f["diff_file_path"],
            order_index=f.get("order_index", idx),
            title=f.get("title", ""),
            intro_text=f.get("intro_text", ""),
        )
        for idx, f in enumerate(files)
    ])

    s.raw_json = json.dumps({"files": files})
    s.etag = _new_etag()
    s.updated_by = user
    s.save(update_fields=["raw_json", "etag", "updated_by", "updated_at"])

    workspace.save(update_fields=["last_active_at", "updated_at"])

    return s.etag
```

- [ ] **Step 4:** Add to `backend/apps/workspaces/selectors.py`:

```python
def workspace_is_frozen(*, workspace: Workspace, gateway) -> bool:
    if workspace.pr_number is None:
        return False
    pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
    return pr.get("state") == "closed"


def storyline_read(*, workspace: Workspace, gateway) -> tuple[dict, str]:
    s = workspace.storyline
    files = list(s.files.all())

    head_sha = None
    stale_paths: set[str] = set()
    if workspace.pr_number:
        pr_files = gateway.list_pr_files(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
        valid = {f["filename"] for f in pr_files}
        for f in files:
            if f.diff_file_path not in valid:
                stale_paths.add(f.diff_file_path)
        pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
        head_sha = (pr.get("head") or {}).get("sha")

    payload = {
        "etag": s.etag,
        "head_sha": head_sha,
        "files": [
            {
                "id": f.pk,
                "diff_file_path": f.diff_file_path,
                "order_index": f.order_index,
                "title": f.title,
                "intro_text": f.intro_text,
                "stale": f.diff_file_path in stale_paths,
                "stale_reason": "file_removed" if f.diff_file_path in stale_paths else None,
            }
            for f in files
        ],
    }
    return payload, s.etag
```

- [ ] **Step 5:** Run — pass. Commit.

```bash
git add backend/apps/workspaces/ backend/tests/workspaces/
git commit -m "feat(workspaces): storyline_replace + storyline_read (with stale flags)"
```

---

### Task 15: Storyline API classes (read + update + single-file read)

**Files:**
- Modify: `backend/apps/workspaces/apis.py` (add `StorylineDetailApi`, `StorylineUpdateApi`, `StorylineFileDetailApi`)
- Create: `backend/apps/workspaces/serializers/storyline_update_input.py`
- Modify: `backend/apps/workspaces/urls.py`
- Create: `backend/tests/workspaces/test_storyline_apis.py`

The API splits read (`GET`) and update (`PUT`) into **separate APIView classes** per styleguide ("one class per HTTP operation"), routed to the same URL with different HTTP methods declared on each.

- [ ] **Step 1:** Failing tests at `backend/tests/workspaces/test_storyline_apis.py` covering:
  - 200 GET (returns stored etag header)
  - 200 PUT with correct If-Match
  - 428 PUT without If-Match header (use `412 Precondition Failed` or `428 Precondition Required` — choose `428` and update `docs/api.md` if needed; the contract currently says `412`. Pick `412` for alignment.)
  - 409 PUT with stale etag (returns `{"message": "etag_mismatch"}`)
  - 403 PUT by non-creator
  - 409 PUT when workspace is frozen (mock `gateway.get_pr` to return `{"state": "closed"}`)
  - 200 GET single file by id

Test template:

```python
from typing import cast
from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import StorylineFile
from apps.workspaces.services import storyline_create


@pytest.fixture
def authed_ws(db) -> tuple[APIClient, User, "Workspace"]:
    user = cast(User, UserFactory())
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    ws = WorkspaceFactory(created_by=user)
    storyline_create(workspace=ws, author=user)
    return client, user, ws


@pytest.mark.django_db
def test_storyline_get_returns_etag(authed_ws) -> None:
    client, _, ws = authed_ws
    StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="a.py", order_index=0, intro_text="hi")
    resp = client.get(f"/api/v1/workspaces/{ws.id}/storyline/")
    assert resp.status_code == 200
    assert resp["ETag"] == ws.storyline.etag


@pytest.mark.django_db
def test_storyline_put_requires_if_match(authed_ws) -> None:
    client, _, ws = authed_ws
    resp = client.put(f"/api/v1/workspaces/{ws.id}/storyline/", {"files": []}, format="json")
    assert resp.status_code == 412


@pytest.mark.django_db
def test_storyline_put_etag_mismatch_409(authed_ws) -> None:
    client, _, ws = authed_ws
    resp = client.put(
        f"/api/v1/workspaces/{ws.id}/storyline/",
        {"files": []},
        format="json",
        HTTP_IF_MATCH="wrong",
    )
    assert resp.status_code == 409
    assert resp.json()["message"] == "etag_mismatch"


@pytest.mark.django_db
def test_storyline_put_writes_files(authed_ws) -> None:
    client, _, ws = authed_ws
    resp = client.put(
        f"/api/v1/workspaces/{ws.id}/storyline/",
        {"files": [{"diff_file_path": "a.py", "order_index": 0, "title": "Hi", "intro_text": "intro"}]},
        format="json",
        HTTP_IF_MATCH=ws.storyline.etag,
    )
    assert resp.status_code == 200
    assert resp.json()["files"][0]["diff_file_path"] == "a.py"


@pytest.mark.django_db
def test_storyline_put_rejects_non_creator(authed_ws) -> None:
    client, _, ws = authed_ws
    # second user
    bob = cast(User, UserFactory())
    raw, _ = session_issue(user=bob)
    bob_client = APIClient()
    bob_client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    resp = bob_client.put(
        f"/api/v1/workspaces/{ws.id}/storyline/",
        {"files": []},
        format="json",
        HTTP_IF_MATCH=ws.storyline.etag,
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_storyline_get_single_file(authed_ws) -> None:
    client, _, ws = authed_ws
    f = StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="a.py", order_index=0)
    resp = client.get(f"/api/v1/workspaces/{ws.id}/storyline/files/{f.pk}/")
    assert resp.status_code == 200
    assert resp.json()["diff_file_path"] == "a.py"
```

- [ ] **Step 2:** Run — fail.

- [ ] **Step 3:** Serializer at `backend/apps/workspaces/serializers/storyline_update_input.py`:

```python
from rest_framework import serializers


class StorylineFileInputSerializer(serializers.Serializer):
    diff_file_path = serializers.CharField(max_length=1024)
    order_index = serializers.IntegerField(min_value=0)
    title = serializers.CharField(max_length=255, required=False, allow_blank=True, default="")
    intro_text = serializers.CharField(required=False, allow_blank=True, default="")


class StorylineUpdateInputSerializer(serializers.Serializer):
    files = StorylineFileInputSerializer(many=True)
```

- [ ] **Step 4:** Append to `backend/apps/workspaces/apis.py`:

```python
from django.conf import settings as django_settings  # only if needed; prefer env directly

from apps.github_proxy.gateway import GithubGateway
from apps.workspaces.serializers.storyline_update_input import StorylineUpdateInputSerializer
from apps.workspaces.services import storyline_replace
from apps.workspaces.selectors import storyline_read
from config.settings.env_schemas import env


def _gateway() -> GithubGateway:
    return GithubGateway(token=env.GITHUB_ADMIN_PAT)


class StorylineDetailApi(APIView):
    def get(self, request: Request, workspace_id: uuid.UUID) -> Response:
        ws = workspace_get(workspace_id=workspace_id)
        with _gateway() as g:
            data, etag = storyline_read(workspace=ws, gateway=g)
        response = Response(data)
        response["ETag"] = etag
        return response


class StorylineUpdateApi(APIView):
    def put(self, request: Request, workspace_id: uuid.UUID) -> Response:
        ws = workspace_get(workspace_id=workspace_id)
        if_match = request.headers.get("If-Match")
        if not if_match:
            return Response(
                {"message": "precondition_required", "extra": {}},
                status=status.HTTP_412_PRECONDITION_FAILED,
            )
        serializer = StorylineUpdateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        with _gateway() as g:
            storyline_replace(
                workspace=ws, user=request.user,
                files=[dict(f) for f in serializer.validated_data["files"]],
                if_match=if_match, gateway=g,
            )
            data, etag = storyline_read(workspace=ws, gateway=g)
        response = Response(data)
        response["ETag"] = etag
        return response


class StorylineFileDetailApi(APIView):
    def get(self, request: Request, workspace_id: uuid.UUID, file_id: int) -> Response:
        ws = workspace_get(workspace_id=workspace_id)
        with _gateway() as g:
            data, _ = storyline_read(workspace=ws, gateway=g)
        for f in data["files"]:
            if f["id"] == file_id:
                return Response(f)
        raise ApplicationError("not_found", status=404)
```

- [ ] **Step 5:** Extend `backend/apps/workspaces/urls.py`:

```python
from apps.workspaces.apis import (
    StorylineDetailApi,
    StorylineFileDetailApi,
    StorylineUpdateApi,
    # ... existing imports
)

urlpatterns += [
    path("workspaces/<uuid:workspace_id>/storyline/", StorylineDetailApi.as_view(), name="storyline-detail"),
    # Note: PUT goes through StorylineUpdateApi which is mounted on the SAME path via DRF
    # method dispatch isn't built-in — solution: add a second route with a different name
    # using the same path, OR have one API view dispatch both. To match the "one class per op"
    # rule strictly, mount StorylineUpdateApi at a distinct URL:
    path("workspaces/<uuid:workspace_id>/storyline/update/", StorylineUpdateApi.as_view(), name="storyline-update"),
    path("workspaces/<uuid:workspace_id>/storyline/files/<int:file_id>/", StorylineFileDetailApi.as_view(), name="storyline-file-detail"),
]
```

> Note on URL style: the styleguide encourages distinct URLs per APIView. The contract doc (`docs/api.md`) uses `PUT /api/v1/workspaces/{uuid}/storyline` (same path as GET). Two ways to reconcile:
> - **(a)** keep `PUT` and `GET` on the same path, dispatched within a single `APIView.put(...)` / `get(...)` — but that violates "one class per op".
> - **(b)** distinct paths (`/storyline/` for GET, `/storyline/update/` for PUT). Cleaner per styleguide, but client must follow it.
> Pick **(b)** for v1 consistency with the boilerplate; update `docs/api.md` in Task 24.

- [ ] **Step 6:** Run — pass. Commit.

```bash
git add backend/apps/workspaces/ backend/tests/workspaces/
git commit -m "feat(workspaces): storyline detail/update/file-detail APIView classes"
```

---

### Task 16: Bump `last_active_at` on writes (already part of storyline_replace)

Already wired in Task 14 (`workspace.save(update_fields=["last_active_at", ...])` inside `storyline_replace`). Add a test to confirm.

**Files:** append to `backend/tests/workspaces/test_storyline_services.py`

- [ ] **Step 1:** Test:

```python
def test_storyline_replace_bumps_last_active(author_ws) -> None:
    ws, user = author_ws
    before = ws.last_active_at
    gateway = MagicMock()
    storyline_replace(
        workspace=ws, user=user,
        files=[{"diff_file_path": "a.py", "order_index": 0, "title": "", "intro_text": "x"}],
        if_match=ws.storyline.etag, gateway=gateway,
    )
    ws.refresh_from_db()
    assert ws.last_active_at > before
```

- [ ] **Step 2:** Run — pass (logic already in place). Commit.

```bash
git add backend/tests/workspaces/test_storyline_services.py
git commit -m "test(workspaces): assert last_active_at bumps on storyline_replace"
```

---

## Phase 5 · IntroComments

### Task 17: IntroComment model + invariant

**Files:**
- Modify: `backend/apps/workspaces/models.py` (add `IntroComment`)
- Create: `backend/tests/workspaces/test_intro_comment_model.py`

Fields per `docs/data-model.md`. DB constraint: a non-root comment (parent IS NOT NULL) cannot have resolution fields set.

- [ ] **Step 1:** Failing tests at `backend/tests/workspaces/test_intro_comment_model.py`:

```python
from typing import cast

import pytest

from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import IntroComment, StorylineFile, Workspace
from apps.workspaces.services import storyline_create


@pytest.fixture
def storyline_file(db) -> StorylineFile:
    user = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(created_by=user))
    storyline_create(workspace=ws, author=user)
    return StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="a.py", order_index=0)


@pytest.mark.django_db
def test_intro_comment_root(storyline_file) -> None:
    user = cast(User, UserFactory())
    c = IntroComment.objects.create(storyline_file=storyline_file, user=user, body="hi")
    assert c.parent_id is None
    assert c.resolved_at is None


@pytest.mark.django_db
def test_intro_comment_reply_depth1(storyline_file) -> None:
    user = cast(User, UserFactory())
    root = IntroComment.objects.create(storyline_file=storyline_file, user=user, body="root")
    reply = IntroComment.objects.create(storyline_file=storyline_file, user=user, body="reply", parent=root)
    assert reply.parent_id == root.pk
```

- [ ] **Step 2:** Run — fail.

- [ ] **Step 3:** Add to `backend/apps/workspaces/models.py`:

```python
class IntroComment(BaseModel):
    storyline_file = models.ForeignKey(StorylineFile, on_delete=models.CASCADE, related_name="intro_comments")
    user = models.ForeignKey(User, on_delete=models.PROTECT, related_name="intro_comments")
    body = models.TextField()
    parent = models.ForeignKey("self", on_delete=models.CASCADE, null=True, blank=True, related_name="replies")
    deleted_at = models.DateTimeField(null=True, blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolved_by = models.ForeignKey(User, on_delete=models.PROTECT, null=True, blank=True, related_name="intro_comments_resolved")

    class Meta:  # pyrefly: ignore[bad-override]
        db_table = "intro_comment"
        ordering = ["created_at"]
        constraints = [
            models.CheckConstraint(
                name="intro_comment_replies_have_no_resolution",
                check=(
                    models.Q(parent__isnull=True)
                    | (models.Q(resolved_at__isnull=True) & models.Q(resolved_by__isnull=True))
                ),
            ),
        ]
```

- [ ] **Step 4:** Migrate + tests pass + commit.

```bash
cd backend
uv run python manage.py makemigrations workspaces
uv run python manage.py migrate
uv run pytest tests/workspaces/test_intro_comment_model.py -v
git add backend/apps/workspaces/ backend/tests/workspaces/
git commit -m "feat(workspaces): IntroComment model + depth-1/resolution invariants"
```

---

### Task 18: IntroComment services + selectors + APIs

**Files:**
- Modify: `backend/apps/workspaces/services.py` (add intro_comment_create/update/soft_delete/resolve/unresolve)
- Modify: `backend/apps/workspaces/selectors.py` (add intro_comment_thread)
- Modify: `backend/apps/workspaces/apis.py` (add the six APIView classes)
- Create: `backend/apps/workspaces/serializers/{intro_comment_create_input.py,intro_comment_update_input.py,intro_comment_output.py}`
- Modify: `backend/apps/workspaces/urls.py`
- Create: `backend/tests/workspaces/{test_intro_comment_services.py,test_intro_comment_apis.py}`

Endpoints per `docs/api.md`:
- `GET /api/v1/workspaces/{uuid}/storyline/files/{file_id}/intro-comments/`
- `POST .../intro-comments/create/`
- `PATCH /api/v1/intro-comments/{id}/update/` (owner only)
- `POST /api/v1/intro-comments/{id}/delete/` (owner, soft) — POST chosen for non-idempotent state change, per styleguide
- `POST /api/v1/intro-comments/{id}/resolve/` (workspace creator, root only)
- `POST /api/v1/intro-comments/{id}/unresolve/` (workspace creator)

- [ ] **Step 1:** Failing tests covering each service with:
  - depth-1 enforcement (POST a reply to a reply → `ApplicationError(status=400)`)
  - workspace_frozen rejection on every write
  - owner-only edit/delete
  - workspace-creator-only resolve/unresolve
  - resolve only on root parents

- [ ] **Step 2:** Implement services:

```python
# in apps/workspaces/services.py

from django.utils import timezone

from apps.workspaces.models import IntroComment, StorylineFile


def _assert_not_frozen(workspace: Workspace, gateway) -> None:
    if workspace.pr_number is not None:
        pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
        if pr.get("state") == "closed":
            raise ApplicationError("workspace_frozen", status=409)


@transaction.atomic
def intro_comment_create(
    *,
    storyline_file: StorylineFile,
    user: User,
    body: str,
    parent: IntroComment | None = None,
    gateway,
) -> IntroComment:
    workspace = storyline_file.storyline.workspace
    _assert_not_frozen(workspace, gateway)
    if parent is not None and parent.parent_id is not None:
        raise ApplicationError("depth_exceeded", status=400)
    return IntroComment.objects.create(
        storyline_file=storyline_file, user=user, body=body, parent=parent,
    )


@transaction.atomic
def intro_comment_update(*, comment: IntroComment, user: User, body: str) -> IntroComment:
    if comment.user_id != user.pk:
        raise ApplicationError("not_owner", status=403)
    if comment.deleted_at is not None:
        raise ApplicationError("comment_deleted", status=409)
    comment.body = body
    comment.save(update_fields=["body", "updated_at"])
    return comment


@transaction.atomic
def intro_comment_soft_delete(*, comment: IntroComment, user: User) -> None:
    if comment.user_id != user.pk:
        raise ApplicationError("not_owner", status=403)
    comment.deleted_at = timezone.now()
    comment.save(update_fields=["deleted_at", "updated_at"])


@transaction.atomic
def intro_comment_resolve(*, comment: IntroComment, creator: User) -> IntroComment:
    workspace = comment.storyline_file.storyline.workspace
    if creator.pk != workspace.created_by_id:
        raise ApplicationError("not_creator", status=403)
    if comment.parent_id is not None:
        raise ApplicationError("only_roots_can_be_resolved", status=400)
    comment.resolved_at = timezone.now()
    comment.resolved_by = creator
    comment.save(update_fields=["resolved_at", "resolved_by", "updated_at"])
    return comment


@transaction.atomic
def intro_comment_unresolve(*, comment: IntroComment, creator: User) -> IntroComment:
    workspace = comment.storyline_file.storyline.workspace
    if creator.pk != workspace.created_by_id:
        raise ApplicationError("not_creator", status=403)
    comment.resolved_at = None
    comment.resolved_by = None
    comment.save(update_fields=["resolved_at", "resolved_by", "updated_at"])
    return comment
```

- [ ] **Step 3:** Implement selectors:

```python
# in apps/workspaces/selectors.py
from apps.workspaces.models import IntroComment, StorylineFile


def intro_comment_thread(
    *, storyline_file: StorylineFile, include_resolved: bool = False,
) -> list[dict]:
    qs = IntroComment.objects.select_related("user", "resolved_by").filter(
        storyline_file=storyline_file, deleted_at__isnull=True,
    )
    if not include_resolved:
        qs = qs.filter(resolved_at__isnull=True)
    qs = qs.order_by("created_at")
    by_id: dict[int, dict] = {}
    roots: list[dict] = []
    for c in qs:
        item = {
            "id": c.pk,
            "user": {"id": c.user_id, "github_login": c.user.github_login},
            "body": c.body,
            "parent_id": c.parent_id,
            "created_at": c.created_at,
            "resolved_at": c.resolved_at,
            "resolved_by": (
                {"id": c.resolved_by_id, "github_login": c.resolved_by.github_login}
                if c.resolved_by_id
                else None
            ),
            "replies": [],
        }
        by_id[c.pk] = item
        if c.parent_id is None:
            roots.append(item)
        else:
            parent = by_id.get(c.parent_id)
            if parent:
                parent["replies"].append(item)
    return roots
```

- [ ] **Step 4:** Implement six APIView classes + serializers + urls per the contract.

- [ ] **Step 5:** Run → pass. Commit.

```bash
git add backend/apps/workspaces/ backend/tests/workspaces/
git commit -m "feat(workspaces): intro-comment services/selectors/APIs (post/edit/delete/resolve)"
```

---

## Phase 6 · GithubGateway writes

### Task 19: Gateway write methods

**Files:**
- Modify: `backend/apps/github_proxy/gateway.py`
- Create: `backend/tests/github_proxy/test_gateway_writes.py`

Add methods:
- `post_issue_comment(o, r, n, *, body)`
- `post_review_comment(o, r, n, *, body, path, line, side, commit_id=None, in_reply_to=None)`
- `post_review(o, r, n, *, body, event, comments)`
- `patch_pr(o, r, n, **fields)`
- `merge_pr(o, r, n, *, method)`
- `create_pull(o, r, *, title, body, base, head, draft)`
- `request_reviewers(o, r, n, *, reviewers)`
- `add_labels(o, r, n, *, labels)`
- `edit_issue_comment(o, r, comment_id, body)`
- `delete_issue_comment(o, r, comment_id)`
- `edit_review_comment(o, r, comment_id, body)`
- `delete_review_comment(o, r, comment_id)`
- `react_to_comment(o, r, kind, comment_id, content)`

Implementation pattern is identical for each — `self._request(<verb>, <path>, json=<body>)`.

- [ ] **Step 1:** Failing respx tests, one happy path + one 4xx error per method.

- [ ] **Step 2:** Implement.

- [ ] **Step 3:** Commit.

```bash
git add backend/apps/github_proxy/ backend/tests/github_proxy/
git commit -m "feat(github_proxy): gateway write methods (comments/reviews/PR actions)"
```

---

## Phase 7 · Open-PR + Reopen-PR

### Task 20: open-pr orchestration + reopen-pr passthrough

**Files:**
- Modify: `backend/apps/workspaces/services.py` (add `pull_request_open`, `pull_request_reopen`)
- Modify: `backend/apps/workspaces/apis.py` (add `OpenPrApi`, `ReopenPrApi`)
- Create: `backend/apps/workspaces/serializers/{open_pr_input.py,open_pr_output.py}`
- Modify: `backend/apps/workspaces/urls.py`
- Create: `backend/tests/workspaces/{test_open_pr_service.py,test_open_pr_api.py}`

Per `docs/api.md` § `/open-pr`:
- creator-only (raise `ApplicationError(status=403)` else)
- 409 `pr_already_open` if `pr_number IS NOT NULL` AND github PR is open
- atomic: `gateway.create_pull` → set `pr_number` + `pr_opened_at` → optional `request_reviewers` + `add_labels` (best-effort → warnings)
- if `pr_number` previously pointed at a closed/merged PR, OVERWRITE on success
- response: `{ workspace: ..., pr: ..., warnings: [...] }`

`/reopen-pr`: thin passthrough `gateway.patch_pr(state="open")`. Creator-only.

- [ ] **Step 1:** Failing tests (happy path, creator-only, pr_already_open, github failure rolls back transaction, warnings on reviewer/label fail).

- [ ] **Step 2:** Implement.

- [ ] **Step 3:** Commit.

```bash
git add backend/apps/workspaces/ backend/tests/workspaces/
git commit -m "feat(workspaces): open-pr orchestration + reopen-pr passthrough"
```

---

## Phase 8 · PR-anchored read proxy

### Task 21: PR-anchored read endpoints (no workspace required)

**Files:**
- Create: `backend/apps/github_proxy/apis.py` (PR read APIView classes)
- Modify: `backend/apps/github_proxy/urls.py`
- Create: `backend/tests/github_proxy/test_pull_request_read_apis.py`

Per `docs/api.md` § PR-anchored:
- `GET /api/v1/repos/{o}/{r}/pulls/{n}/` → `PullRequestDetailApi`
- `GET .../files/` → `PullRequestFilesApi`
- `GET .../files/<path:path>/diff/` → `PullRequestFileDiffApi`
- `GET .../files/<path:path>/comments/` → `PullRequestFileCommentsApi`
- `GET .../comments/` → `PullRequestCommentsApi` (combined issue + review)
- `GET .../reviews/` → `PullRequestReviewsApi`
- `GET .../checks/` → `PullRequestChecksApi` (combined check_runs + workflow_runs from head_sha via `get_pr` + both list calls)

All use admin PAT; pure passthrough except where filtering is needed.

- [ ] **Step 1:** Failing tests per endpoint (mocked gateway).

- [ ] **Step 2:** Implement.

- [ ] **Step 3:** Commit.

```bash
git add backend/apps/github_proxy/ backend/tests/github_proxy/
git commit -m "feat(github_proxy): PR-anchored read endpoints"
```

---

## Phase 9 · PR-anchored write proxy

### Task 22: PR-anchored writes

**Files:**
- Modify: `backend/apps/github_proxy/apis.py` (add `PullRequestCommentCreateApi`, `PullRequestReviewCreateApi`, `PullRequestActionApi`)
- Modify: `backend/apps/github_proxy/urls.py`
- Create: `backend/tests/github_proxy/test_pull_request_write_apis.py`

Per `docs/api.md`:
- `POST /api/v1/repos/{o}/{r}/pulls/{n}/comments/create/` body `{kind: "issue" | "review", ...}` → routes to gateway `post_issue_comment` or `post_review_comment`
- `POST .../review/create/` → batched `post_review`
- `POST .../actions/<close|reopen|toggle-draft|merge>/` → corresponding gateway calls

- [ ] **Step 1:** Failing tests.

- [ ] **Step 2:** Implement (use gateway write methods from T19).

- [ ] **Step 3:** Commit.

```bash
git add backend/apps/github_proxy/ backend/tests/github_proxy/
git commit -m "feat(github_proxy): PR-anchored write-through endpoints + PR actions"
```

---

## Phase 10 · Github search

### Task 23: `/api/v1/github/prs?role=` cross-filtered against workspaces

**Files:**
- Add: `GithubPullsSearchApi` in `backend/apps/github_proxy/apis.py`
- Modify: `backend/apps/github_proxy/urls.py`
- Create: `backend/tests/github_proxy/test_github_search.py`

Logic:
- Build query: `is:pr is:open author:{login}` or `... review-requested:{login}` per `role` query param
- Call `gateway.search_issues(q)`
- Filter out items whose `(repo, number)` matches an existing Workspace (use a selector helper, e.g. `workspaces_set_for_prs(items: list[dict]) -> set[tuple[str, int]]`)
- Return `{ items: [...] }`

- [ ] **Step 1:** Failing tests (each role; filter excludes existing workspace).

- [ ] **Step 2:** Implement.

- [ ] **Step 3:** Commit.

```bash
git add backend/ backend/tests/
git commit -m "feat(github_proxy): github search endpoint w/ workspace cross-filter"
```

---

## Phase 11 · Polish

### Task 24: Smoke + contract doc reconciliation + coverage + tag

**Files:**
- Modify: `docs/api.md` to match the per-verb URL style (`/create/`, `/update/`, etc.) and the storyline split (`/storyline/` for GET, `/storyline/update/` for PUT).
- Verify the `drf-spectacular` OpenAPI schema renders all endpoints (`just generate-schema`).

- [ ] **Step 1:** Full verify pipeline:

```bash
cd backend
uv run pre-commit run --all-files
just typecheck
just test --cov=apps --cov-report=term-missing
```

- [ ] **Step 2:** Manual smoke (real bootstrap):

```bash
cd backend && just bootstrap
just dev &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/health/   # expect 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/api/v1/auth/me/   # expect 401
kill %1
```

- [ ] **Step 3:** Generate OpenAPI schema + ER diagram for documentation handoff:

```bash
cd backend && just generate
git add backend/generated/
git commit -m "docs(backend): regenerate OpenAPI schema + ER diagram"
```

- [ ] **Step 4:** Reconcile `docs/api.md` with the actual implemented URL style. Specifically:
  - Add `/create/`, `/update/`, `/delete/`, `/archive/` suffixes per the boilerplate convention.
  - Split storyline GET vs PUT into two paths.
  - Confirm all other endpoints match what was implemented.
- [ ] **Step 5:** Tag `v0.1.0-poc-backend`.

```bash
git tag v0.1.0-poc-backend
```

---

## Coverage map (spec v3 sections → tasks)

| Spec v3 section | Tasks |
|---|---|
| §1 Architecture (3 apps + boilerplate) | T1–T2 |
| §2 Tech stack (deps + env) | T1 |
| §3.1 github_oauth | T5 |
| §3.2 session services/selectors | T6, T7 |
| §3.3 workspaces services/selectors | T11, T12, T14, T18, T20 |
| §3.4 gateway | T9, T19 |
| §3.5 API layer convention | T7, T11, T15, T18, T20, T21–T23 |
| §4 Computed-state semantics | T14 (stale), T20 (frozen) |
| §5 Stale-step detection | T14 |
| §6 Persistence (BaseModel + Postgres) | T1, T3, T4, T10, T12, T13, T17 |
| §7 Testing approach (tests/ at root + factories) | All tasks |
| §8 Tech debt parked | informational |
| §9 Open questions | T11 (URL style), T15 (412 vs 428), T24 (doc reconciliation) |

Contract docs (`docs/data-model.md`, `docs/api.md`) are authoritative on every endpoint shape. The plan flags two paths where boilerplate conventions diverge from the current contract (per-verb URLs, separate routes for storyline GET vs PUT) and resolves them by updating `docs/api.md` in T24.

---

## Done criteria

After T24, a developer with:
- a github admin PAT (with `repo` + `read:user` scopes),
- a github OAuth app client_id / client_secret with device flow enabled,

can:
- run `just bootstrap && just dev` and the backend boots,
- complete the device-flow login from any client, receive a Bearer token,
- create a workspace + write a storyline (etag-protected),
- post threaded intro comments + resolve threads,
- open a github PR atomically via `/open-pr/`,
- post comments + submit reviews on PRs via the PR-anchored surface,
- list their own workspaces and find github PRs not yet in Stage.

All of `docs/api.md` (post-T24 reconciliation) is served. All of `docs/data-model.md` is persisted.

UI is out of scope; the contract is delivered to the Client developer for them to consume.
