# Local-Review Backend v1 Implementation Plan (v3, consolidated)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Django REST backend per:

- **Spec v3:** [`docs/superpowers/specs/2026-05-23-local-review-backend-design-v3.md`](../specs/2026-05-23-local-review-backend-design-v3.md)
- **Contract (canonical):** [`docs/data-model.md`](../../data-model.md) + [`docs/api.md`](../../api.md)
- **Decisions log:** `docs/decisions/2026-05-23-foundational-decisions.md` (D1–D32)

**Supersedes:** v1 + v2 plans in this directory.

**Architecture:** Single Django process. Three apps: `apps.identity`, `apps.workspaces`, `apps.github_proxy`. Six tables: `User`, `Session`, `Workspace`, `Storyline`, `StorylineFile`, `IntroComment`. No worker, no webhooks, no mirror, no cache in v1.

**Tech Stack:** Python 3.12 (uv), Django 5.x, DRF, PyGithub + httpx, pytest + pytest-django + respx.

---

## Phase boundaries

| Phase | Tasks | Working outcome |
|---|---|---|
| 0 · Scaffold | T1–T4 | Django boots, tests run |
| 1 · Identity + device-flow auth | T5–T8 | Login + `/me` + Bearer auth |
| 2 · GithubGateway core | T9 | PR fetch + file list + error class hierarchy |
| 3 · Workspace CRUD | T10–T12 | Create / list / lookup / get / patch |
| 4 · Storyline | T13–T16 | Create / read with stale flags / write with etag / one-step focused read |
| 5 · IntroComments | T17–T18 | Threaded post / edit / delete / resolve, depth-1 invariant |
| 6 · GithubGateway writes | T19 | Comment / review / PR-state methods |
| 7 · Open-PR + Reopen-PR | T20 | Atomic orchestration; pr_number set; warnings array |
| 8 · PR-anchored read proxy | T21 | `/api/repos/.../pulls/{n}/*` GETs |
| 9 · PR-anchored write proxy | T22 | comment / review write-through + PR actions |
| 10 · Github search | T23 | `/api/github/prs?role=` |
| 11 · Polish | T24 | Error envelope + smoke test |

End of each phase = green tests + working binary. Stop at any phase boundary if needed.

---

## Phase 0 · Scaffold

### Task 1: Init uv + Django + git

**Files:** `pyproject.toml`, `.gitignore`, `.env.example`, `.python-version`, `backend/justfile`

- [ ] **Step 1:** init the backend project under `backend/`

```bash
cd backend && uv init --name stage-backend --no-readme
uv python pin 3.12
uv add "django>=5.0,<5.2" "djangorestframework>=3.15" "PyGithub>=2.3" "httpx>=0.27" python-dotenv
uv add --dev pytest pytest-django pytest-cov respx freezegun
```

- [ ] **Step 2:** write `backend/.env.example`

```
DJANGO_SETTINGS_MODULE=stage_backend.settings.dev
DJANGO_SECRET_KEY=change-me
DJANGO_DEBUG=true

DATABASE_URL=postgres://user:pass@localhost:5432/stage  # prod only

GITHUB_ADMIN_PAT=ghp_REPLACE_ME
GITHUB_OAUTH_CLIENT_ID=Iv1.REPLACE_ME
GITHUB_OAUTH_CLIENT_SECRET=REPLACE_ME
```

- [ ] **Step 3:** add to root `.gitignore`

```
backend/.venv/
backend/__pycache__/
backend/.pytest_cache/
backend/.coverage
backend/db.sqlite3
backend/.env
```

- [ ] **Step 4:** commit

```bash
git add backend/pyproject.toml backend/uv.lock backend/.env.example backend/.python-version .gitignore
git commit -m "chore(backend): init uv project + core deps"
```

---

### Task 2: Django project skeleton with split settings

**Files:**
- `backend/manage.py`
- `backend/stage_backend/__init__.py`
- `backend/stage_backend/settings/{__init__.py,base.py,dev.py,prod.py}`
- `backend/stage_backend/{urls.py,wsgi.py,asgi.py}`

- [ ] **Step 1:** `backend/manage.py`

```python
#!/usr/bin/env python
import os, sys


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "stage_backend.settings.dev")
    from django.core.management import execute_from_command_line
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2:** `backend/stage_backend/settings/base.py`

```python
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent.parent

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "insecure-dev")
DEBUG = False
ALLOWED_HOSTS: list[str] = []

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.staticfiles",
    "rest_framework",
    "apps.identity",
    "apps.workspaces",
    "apps.github_proxy",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "apps.identity.middleware.ErrorEnvelopeMiddleware",
]

ROOT_URLCONF = "stage_backend.urls"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
TIME_ZONE = "UTC"
LANGUAGE_CODE = "en-us"
STATIC_URL = "static/"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "apps.identity.auth.BearerSessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
}

TEMPLATES = [{"BACKEND": "django.template.backends.django.DjangoTemplates", "DIRS": [], "APP_DIRS": True, "OPTIONS": {}}]

GITHUB_ADMIN_PAT = os.environ["GITHUB_ADMIN_PAT"]
GITHUB_OAUTH_CLIENT_ID = os.environ["GITHUB_OAUTH_CLIENT_ID"]
GITHUB_OAUTH_CLIENT_SECRET = os.environ["GITHUB_OAUTH_CLIENT_SECRET"]
```

- [ ] **Step 3:** `backend/stage_backend/settings/dev.py`

```python
from .base import *  # noqa

DEBUG = True
ALLOWED_HOSTS = ["localhost", "127.0.0.1"]
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}
```

- [ ] **Step 4:** `backend/stage_backend/settings/prod.py`

```python
import os
from urllib.parse import urlparse
from .base import *  # noqa

ALLOWED_HOSTS = os.environ["DJANGO_ALLOWED_HOSTS"].split(",")
_db = urlparse(os.environ["DATABASE_URL"])
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": _db.path[1:],
        "USER": _db.username,
        "PASSWORD": _db.password,
        "HOST": _db.hostname,
        "PORT": _db.port or 5432,
    }
}
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
```

- [ ] **Step 5:** `backend/stage_backend/urls.py`

```python
from django.urls import include, path

urlpatterns = [
    path("api/auth/", include("apps.identity.urls")),
    path("api/", include("apps.workspaces.urls")),
    path("api/", include("apps.github_proxy.urls")),
]
```

- [ ] **Step 6:** create empty `__init__.py` in `stage_backend/` and `stage_backend/settings/`; minimal `wsgi.py` and `asgi.py` from Django template.

- [ ] **Step 7:** commit

```bash
git add backend/manage.py backend/stage_backend/
git commit -m "chore(backend): Django project skeleton with split settings"
```

---

### Task 3: pytest configuration + initial conftest

**Files:** `backend/pytest.ini`, `backend/conftest.py`

- [ ] **Step 1:** `backend/pytest.ini`

```ini
[pytest]
DJANGO_SETTINGS_MODULE = stage_backend.settings.dev
python_files = tests.py test_*.py
addopts = -ra --strict-markers --tb=short
testpaths = apps
```

- [ ] **Step 2:** `backend/conftest.py`

```python
import os

import pytest

os.environ.setdefault("GITHUB_ADMIN_PAT", "test-pat")
os.environ.setdefault("GITHUB_OAUTH_CLIENT_ID", "test-cid")
os.environ.setdefault("GITHUB_OAUTH_CLIENT_SECRET", "test-secret")


@pytest.fixture
def api_client():
    from rest_framework.test import APIClient
    return APIClient()
```

- [ ] **Step 3:** `cd backend && uv run pytest` → "0 tests collected" cleanly.

- [ ] **Step 4:** commit

```bash
git add backend/pytest.ini backend/conftest.py
git commit -m "chore(backend): pytest configuration"
```

---

### Task 4: Empty apps + smoke runserver

**Files:** `backend/apps/{__init__.py,identity/{__init__.py,apps.py,urls.py},workspaces/{...},github_proxy/{...}}`

- [ ] **Step 1:** Create `backend/apps/__init__.py` (empty), and for each of `identity`, `workspaces`, `github_proxy`: `__init__.py`, `apps.py` (standard `AppConfig`), `urls.py` (empty `urlpatterns = []`).

- [ ] **Step 2:** Smoke

```bash
cd backend && uv run python manage.py migrate
uv run python manage.py runserver 8000 &
sleep 2 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/api/auth/me
kill %1
```

Expected: `404` (no routes yet). No traceback.

- [ ] **Step 3:** commit

```bash
git add backend/apps/
git commit -m "chore(backend): scaffold identity, workspaces, github_proxy apps"
```

---

## Phase 1 · Identity + device-flow auth

### Task 5: User + Session models

**Files:**
- `backend/apps/identity/models.py`
- `backend/apps/identity/tests/__init__.py`
- `backend/apps/identity/tests/test_models.py`

- [ ] **Step 1:** failing test

```python
import pytest

from apps.identity.models import Session, User


@pytest.mark.django_db
def test_user_unique_github_login():
    User.objects.create(github_login="alice", github_user_id=1)
    with pytest.raises(Exception):
        User.objects.create(github_login="alice", github_user_id=2)


@pytest.mark.django_db
def test_user_unique_github_user_id():
    User.objects.create(github_login="alice", github_user_id=1)
    with pytest.raises(Exception):
        User.objects.create(github_login="bob", github_user_id=1)


@pytest.mark.django_db
def test_session_links_to_user():
    u = User.objects.create(github_login="alice", github_user_id=1)
    s = Session.objects.create(user=u, token_hash="abc")
    assert s.id is not None
    assert s.revoked_at is None
```

- [ ] **Step 2:** run → fail.

- [ ] **Step 3:** models

```python
from django.db import models


class User(models.Model):
    github_login = models.CharField(max_length=39, unique=True)
    github_user_id = models.BigIntegerField(unique=True)
    display_name = models.CharField(max_length=255, blank=True, default="")
    avatar_url = models.URLField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    last_login_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "identity_user"


class Session(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="sessions")
    token_hash = models.CharField(max_length=64, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(auto_now=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "identity_session"
```

- [ ] **Step 4:** migrate + tests pass.

```bash
cd backend && uv run python manage.py makemigrations identity && uv run python manage.py migrate
uv run pytest apps/identity/tests/test_models.py -v
```

- [ ] **Step 5:** commit `feat(identity): User and Session models`.

---

### Task 6: Github device-flow client (`github_oauth.py`)

**Files:**
- `backend/apps/identity/github_oauth.py`
- `backend/apps/identity/tests/test_github_oauth.py`

- [ ] **Step 1:** failing tests

```python
import respx
from httpx import Response

from apps.identity.github_oauth import device_start, device_poll, fetch_user, OAuthError


@respx.mock
def test_device_start_returns_codes():
    respx.post("https://github.com/login/device/code").mock(
        return_value=Response(200, json={
            "device_code": "dev_abc", "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "interval": 5, "expires_in": 900,
        })
    )
    out = device_start()
    assert out["user_code"] == "ABCD-1234"


@respx.mock
def test_device_poll_returns_none_when_pending():
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=Response(200, json={"error": "authorization_pending"})
    )
    assert device_poll("dev_abc") is None


@respx.mock
def test_device_poll_returns_token_when_complete():
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=Response(200, json={"access_token": "gho_x", "token_type": "bearer"})
    )
    out = device_poll("dev_abc")
    assert out["access_token"] == "gho_x"


@respx.mock
def test_device_poll_raises_on_terminal_error():
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=Response(200, json={"error": "expired_token"})
    )
    import pytest
    with pytest.raises(OAuthError):
        device_poll("dev_abc")


@respx.mock
def test_fetch_user():
    respx.get("https://api.github.com/user").mock(
        return_value=Response(200, json={"login": "octocat", "id": 583231, "name": "Octo", "avatar_url": "https://x"})
    )
    out = fetch_user("gho_x")
    assert out["login"] == "octocat"
```

- [ ] **Step 2:** run → fail.

- [ ] **Step 3:** `apps/identity/github_oauth.py`

```python
import httpx
from django.conf import settings


class OAuthError(Exception):
    pass


_DEVICE_CODE_URL = "https://github.com/login/device/code"
_TOKEN_URL = "https://github.com/login/oauth/access_token"
_USER_URL = "https://api.github.com/user"

# github uses these error codes on the device-flow access_token poll:
_TERMINAL_ERRORS = {"expired_token", "access_denied", "incorrect_device_code", "unsupported_grant_type"}
_PENDING_ERRORS = {"authorization_pending", "slow_down"}


def device_start() -> dict:
    r = httpx.post(
        _DEVICE_CODE_URL,
        data={"client_id": settings.GITHUB_OAUTH_CLIENT_ID, "scope": "read:user"},
        headers={"Accept": "application/json"},
        timeout=10.0,
    )
    r.raise_for_status()
    return r.json()


def device_poll(device_code: str) -> dict | None:
    r = httpx.post(
        _TOKEN_URL,
        data={
            "client_id": settings.GITHUB_OAUTH_CLIENT_ID,
            "client_secret": settings.GITHUB_OAUTH_CLIENT_SECRET,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        },
        headers={"Accept": "application/json"},
        timeout=10.0,
    )
    r.raise_for_status()
    body = r.json()
    if "access_token" in body:
        return body
    err = body.get("error")
    if err in _PENDING_ERRORS:
        return None
    raise OAuthError(err or "unknown")


def fetch_user(access_token: str) -> dict:
    r = httpx.get(
        _USER_URL,
        headers={"Authorization": f"token {access_token}", "Accept": "application/vnd.github+json"},
        timeout=10.0,
    )
    r.raise_for_status()
    return r.json()
```

- [ ] **Step 4:** run → pass.

- [ ] **Step 5:** commit `feat(identity): github device-flow client`.

---

### Task 7: Session service + Bearer auth DRF class

**Files:**
- `backend/apps/identity/session_service.py`
- `backend/apps/identity/auth.py`
- `backend/apps/identity/tests/test_session_service.py`

- [ ] **Step 1:** failing tests for the service

```python
import pytest

from apps.identity.models import Session, User
from apps.identity.session_service import find, issue, revoke


@pytest.mark.django_db
def test_issue_returns_token_and_stores_hash_only():
    u = User.objects.create(github_login="alice", github_user_id=1)
    token, sess = issue(u)
    assert isinstance(token, str) and len(token) > 20
    sess.refresh_from_db()
    assert sess.token_hash and sess.token_hash != token


@pytest.mark.django_db
def test_find_returns_user_for_valid_token():
    u = User.objects.create(github_login="alice", github_user_id=1)
    token, _ = issue(u)
    assert find(token) == u


@pytest.mark.django_db
def test_find_returns_none_for_revoked():
    u = User.objects.create(github_login="alice", github_user_id=1)
    token, sess = issue(u)
    revoke(sess)
    assert find(token) is None


@pytest.mark.django_db
def test_find_returns_none_for_unknown():
    assert find("nope") is None
```

- [ ] **Step 2:** run → fail.

- [ ] **Step 3:** service

```python
import hashlib
import secrets

from django.utils import timezone

from apps.identity.models import Session, User


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def issue(user: User) -> tuple[str, Session]:
    raw = "stg_" + secrets.token_urlsafe(32)
    sess = Session.objects.create(user=user, token_hash=_hash(raw))
    return raw, sess


def find(raw_token: str) -> User | None:
    try:
        sess = Session.objects.select_related("user").get(
            token_hash=_hash(raw_token), revoked_at__isnull=True,
        )
    except Session.DoesNotExist:
        return None
    Session.objects.filter(pk=sess.pk).update(last_used_at=timezone.now())
    return sess.user


def revoke(session: Session) -> None:
    session.revoked_at = timezone.now()
    session.save(update_fields=["revoked_at"])
```

- [ ] **Step 4:** DRF auth class

```python
# apps/identity/auth.py
from rest_framework import authentication, exceptions

from apps.identity.session_service import find


class BearerSessionAuthentication(authentication.BaseAuthentication):
    keyword = "Bearer"

    def authenticate(self, request):
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not header.startswith(self.keyword + " "):
            return None
        raw = header.split(" ", 1)[1].strip()
        user = find(raw)
        if not user:
            raise exceptions.AuthenticationFailed("invalid or revoked token")
        setattr(user, "is_authenticated", True)
        return (user, raw)
```

- [ ] **Step 5:** run → pass.

- [ ] **Step 6:** commit `feat(identity): session service + Bearer auth class`.

---

### Task 8: Auth endpoints (device-start / device-poll / me / logout)

**Files:**
- `backend/apps/identity/views.py`
- `backend/apps/identity/urls.py`
- `backend/apps/identity/middleware.py` (error envelope)
- `backend/apps/identity/tests/test_views.py`

- [ ] **Step 1:** failing tests

```python
from unittest.mock import patch

import pytest

from apps.identity.models import User


@pytest.mark.django_db
def test_device_start_proxies_github(api_client):
    with patch("apps.identity.views.device_start", return_value={"user_code": "ABCD-1234"}):
        resp = api_client.post("/api/auth/device/start", {})
    assert resp.status_code == 200
    assert resp.json()["user_code"] == "ABCD-1234"


@pytest.mark.django_db
def test_device_poll_pending(api_client):
    with patch("apps.identity.views.device_poll", return_value=None):
        resp = api_client.post("/api/auth/device/poll", {"device_code": "x"}, format="json")
    assert resp.status_code == 200
    assert resp.json()["status"] == "pending"


@pytest.mark.django_db
def test_device_poll_success_creates_user(api_client):
    with patch("apps.identity.views.device_poll", return_value={"access_token": "gho_x"}), \
         patch("apps.identity.views.fetch_user", return_value={
             "login": "octocat", "id": 583231, "name": "Octo", "avatar_url": "https://x",
         }):
        resp = api_client.post("/api/auth/device/poll", {"device_code": "x"}, format="json")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["session_token"].startswith("stg_")
    assert User.objects.filter(github_user_id=583231).exists()


@pytest.mark.django_db
def test_me_requires_auth(api_client):
    resp = api_client.get("/api/auth/me")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_me_returns_user(api_client):
    from apps.identity.session_service import issue
    u = User.objects.create(github_login="alice", github_user_id=1)
    token, _ = issue(u)
    resp = api_client.get("/api/auth/me", HTTP_AUTHORIZATION=f"Bearer {token}")
    assert resp.status_code == 200
    assert resp.json()["github_login"] == "alice"


@pytest.mark.django_db
def test_logout_revokes(api_client):
    from apps.identity.session_service import issue
    u = User.objects.create(github_login="alice", github_user_id=1)
    token, _ = issue(u)
    resp = api_client.post("/api/auth/logout", HTTP_AUTHORIZATION=f"Bearer {token}")
    assert resp.status_code == 204
    me = api_client.get("/api/auth/me", HTTP_AUTHORIZATION=f"Bearer {token}")
    assert me.status_code == 401
```

- [ ] **Step 2:** run → fail.

- [ ] **Step 3:** `apps/identity/views.py`

```python
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from apps.identity.github_oauth import device_poll, device_start, fetch_user, OAuthError
from apps.identity.models import User
from apps.identity.session_service import find, issue, revoke
from apps.identity.models import Session


@api_view(["POST"])
@permission_classes([AllowAny])
def device_start_view(request):
    out = device_start()
    return Response(out)


@api_view(["POST"])
@permission_classes([AllowAny])
def device_poll_view(request):
    code = request.data.get("device_code")
    if not code:
        return Response({"error": {"code": "validation_error", "message": "device_code required"}}, status=400)
    try:
        result = device_poll(code)
    except OAuthError as e:
        return Response({"error": {"code": "oauth_error", "message": str(e)}}, status=400)
    if result is None:
        return Response({"status": "pending"})

    gh_user = fetch_user(result["access_token"])
    user, _ = User.objects.update_or_create(
        github_user_id=gh_user["id"],
        defaults={
            "github_login": gh_user["login"],
            "display_name": gh_user.get("name") or "",
            "avatar_url": gh_user.get("avatar_url") or "",
            "last_login_at": timezone.now(),
        },
    )
    raw, _sess = issue(user)
    return Response({
        "status": "ok",
        "session_token": raw,
        "user": _user_payload(user),
    })


def _user_payload(u: User) -> dict:
    return {
        "id": u.id,
        "github_login": u.github_login,
        "github_user_id": u.github_user_id,
        "display_name": u.display_name,
        "avatar_url": u.avatar_url,
    }


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def me_view(request):
    return Response(_user_payload(request.user))


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def logout_view(request):
    # auth class set request.auth = raw token
    from apps.identity.session_service import _hash  # private but acceptable here
    sess = Session.objects.filter(
        token_hash=_hash(request.auth), revoked_at__isnull=True,
    ).first()
    if sess:
        revoke(sess)
    return Response(status=204)
```

- [ ] **Step 4:** `apps/identity/urls.py`

```python
from django.urls import path
from apps.identity import views

urlpatterns = [
    path("device/start", views.device_start_view),
    path("device/poll", views.device_poll_view),
    path("me", views.me_view),
    path("logout", views.logout_view),
]
```

- [ ] **Step 5:** `apps/identity/middleware.py`

```python
import logging

from django.http import JsonResponse

logger = logging.getLogger(__name__)


class ErrorEnvelopeMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        return self.get_response(request)

    def process_exception(self, request, exc):
        if not request.path.startswith("/api/"):
            return None
        logger.exception("unhandled api exception")
        return JsonResponse(
            {"error": {"code": "internal_error", "message": str(exc)}}, status=500,
        )
```

- [ ] **Step 6:** run all identity tests → pass.

- [ ] **Step 7:** commit `feat(identity): device-flow + me + logout endpoints`.

---

## Phase 2 · GithubGateway core

### Task 9: GithubGateway scaffold (read methods + error hierarchy)

**Files:**
- `backend/apps/github_proxy/gateway.py`
- `backend/apps/github_proxy/exceptions.py`
- `backend/apps/github_proxy/tests/__init__.py`
- `backend/apps/github_proxy/tests/test_gateway_reads.py`

- [ ] **Step 1:** failing tests

```python
import pytest
import respx
from httpx import Response

from apps.github_proxy.exceptions import GithubError, GithubNotFound
from apps.github_proxy.gateway import GithubGateway


@respx.mock
def test_get_pr():
    respx.get("https://api.github.com/repos/o/r/pulls/1").mock(
        return_value=Response(200, json={"number": 1, "user": {"login": "alice"}})
    )
    g = GithubGateway(token="t")
    assert g.get_pr("o", "r", 1)["number"] == 1


@respx.mock
def test_get_pr_not_found_raises():
    respx.get("https://api.github.com/repos/o/r/pulls/99").mock(
        return_value=Response(404, json={"message": "Not Found"})
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubNotFound):
        g.get_pr("o", "r", 99)


@respx.mock
def test_list_pr_files():
    respx.get("https://api.github.com/repos/o/r/pulls/1/files").mock(
        return_value=Response(200, json=[{"filename": "a.py"}, {"filename": "b.py"}])
    )
    g = GithubGateway(token="t")
    assert len(g.list_pr_files("o", "r", 1)) == 2


@respx.mock
def test_other_4xx_raises_generic():
    respx.get("https://api.github.com/repos/o/r/pulls/1").mock(
        return_value=Response(422, json={"message": "Unprocessable"})
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.get_pr("o", "r", 1)
    assert exc.value.status_code == 422


@respx.mock
def test_list_check_runs():
    respx.get("https://api.github.com/repos/o/r/commits/abc/check-runs").mock(
        return_value=Response(200, json={"check_runs": []})
    )
    g = GithubGateway(token="t")
    assert g.list_check_runs("o", "r", "abc") == {"check_runs": []}


@respx.mock
def test_search_issues():
    respx.get("https://api.github.com/search/issues").mock(
        return_value=Response(200, json={"items": []})
    )
    g = GithubGateway(token="t")
    assert g.search_issues("q") == {"items": []}
```

- [ ] **Step 2:** run → fail.

- [ ] **Step 3:** exceptions

```python
class GithubError(Exception):
    def __init__(self, status_code: int, message: str, body: dict | None = None):
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

- [ ] **Step 4:** gateway

```python
from typing import Any
import httpx

from apps.github_proxy.exceptions import (
    GithubConflict, GithubError, GithubForbidden, GithubNotFound,
)

_API = "https://api.github.com"


class GithubGateway:
    def __init__(self, token: str):
        self._client = httpx.Client(
            base_url=_API,
            headers={
                "Authorization": f"token {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=15.0,
        )

    def close(self):
        self._client.close()

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        resp = self._client.request(method, path, **kwargs)
        if resp.status_code < 400:
            return resp
        try:
            body = resp.json()
            msg = body.get("message", resp.text)
        except Exception:
            body, msg = {}, resp.text
        cls = {404: GithubNotFound, 403: GithubForbidden, 409: GithubConflict, 412: GithubConflict}.get(resp.status_code, GithubError)
        raise cls(resp.status_code, msg, body)

    def get_pr(self, o, r, n) -> dict[str, Any]:
        return self._request("GET", f"/repos/{o}/{r}/pulls/{n}").json()

    def list_pr_files(self, o, r, n) -> list[dict[str, Any]]:
        return self._request("GET", f"/repos/{o}/{r}/pulls/{n}/files").json()

    def list_issue_comments(self, o, r, n) -> list[dict]:
        return self._request("GET", f"/repos/{o}/{r}/issues/{n}/comments").json()

    def list_review_comments(self, o, r, n) -> list[dict]:
        return self._request("GET", f"/repos/{o}/{r}/pulls/{n}/comments").json()

    def list_reviews(self, o, r, n) -> list[dict]:
        return self._request("GET", f"/repos/{o}/{r}/pulls/{n}/reviews").json()

    def list_check_runs(self, o, r, head_sha) -> dict:
        return self._request("GET", f"/repos/{o}/{r}/commits/{head_sha}/check-runs").json()

    def list_workflow_runs(self, o, r, head_sha) -> dict:
        return self._request("GET", f"/repos/{o}/{r}/actions/runs", params={"head_sha": head_sha}).json()

    def search_issues(self, query: str) -> dict:
        return self._request("GET", "/search/issues", params={"q": query}).json()
```

- [ ] **Step 5:** run → pass.

- [ ] **Step 6:** commit `feat(github_proxy): GithubGateway read methods + error hierarchy`.

---

## Phase 3 · Workspace CRUD

### Task 10: Workspace model (UUID PK + uniqueness)

**Files:** `backend/apps/workspaces/models.py`, `backend/apps/workspaces/tests/{__init__.py,test_models.py}`

- [ ] **Step 1:** failing tests

```python
import uuid
import pytest

from apps.identity.models import User
from apps.workspaces.models import Workspace


@pytest.mark.django_db
def test_workspace_uuid_primary_key():
    u = User.objects.create(github_login="a", github_user_id=1)
    ws = Workspace.objects.create(
        repo_owner="o", repo_name="r", head_ref="feat/x", base_ref="main", created_by=u,
    )
    assert isinstance(ws.id, uuid.UUID)
    assert ws.pr_number is None


@pytest.mark.django_db
def test_workspace_unique_repo_head_ref():
    u = User.objects.create(github_login="a", github_user_id=1)
    Workspace.objects.create(repo_owner="o", repo_name="r", head_ref="feat/x", base_ref="main", created_by=u)
    with pytest.raises(Exception):
        Workspace.objects.create(repo_owner="o", repo_name="r", head_ref="feat/x", base_ref="main", created_by=u)
```

- [ ] **Step 2:** run → fail.

- [ ] **Step 3:** model

```python
import uuid
from django.db import models

from apps.identity.models import User


class Workspace(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    repo_owner = models.CharField(max_length=255)
    repo_name = models.CharField(max_length=255)
    head_ref = models.CharField(max_length=255)
    base_ref = models.CharField(max_length=255)
    pr_number = models.IntegerField(null=True, blank=True)
    pr_opened_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="created_workspaces")
    created_at = models.DateTimeField(auto_now_add=True)
    last_active_at = models.DateTimeField(auto_now=True)

    class Meta:
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

- [ ] **Step 4:** migrate + tests pass.

- [ ] **Step 5:** commit `feat(workspaces): Workspace UUID model + uniqueness`.

---

### Task 11: Workspace endpoints (create / list / lookup / get / patch / archive-NA)

**Files:** `backend/apps/workspaces/{views.py,urls.py,serializers.py}`, `backend/apps/workspaces/tests/test_views_basic.py`

- [ ] **Step 1:** failing tests

```python
from unittest.mock import patch

import pytest

from apps.identity.models import User
from apps.identity.session_service import issue
from apps.workspaces.models import Workspace


@pytest.fixture
def authed(api_client, db):
    u = User.objects.create(github_login="alice", github_user_id=1)
    token, _ = issue(u)
    api_client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return api_client, u


@pytest.mark.django_db
def test_create_workspace(authed):
    client, u = authed
    resp = client.post(
        "/api/workspaces",
        {"repo_owner": "o", "repo_name": "r", "head_ref": "feat/x", "base_ref": "main"},
        format="json",
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["head_ref"] == "feat/x"
    assert body["pr_number"] is None
    assert Workspace.objects.filter(repo_owner="o", head_ref="feat/x").exists()


@pytest.mark.django_db
def test_create_duplicate_409(authed):
    client, u = authed
    Workspace.objects.create(repo_owner="o", repo_name="r", head_ref="feat/x", base_ref="main", created_by=u)
    resp = client.post(
        "/api/workspaces",
        {"repo_owner": "o", "repo_name": "r", "head_ref": "feat/x", "base_ref": "main"},
        format="json",
    )
    assert resp.status_code == 409


@pytest.mark.django_db
def test_list_workspaces(authed):
    client, u = authed
    Workspace.objects.create(repo_owner="o", repo_name="r", head_ref="feat/x", base_ref="main", created_by=u)
    resp = client.get("/api/workspaces")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


@pytest.mark.django_db
def test_lookup_hit(authed):
    client, u = authed
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", head_ref="feat/x", base_ref="main", pr_number=42, created_by=u)
    resp = client.get("/api/workspaces/lookup?repo_owner=o&repo_name=r&pr_number=42")
    assert resp.status_code == 200
    assert resp.json()["workspace_id"] == str(ws.id)


@pytest.mark.django_db
def test_lookup_miss(authed):
    client, _ = authed
    resp = client.get("/api/workspaces/lookup?repo_owner=o&repo_name=r&pr_number=99")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_get_workspace(authed):
    client, u = authed
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", head_ref="feat/x", base_ref="main", created_by=u)
    resp = client.get(f"/api/workspaces/{ws.id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == str(ws.id)


@pytest.mark.django_db
def test_patch_workspace_head_ref_while_local(authed):
    client, u = authed
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", head_ref="feat/x", base_ref="main", created_by=u)
    resp = client.patch(f"/api/workspaces/{ws.id}", {"head_ref": "feat/y"}, format="json")
    assert resp.status_code == 200
    ws.refresh_from_db()
    assert ws.head_ref == "feat/y"
```

- [ ] **Step 2:** run → fail.

- [ ] **Step 3:** serializers + views + urls (paste-in code)

```python
# serializers.py
from rest_framework import serializers
from apps.workspaces.models import Workspace


class WorkspaceCreateSerializer(serializers.Serializer):
    repo_owner = serializers.CharField(max_length=255)
    repo_name = serializers.CharField(max_length=255)
    head_ref = serializers.CharField(max_length=255)
    base_ref = serializers.CharField(max_length=255, required=False, default="main")


class WorkspaceSerializer(serializers.ModelSerializer):
    created_by = serializers.SerializerMethodField()

    class Meta:
        model = Workspace
        fields = [
            "id", "repo_owner", "repo_name", "head_ref", "base_ref",
            "pr_number", "pr_opened_at", "created_by", "created_at", "last_active_at",
        ]

    def get_created_by(self, obj):
        u = obj.created_by
        return {"id": u.id, "github_login": u.github_login}
```

```python
# views.py
from django.db import IntegrityError
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.response import Response

from apps.workspaces.models import Workspace
from apps.workspaces.serializers import WorkspaceCreateSerializer, WorkspaceSerializer


@api_view(["POST", "GET"])
def workspaces_collection(request):
    if request.method == "GET":
        qs = Workspace.objects.all().order_by("-last_active_at")
        return Response(WorkspaceSerializer(qs, many=True).data)
    s = WorkspaceCreateSerializer(data=request.data)
    s.is_valid(raise_exception=True)
    try:
        ws = Workspace.objects.create(created_by=request.user, **s.validated_data)
    except IntegrityError:
        return Response({"error": {"code": "workspace_exists"}}, status=409)
    return Response(WorkspaceSerializer(ws).data, status=201)


@api_view(["GET"])
def workspaces_lookup(request):
    o = request.query_params.get("repo_owner")
    r = request.query_params.get("repo_name")
    pr = request.query_params.get("pr_number")
    if not all([o, r, pr]):
        return Response({"error": {"code": "validation_error"}}, status=400)
    try:
        ws = Workspace.objects.get(repo_owner=o, repo_name=r, pr_number=int(pr))
    except Workspace.DoesNotExist:
        return Response({"error": {"code": "not_found"}}, status=404)
    return Response({"workspace_id": str(ws.id), "created_by": {"id": ws.created_by_id, "github_login": ws.created_by.github_login}})


@api_view(["GET", "PATCH"])
def workspace_detail(request, workspace_id):
    ws = get_object_or_404(Workspace, pk=workspace_id)
    if request.method == "PATCH":
        if ws.pr_number is not None:
            return Response({"error": {"code": "workspace_frozen", "message": "head_ref not editable once PR is open"}}, status=409)
        new_head = request.data.get("head_ref")
        new_base = request.data.get("base_ref")
        if new_head:
            ws.head_ref = new_head
        if new_base:
            ws.base_ref = new_base
        try:
            ws.save()
        except IntegrityError:
            return Response({"error": {"code": "workspace_exists"}}, status=409)
    return Response(WorkspaceSerializer(ws).data)
```

```python
# urls.py
from django.urls import path
from apps.workspaces import views

urlpatterns = [
    path("workspaces", views.workspaces_collection),
    path("workspaces/lookup", views.workspaces_lookup),
    path("workspaces/<uuid:workspace_id>", views.workspace_detail),
]
```

- [ ] **Step 4:** run → pass.

- [ ] **Step 5:** commit `feat(workspaces): create/list/lookup/get/patch endpoints`.

---

### Task 12: Create empty Storyline on workspace create

**Files:** modify `apps/workspaces/views.py` + add `apps/workspaces/storyline_service.py` skeleton

- [ ] **Step 1:** failing test (append to `test_views_basic.py`)

```python
@pytest.mark.django_db
def test_create_workspace_seeds_empty_storyline(authed):
    client, _ = authed
    resp = client.post(
        "/api/workspaces",
        {"repo_owner": "o", "repo_name": "r", "head_ref": "feat/x", "base_ref": "main"},
        format="json",
    )
    ws_id = resp.json()["id"]
    from apps.workspaces.models import Storyline, Workspace
    assert Storyline.objects.filter(workspace_id=ws_id).exists()
    assert Storyline.objects.get(workspace_id=ws_id).files.count() == 0
```

- [ ] **Step 2:** add the Storyline+StorylineFile models (full def in Task 13) + a tiny `create_storyline(ws, author) -> Storyline` helper that's called inside `workspaces_collection`. Migrate.

- [ ] **Step 3:** wire `create_storyline(ws, request.user)` after `Workspace.objects.create` in the POST handler.

- [ ] **Step 4:** run → pass.

- [ ] **Step 5:** commit `feat(workspaces): seed empty Storyline on workspace creation`.

---

## Phase 4 · Storyline

### Task 13: Storyline + StorylineFile models (full)

**Files:** extend `backend/apps/workspaces/models.py`, add `apps/workspaces/tests/test_storyline_models.py`

- [ ] **Step 1:** failing tests for the additional constraints

```python
import uuid
import pytest

from apps.identity.models import User
from apps.workspaces.models import Storyline, StorylineFile, Workspace


@pytest.mark.django_db
def test_storyline_one_per_workspace():
    u = User.objects.create(github_login="a", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", head_ref="x", base_ref="main", created_by=u)
    Storyline.objects.create(workspace=ws, raw_json="{}", etag=str(uuid.uuid4()), updated_by=u)
    with pytest.raises(Exception):
        Storyline.objects.create(workspace=ws, raw_json="{}", etag=str(uuid.uuid4()), updated_by=u)


@pytest.mark.django_db
def test_storyline_file_with_title():
    u = User.objects.create(github_login="a", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", head_ref="x", base_ref="main", created_by=u)
    s = Storyline.objects.create(workspace=ws, raw_json="{}", etag=str(uuid.uuid4()), updated_by=u)
    f = StorylineFile.objects.create(
        storyline=s, diff_file_path="a.py", order_index=0,
        title="Entry", intro_text="hi",
    )
    assert f.title == "Entry"


@pytest.mark.django_db
def test_storyline_file_unique_path():
    u = User.objects.create(github_login="a", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", head_ref="x", base_ref="main", created_by=u)
    s = Storyline.objects.create(workspace=ws, raw_json="{}", etag=str(uuid.uuid4()), updated_by=u)
    StorylineFile.objects.create(storyline=s, diff_file_path="a.py", order_index=0)
    with pytest.raises(Exception):
        StorylineFile.objects.create(storyline=s, diff_file_path="a.py", order_index=1)
```

- [ ] **Step 2:** add to models.py:

```python
class Storyline(models.Model):
    workspace = models.OneToOneField(Workspace, on_delete=models.CASCADE, related_name="storyline", primary_key=False)
    raw_json = models.TextField(default="{}")
    etag = models.CharField(max_length=36)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="storyline_updates")

    class Meta:
        db_table = "storyline"


class StorylineFile(models.Model):
    storyline = models.ForeignKey(Storyline, on_delete=models.CASCADE, related_name="files")
    diff_file_path = models.CharField(max_length=1024)
    order_index = models.IntegerField()
    title = models.CharField(max_length=255, blank=True, default="")
    intro_text = models.TextField(blank=True, default="")

    class Meta:
        db_table = "storyline_file"
        ordering = ["order_index"]
        constraints = [
            models.UniqueConstraint(fields=["storyline", "diff_file_path"], name="uniq_storyline_file_path"),
        ]
```

- [ ] **Step 3:** migrate, run, commit `feat(workspaces): Storyline + StorylineFile models with title`.

---

### Task 14: Storyline service (create / read with stale flag / write with etag)

**Files:** `backend/apps/workspaces/storyline_service.py`, `backend/apps/workspaces/tests/test_storyline_service.py`

- [ ] **Step 1:** failing tests

```python
from unittest.mock import MagicMock

import pytest

from apps.identity.models import User
from apps.workspaces.models import Storyline, StorylineFile, Workspace
from apps.workspaces.storyline_service import (
    StorylineETagMismatch,
    StorylineNotCreator,
    WorkspaceFrozen,
    create_storyline,
    read_storyline,
    write_storyline,
)


@pytest.fixture
def author_ws(db):
    u = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", head_ref="x", base_ref="main", created_by=u)
    return ws, u


def test_create_returns_storyline_with_etag(author_ws):
    ws, u = author_ws
    s = create_storyline(ws, u)
    assert s.etag
    assert s.files.count() == 0


def test_read_local_phase_no_stale(author_ws):
    ws, u = author_ws
    create_storyline(ws, u)
    StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="a.py", order_index=0, intro_text="hi")
    gateway = MagicMock()
    data, etag = read_storyline(ws, gateway)
    assert etag
    assert data["files"][0]["stale"] is False
    gateway.list_pr_files.assert_not_called()


def test_read_public_phase_marks_stale(author_ws):
    ws, u = author_ws
    ws.pr_number = 5; ws.save()
    create_storyline(ws, u)
    StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="gone.py", order_index=0, intro_text="x")
    gateway = MagicMock()
    gateway.list_pr_files.return_value = [{"filename": "still_here.py"}]
    gateway.get_pr.return_value = {"head": {"sha": "abc"}}
    data, _ = read_storyline(ws, gateway)
    assert data["files"][0]["stale"] is True


def test_write_rejects_non_creator(author_ws):
    ws, u = author_ws
    create_storyline(ws, u)
    bob = User.objects.create(github_login="bob", github_user_id=2)
    gateway = MagicMock()
    with pytest.raises(StorylineNotCreator):
        write_storyline(ws, bob, files=[], if_match=ws.storyline.etag, gateway=gateway)


def test_write_rejects_stale_etag(author_ws):
    ws, u = author_ws
    create_storyline(ws, u)
    gateway = MagicMock()
    with pytest.raises(StorylineETagMismatch):
        write_storyline(ws, u, files=[], if_match="wrong", gateway=gateway)


def test_write_rejects_frozen(author_ws):
    ws, u = author_ws
    ws.pr_number = 1; ws.save()
    create_storyline(ws, u)
    gateway = MagicMock()
    gateway.get_pr.return_value = {"state": "closed", "merged": False}
    with pytest.raises(WorkspaceFrozen):
        write_storyline(ws, u, files=[], if_match=ws.storyline.etag, gateway=gateway)


def test_write_replaces_files_and_bumps_etag(author_ws):
    ws, u = author_ws
    create_storyline(ws, u)
    StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="old.py", order_index=0)
    gateway = MagicMock()
    old = ws.storyline.etag
    new = write_storyline(
        ws, u,
        files=[{"diff_file_path": "new.py", "order_index": 0, "title": "T", "intro_text": "i"}],
        if_match=old, gateway=gateway,
    )
    assert new != old
    assert ws.storyline.files.count() == 1
    assert ws.storyline.files.first().diff_file_path == "new.py"
```

- [ ] **Step 2:** run → fail.

- [ ] **Step 3:** service

```python
import json
import uuid

from django.db import transaction

from apps.identity.models import User
from apps.workspaces.models import Storyline, StorylineFile, Workspace


class StorylineNotCreator(Exception): pass
class StorylineETagMismatch(Exception): pass
class WorkspaceFrozen(Exception): pass


def _new_etag() -> str:
    return str(uuid.uuid4())


def _is_frozen(ws: Workspace, gateway) -> bool:
    if ws.pr_number is None:
        return False
    pr = gateway.get_pr(ws.repo_owner, ws.repo_name, ws.pr_number)
    return pr.get("state") == "closed"


def create_storyline(workspace: Workspace, author: User) -> Storyline:
    return Storyline.objects.create(
        workspace=workspace,
        raw_json=json.dumps({"files": []}),
        etag=_new_etag(),
        updated_by=author,
    )


def read_storyline(workspace: Workspace, gateway) -> tuple[dict, str]:
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
                "id": f.id,
                "diff_file_path": f.diff_file_path,
                "order_index": f.order_index,
                "title": f.title,
                "intro_text": f.intro_text,
                "stale": f.diff_file_path in stale_paths,
                "stale_reason": "file_removed" if f.diff_file_path in stale_paths else None,
                "intro_comment_count": f.intro_comments.filter(deleted_at__isnull=True).count(),
                "intro_comment_unresolved": f.intro_comments.filter(deleted_at__isnull=True, parent__isnull=True, resolved_at__isnull=True).count(),
            }
            for f in files
        ],
    }
    return payload, s.etag


def write_storyline(workspace: Workspace, user: User, *, files: list[dict], if_match: str, gateway) -> str:
    if user.id != workspace.created_by_id:
        raise StorylineNotCreator()
    if _is_frozen(workspace, gateway):
        raise WorkspaceFrozen()

    with transaction.atomic():
        s = Storyline.objects.select_for_update().get(workspace=workspace)
        if s.etag != if_match:
            raise StorylineETagMismatch()
        StorylineFile.objects.filter(storyline=s).delete()
        rows = [
            StorylineFile(
                storyline=s,
                diff_file_path=f["diff_file_path"],
                order_index=f.get("order_index", idx),
                title=f.get("title", ""),
                intro_text=f.get("intro_text", ""),
            )
            for idx, f in enumerate(files)
        ]
        StorylineFile.objects.bulk_create(rows)
        s.raw_json = json.dumps({"files": files})
        s.etag = _new_etag()
        s.updated_by = user
        s.save(update_fields=["raw_json", "etag", "updated_by", "updated_at"])
    return s.etag
```

- [ ] **Step 4:** run → pass. commit `feat(workspaces): storyline service (create/read-with-stale/write-with-etag)`.

---

### Task 15: Storyline endpoints (GET list + PUT + GET single file)

**Files:** modify `apps/workspaces/{views.py,urls.py}`, add `apps/workspaces/tests/test_storyline_views.py`

- [ ] **Step 1:** failing tests covering 200 GET, 200 PUT with etag, 412 (no If-Match), 409 (etag mismatch), 403 (not creator), 409 (frozen — patch `gateway.get_pr` to return closed state), 200 GET single file.

- [ ] **Step 2:** views

```python
from apps.github_proxy.gateway import GithubGateway
from django.conf import settings
from apps.workspaces.storyline_service import (
    StorylineETagMismatch, StorylineNotCreator, WorkspaceFrozen, read_storyline, write_storyline,
)


def _gw():
    return GithubGateway(token=settings.GITHUB_ADMIN_PAT)


@api_view(["GET", "PUT"])
def storyline_detail(request, workspace_id):
    ws = get_object_or_404(Workspace, pk=workspace_id)
    g = _gw()
    try:
        if request.method == "GET":
            data, etag = read_storyline(ws, g)
            resp = Response(data)
            resp["ETag"] = etag
            return resp

        if_match = request.headers.get("If-Match")
        if not if_match:
            return Response({"error": {"code": "precondition_required"}}, status=412)
        files = request.data.get("files", [])
        try:
            new_etag = write_storyline(ws, request.user, files=files, if_match=if_match, gateway=g)
        except StorylineNotCreator:
            return Response({"error": {"code": "forbidden"}}, status=403)
        except StorylineETagMismatch:
            return Response({"error": {"code": "etag_mismatch"}}, status=409)
        except WorkspaceFrozen:
            return Response({"error": {"code": "workspace_frozen"}}, status=409)
        data, _ = read_storyline(ws, g)
        resp = Response(data)
        resp["ETag"] = new_etag
        return resp
    finally:
        g.close()


@api_view(["GET"])
def storyline_file_detail(request, workspace_id, file_id):
    ws = get_object_or_404(Workspace, pk=workspace_id)
    sf = get_object_or_404(StorylineFile, pk=file_id, storyline__workspace=ws)
    g = _gw()
    try:
        data, _ = read_storyline(ws, g)
    finally:
        g.close()
    for f in data["files"]:
        if f["id"] == sf.id:
            return Response(f)
    return Response({"error": {"code": "not_found"}}, status=404)
```

```python
# urls.py - add
path("workspaces/<uuid:workspace_id>/storyline", views.storyline_detail),
path("workspaces/<uuid:workspace_id>/storyline/files/<int:file_id>", views.storyline_file_detail),
```

- [ ] **Step 3:** run → pass. commit `feat(workspaces): storyline GET / PUT / single-file endpoints`.

---

### Task 16: Touch `Workspace.last_active_at` on writes

- [ ] **Step 1:** test that `last_active_at` changes after a successful storyline PUT.
- [ ] **Step 2:** call `ws.save(update_fields=["last_active_at"])` (or rely on `auto_now`) inside `write_storyline`.
- [ ] **Step 3:** commit `feat(workspaces): bump last_active_at on storyline writes`.

---

## Phase 5 · IntroComments

### Task 17: IntroComment model + invariant

**Files:** extend `models.py`, add tests covering: depth-1 enforcement on insert, soft-delete preserves thread, resolution only on roots.

Model fields per `docs/data-model.md`. DB constraint `CHECK: parent IS NULL OR (resolved_by IS NULL AND resolved_at IS NULL)`.

- [ ] **Step 1:** failing tests
- [ ] **Step 2:** model
- [ ] **Step 3:** migrate + commit `feat(workspaces): IntroComment model + invariants`

---

### Task 18: IntroComment endpoints + service

**Files:** `apps/workspaces/intro_comment_service.py`, views/urls/tests

Endpoints per `docs/api.md`:
- `GET /workspaces/{uuid}/storyline/files/{file_id}/intro-comments` (with `include_resolved`)
- `POST` same path
- `PATCH /intro-comments/{id}` (owner)
- `DELETE /intro-comments/{id}` (owner, soft)
- `POST /intro-comments/{id}/resolve` (creator-only, root-only)
- `POST /intro-comments/{id}/unresolve` (creator-only)

Service enforces depth-1 invariant + freeze check on every write.

- [ ] **Step 1:** failing tests
- [ ] **Step 2:** implement
- [ ] **Step 3:** commit `feat(workspaces): intro-comment endpoints (post/edit/delete/resolve)`

---

## Phase 6 · GithubGateway writes

### Task 19: Gateway write methods

Add to `apps/github_proxy/gateway.py`:
- `post_issue_comment`, `post_review_comment` (with `commit_id` or `in_reply_to`), `post_review`
- `patch_pr`, `merge_pr`, `create_pull`, `request_reviewers`, `add_labels`
- `edit_issue_comment`, `delete_issue_comment`, `edit_review_comment`, `delete_review_comment`, `react_to_comment`

- [ ] **Step 1:** failing respx tests per method (one happy path + one error each)
- [ ] **Step 2:** implement
- [ ] **Step 3:** commit `feat(github_proxy): gateway write methods (comments/reviews/PR actions)`

---

## Phase 7 · Open-PR + Reopen-PR

### Task 20: open-pr orchestration + reopen-pr passthrough

**Files:** `apps/workspaces/open_pr_service.py` + views/urls/tests.

Per `docs/api.md` § `/open-pr`:
- creator-only
- 409 `pr_already_open` if `pr_number IS NOT NULL` AND github PR is open
- atomic: `gateway.create_pull` → set `pr_number` + `pr_opened_at` → optional `request_reviewers` + `add_labels` (best-effort, warnings)
- if `pr_number` previously pointed at a closed/merged PR, OVERWRITE on success
- response: `{ workspace, pr, warnings }`

`/reopen-pr`: thin passthrough `gateway.patch_pr(state=open)`. Creator-only. Returns github PR.

- [ ] **Step 1:** failing tests (happy path, creator-only, pr_already_open, github failure rolls back, warnings on reviewer/label fail)
- [ ] **Step 2:** implement
- [ ] **Step 3:** commit `feat(workspaces): open-pr orchestration + reopen-pr`

---

## Phase 8 · PR-anchored read proxy

### Task 21: PR-anchored read endpoints (no workspace required)

**Files:** `apps/github_proxy/views.py`, urls, tests.

Per `docs/api.md` § PR-anchored:
- `GET /api/repos/{o}/{r}/pulls/{n}`
- `GET .../files`
- `GET .../files/{path}/diff` (filter `list_pr_files` to `path`)
- `GET .../files/{path}/comments` (filter `list_review_comments` to `path`)
- `GET .../comments` (combined issue + review)
- `GET .../reviews`
- `GET .../checks` (combined check_runs + workflow_runs from head_sha — fetched implicitly via `get_pr` to get head SHA, then both list calls)

All routes use admin PAT; pure passthrough except where filtering is needed.

- [ ] **Step 1:** failing tests per endpoint (mocked gateway)
- [ ] **Step 2:** implement
- [ ] **Step 3:** commit `feat(github_proxy): PR-anchored read endpoints`

---

## Phase 9 · PR-anchored write proxy

### Task 22: PR-anchored writes (comments/review/actions)

Per `docs/api.md`:
- `POST /api/repos/{o}/{r}/pulls/{n}/comments` — `kind: issue|review`
- `POST .../review` — batched
- `POST .../actions/close|reopen|toggle-draft|merge`

- [ ] **Step 1:** failing tests
- [ ] **Step 2:** implement (using gateway write methods from Task 19)
- [ ] **Step 3:** commit `feat(github_proxy): PR-anchored write-through and PR actions`

---

## Phase 10 · Github search

### Task 23: `/api/github/prs` (cross-filtered against workspaces)

Per `docs/api.md`:
- `GET /api/github/prs?role=author|reviewer`
- Build query: `is:pr is:open author:{login}` or `... review-requested:{login}`
- Call `gateway.search_issues(q)`
- Filter out items whose `(repo, number)` matches an existing Workspace
- Return `{ items: [...] }`

- [ ] **Step 1:** failing tests (each role; filter excludes existing workspace)
- [ ] **Step 2:** implement
- [ ] **Step 3:** commit `feat(github_proxy): github search endpoint with workspace cross-filter`

---

## Phase 11 · Polish

### Task 24: Smoke test + coverage

- [ ] **Step 1:** `cd backend && uv run pytest --cov=apps --cov-report=term-missing`
- [ ] **Step 2:** `uv run python manage.py migrate && uv run python manage.py runserver 8000 &` → curl `/api/auth/me` (401), `/api/auth/device/start` (200 mock-failing — needs real OAuth client; acceptable).
- [ ] **Step 3:** tag `v0.1.0-poc-backend`.

---

## Coverage map (spec v3 sections → tasks)

| Spec v3 section | Tasks |
|---|---|
| §1 Architecture | T1–T4, T9, T21–T23 |
| §2 Tech stack | T1 |
| §3.1 github_oauth | T6 |
| §3.2 session_service | T7 |
| §3.3 storyline_service | T14 |
| §3.4 intro_comment_service | T18 |
| §3.5 open_pr_service | T20 |
| §3.6 gateway | T9, T19 |
| §4 Computed-state semantics | T14 (stale flags), T20 (frozen check) |
| §5 Stale-step detection | T14 |
| §6 Persistence | All migration steps |
| §7 Testing approach | Test-first per task |

Contract docs (`docs/data-model.md`, `docs/api.md`) are referenced as authoritative on every endpoint shape — the plan does not duplicate their content.

---

## Done criteria

After T24, a developer with:
- a github admin PAT (with `repo` + `read:user` scopes),
- a github OAuth app client_id / client_secret with device flow enabled,

can:
- run `uv run python manage.py runserver` and the backend boots,
- complete the device-flow login from any client, receive a Bearer token,
- create a workspace + write a storyline (etag-protected),
- post threaded intro comments + resolve threads,
- open a github PR atomically via `/open-pr`,
- post comments + submit reviews on PRs via the PR-anchored surface,
- list their own workspaces and find github PRs not yet in Stage.

All of `docs/api.md` is served. All of `docs/data-model.md` is persisted.

UI is out of scope; the contract is delivered to the Client developer for them to consume.
