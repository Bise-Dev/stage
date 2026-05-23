# Local-Review Backend v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Django REST backend defined in [`docs/superpowers/specs/2026-05-23-local-review-backend-design.md`](../specs/2026-05-23-local-review-backend-design.md) — a thin middleware that owns storyline + intros + AI-doc + pre-publish drafts and proxies everything else to github via a single admin PAT.

**Architecture:** Single Django process. Three apps: `identity`, `workspaces` (workspaces + storyline + intros + ai-doc + drafts), `github_proxy` (gateway + proxy routes). PostgreSQL in prod, SQLite in dev. No worker, no webhooks, no cache in v1.

**Tech Stack:** Python 3.12+ (uv-managed), Django 5.x, Django REST Framework, PyGithub + httpx, pytest + pytest-django + respx, github OAuth-login for identity, single admin PAT for github API.

---

## Phase Boundaries (each phase = working software)

| Phase | Tasks | Working outcome |
|---|---|---|
| 0 · Scaffolding | T1–T4 | Django boots, dev settings work, `pytest` runs zero tests cleanly |
| 1 · Identity | T5–T10 | OAuth login flow + `/api/auth/me` works end-to-end with a real github app |
| 2 · Gateway + Workspaces | T11–T15 | Can create workspace bound to a real PR, list/archive workspaces |
| 3 · Storyline | T16–T19 | Author can read/write storyline with ETag concurrency |
| 4 · Intro comments | T20–T23 | Reviewers can post threaded discussion on storyline intros |
| 5 · AI doc | T24–T26 | Author can ingest structured AI analysis |
| 6 · Drafts + publish | T27–T31 | User can compose drafts locally and push single or batch to github |
| 7 · Proxy routes | T32–T35 | All read + write passthrough for github-domain operations |
| 8 · Polish | T36–T37 | Error envelope + CSRF/cookie verification |

---

## Phase 0 · Scaffolding

### Task 1: Init project with uv + Django + git

**Files:**
- Create: `pyproject.toml`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `.python-version`

- [ ] **Step 1: Init git repo**

```bash
cd /Users/ybouzonie/gitlab/local-review && git init
```

- [ ] **Step 2: Init uv project + add deps**

```bash
uv init --name local-review --no-readme
uv python pin 3.12
uv add "django>=5.0,<5.2" "djangorestframework>=3.15" "PyGithub>=2.3" "httpx>=0.27" "respx>=0.21" python-dotenv
uv add --dev pytest pytest-django pytest-cov factory-boy freezegun
```

- [ ] **Step 3: Write `.gitignore`**

```
.venv/
__pycache__/
*.pyc
.pytest_cache/
.coverage
htmlcov/
db.sqlite3
db.sqlite3-journal
.env
.env.local
.DS_Store
.superpowers/brainstorm/*/content/*.html
.superpowers/brainstorm/*/state/
*.egg-info/
dist/
build/
```

- [ ] **Step 4: Write `.env.example`**

```
# Django
DJANGO_SETTINGS_MODULE=local_review.settings.dev
DJANGO_SECRET_KEY=change-me-in-prod
DJANGO_DEBUG=true

# Database (prod only; dev uses SQLite db.sqlite3)
DATABASE_URL=postgres://user:pass@localhost:5432/local_review

# Github API
GITHUB_ADMIN_PAT=ghp_REPLACE_WITH_REAL_PAT
GITHUB_OAUTH_CLIENT_ID=Iv1.REPLACE_ME
GITHUB_OAUTH_CLIENT_SECRET=REPLACE_ME
GITHUB_OAUTH_REDIRECT_URI=http://localhost:8000/api/auth/callback
```

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml uv.lock .gitignore .env.example .python-version
git commit -m "chore: init uv project with Django and core deps"
```

---

### Task 2: Django project skeleton with split settings

**Files:**
- Create: `manage.py`
- Create: `local_review/__init__.py`
- Create: `local_review/settings/__init__.py`
- Create: `local_review/settings/base.py`
- Create: `local_review/settings/dev.py`
- Create: `local_review/settings/prod.py`
- Create: `local_review/urls.py`
- Create: `local_review/wsgi.py`
- Create: `local_review/asgi.py`

- [ ] **Step 1: Write `manage.py`**

```python
#!/usr/bin/env python
import os
import sys


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "local_review.settings.dev")
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Couldn't import Django. Activate a virtualenv with `uv sync`?"
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write `local_review/settings/base.py`**

```python
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent.parent

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "insecure-dev-key")
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
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
]

ROOT_URLCONF = "local_review.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": []},
    }
]

WSGI_APPLICATION = "local_review.wsgi.application"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
TIME_ZONE = "UTC"
LANGUAGE_CODE = "en-us"
STATIC_URL = "static/"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "apps.identity.auth.SessionUserAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
}

GITHUB_ADMIN_PAT = os.environ["GITHUB_ADMIN_PAT"]
GITHUB_OAUTH_CLIENT_ID = os.environ["GITHUB_OAUTH_CLIENT_ID"]
GITHUB_OAUTH_CLIENT_SECRET = os.environ["GITHUB_OAUTH_CLIENT_SECRET"]
GITHUB_OAUTH_REDIRECT_URI = os.environ["GITHUB_OAUTH_REDIRECT_URI"]
```

- [ ] **Step 3: Write `local_review/settings/dev.py`**

```python
from .base import *  # noqa: F401,F403

DEBUG = True
ALLOWED_HOSTS = ["localhost", "127.0.0.1"]

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}

SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
```

- [ ] **Step 4: Write `local_review/settings/prod.py`**

```python
import os
from urllib.parse import urlparse

from .base import *  # noqa: F401,F403

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

SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SESSION_COOKIE_SAMESITE = "Lax"
SECURE_HSTS_SECONDS = 60
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
```

- [ ] **Step 5: Write `local_review/urls.py`**

```python
from django.urls import include, path

urlpatterns = [
    path("api/auth/", include("apps.identity.urls")),
    path("api/", include("apps.workspaces.urls")),
    path("api/", include("apps.github_proxy.urls")),
]
```

- [ ] **Step 6: Write `local_review/__init__.py`** (empty file)

- [ ] **Step 7: Write `local_review/wsgi.py`**

```python
import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "local_review.settings.prod")
application = get_wsgi_application()
```

- [ ] **Step 8: Write `local_review/asgi.py`**

```python
import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "local_review.settings.prod")
application = get_asgi_application()
```

- [ ] **Step 9: Create empty settings package init**

Write `local_review/settings/__init__.py`:

```python
```

(empty file)

- [ ] **Step 10: Commit**

```bash
git add manage.py local_review/
git commit -m "chore: add Django project skeleton with split settings"
```

---

### Task 3: Pytest + pytest-django configuration

**Files:**
- Create: `pytest.ini`
- Create: `conftest.py`
- Modify: `pyproject.toml` (test scripts)

- [ ] **Step 1: Write `pytest.ini`**

```ini
[pytest]
DJANGO_SETTINGS_MODULE = local_review.settings.dev
python_files = tests.py test_*.py *_tests.py
python_classes = Test*
python_functions = test_*
addopts = -ra --strict-markers --tb=short
testpaths = apps
filterwarnings =
    ignore::DeprecationWarning
```

- [ ] **Step 2: Write `conftest.py`**

```python
import os

import pytest

os.environ.setdefault("GITHUB_ADMIN_PAT", "test-pat")
os.environ.setdefault("GITHUB_OAUTH_CLIENT_ID", "test-client-id")
os.environ.setdefault("GITHUB_OAUTH_CLIENT_SECRET", "test-client-secret")
os.environ.setdefault("GITHUB_OAUTH_REDIRECT_URI", "http://testserver/api/auth/callback")


@pytest.fixture
def api_client():
    from rest_framework.test import APIClient

    return APIClient()
```

- [ ] **Step 3: Run pytest to confirm clean baseline**

```bash
uv run pytest
```

Expected: `0 tests collected` (no tests yet) — pytest exits cleanly.

- [ ] **Step 4: Commit**

```bash
git add pytest.ini conftest.py
git commit -m "chore: configure pytest with pytest-django"
```

---

### Task 4: Create empty apps + verify dev server boots

**Files:**
- Create: `apps/__init__.py`
- Create: `apps/identity/__init__.py`
- Create: `apps/identity/apps.py`
- Create: `apps/workspaces/__init__.py`
- Create: `apps/workspaces/apps.py`
- Create: `apps/github_proxy/__init__.py`
- Create: `apps/github_proxy/apps.py`
- Create: `apps/identity/urls.py`
- Create: `apps/workspaces/urls.py`
- Create: `apps/github_proxy/urls.py`

- [ ] **Step 1: Write `apps/__init__.py`** (empty)

- [ ] **Step 2: Write `apps/identity/__init__.py`** (empty)

- [ ] **Step 3: Write `apps/identity/apps.py`**

```python
from django.apps import AppConfig


class IdentityConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.identity"
```

- [ ] **Step 4: Write `apps/identity/urls.py`**

```python
from django.urls import path

urlpatterns: list = []
```

- [ ] **Step 5: Repeat steps 2–4 for `apps/workspaces` and `apps/github_proxy`** (mirror file structure with appropriate class names `WorkspacesConfig` and `GithubProxyConfig`).

- [ ] **Step 6: Run migrations + start dev server (smoke test)**

```bash
uv run python manage.py migrate
uv run python manage.py runserver 8000 &
sleep 2 && curl -s http://localhost:8000/api/auth/login -o /dev/null -w "%{http_code}\n"
kill %1
```

Expected: `404` (no routes yet, but server runs). No traceback.

- [ ] **Step 7: Commit**

```bash
git add apps/
git commit -m "chore: scaffold identity, workspaces, github_proxy apps"
```

---

## Phase 1 · Identity

### Task 5: User + UserRepoPermission models

**Files:**
- Create: `apps/identity/models.py`
- Create: `apps/identity/tests/__init__.py`
- Create: `apps/identity/tests/test_models.py`

- [ ] **Step 1: Write failing test `apps/identity/tests/test_models.py`**

```python
import pytest
from django.utils import timezone

from apps.identity.models import User, UserRepoPermission


@pytest.mark.django_db
def test_user_creation():
    u = User.objects.create(
        github_login="octocat",
        github_user_id=583231,
        display_name="The Octocat",
        avatar_url="https://avatars.example/o",
    )
    assert u.id is not None
    assert u.github_login == "octocat"
    assert u.last_login_at is None


@pytest.mark.django_db
def test_user_github_login_unique():
    User.objects.create(github_login="alice", github_user_id=1)
    with pytest.raises(Exception):
        User.objects.create(github_login="alice", github_user_id=2)


@pytest.mark.django_db
def test_user_repo_permission_unique_triple():
    u = User.objects.create(github_login="alice", github_user_id=1)
    now = timezone.now()
    UserRepoPermission.objects.create(
        user=u, repo_owner="x", repo_name="y",
        level="write", fetched_at=now, expires_at=now,
    )
    with pytest.raises(Exception):
        UserRepoPermission.objects.create(
            user=u, repo_owner="x", repo_name="y",
            level="read", fetched_at=now, expires_at=now,
        )
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest apps/identity/tests/test_models.py -v
```

Expected: ImportError or collection error — `apps.identity.models` doesn't exist.

- [ ] **Step 3: Write `apps/identity/models.py`**

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


class UserRepoPermission(models.Model):
    LEVEL_CHOICES = [
        ("none", "none"),
        ("read", "read"),
        ("triage", "triage"),
        ("write", "write"),
        ("maintain", "maintain"),
        ("admin", "admin"),
    ]

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="repo_permissions")
    repo_owner = models.CharField(max_length=255)
    repo_name = models.CharField(max_length=255)
    level = models.CharField(max_length=16, choices=LEVEL_CHOICES)
    fetched_at = models.DateTimeField()
    expires_at = models.DateTimeField()

    class Meta:
        db_table = "identity_user_repo_permission"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "repo_owner", "repo_name"],
                name="uniq_user_repo",
            ),
        ]
```

- [ ] **Step 4: Generate + apply migration**

```bash
uv run python manage.py makemigrations identity
uv run python manage.py migrate
```

- [ ] **Step 5: Run test to verify pass**

```bash
uv run pytest apps/identity/tests/test_models.py -v
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/identity/models.py apps/identity/migrations apps/identity/tests
git commit -m "feat(identity): add User and UserRepoPermission models"
```

---

### Task 6: Github OAuth helper

**Files:**
- Create: `apps/identity/github_oauth.py`
- Create: `apps/identity/tests/test_github_oauth.py`

- [ ] **Step 1: Write failing test `apps/identity/tests/test_github_oauth.py`**

```python
import respx
from httpx import Response

from apps.identity.github_oauth import (
    build_authorize_url,
    exchange_code_for_token,
    fetch_github_user,
)


def test_build_authorize_url_contains_required_params():
    url = build_authorize_url(state="abc")
    assert url.startswith("https://github.com/login/oauth/authorize?")
    assert "client_id=test-client-id" in url
    assert "redirect_uri=http%3A%2F%2Ftestserver%2Fapi%2Fauth%2Fcallback" in url
    assert "scope=read%3Auser" in url
    assert "state=abc" in url


@respx.mock
def test_exchange_code_for_token_happy_path():
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=Response(200, json={"access_token": "gho_xxx", "token_type": "bearer"})
    )
    token = exchange_code_for_token("abc-code")
    assert token == "gho_xxx"


@respx.mock
def test_exchange_code_raises_on_error():
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=Response(200, json={"error": "bad_verification_code"})
    )
    import pytest
    from apps.identity.github_oauth import OAuthError
    with pytest.raises(OAuthError):
        exchange_code_for_token("abc-code")


@respx.mock
def test_fetch_github_user():
    respx.get("https://api.github.com/user").mock(
        return_value=Response(
            200,
            json={"login": "octocat", "id": 583231, "name": "Octo", "avatar_url": "https://x"},
        )
    )
    u = fetch_github_user("gho_xxx")
    assert u["login"] == "octocat"
    assert u["id"] == 583231
```

- [ ] **Step 2: Run test → fail (module missing)**

```bash
uv run pytest apps/identity/tests/test_github_oauth.py -v
```

- [ ] **Step 3: Write `apps/identity/github_oauth.py`**

```python
from urllib.parse import urlencode

import httpx
from django.conf import settings


class OAuthError(Exception):
    pass


_AUTHORIZE_BASE = "https://github.com/login/oauth/authorize"
_TOKEN_URL = "https://github.com/login/oauth/access_token"
_USER_URL = "https://api.github.com/user"


def build_authorize_url(state: str) -> str:
    params = {
        "client_id": settings.GITHUB_OAUTH_CLIENT_ID,
        "redirect_uri": settings.GITHUB_OAUTH_REDIRECT_URI,
        "scope": "read:user",
        "state": state,
    }
    return f"{_AUTHORIZE_BASE}?{urlencode(params)}"


def exchange_code_for_token(code: str) -> str:
    resp = httpx.post(
        _TOKEN_URL,
        data={
            "client_id": settings.GITHUB_OAUTH_CLIENT_ID,
            "client_secret": settings.GITHUB_OAUTH_CLIENT_SECRET,
            "code": code,
            "redirect_uri": settings.GITHUB_OAUTH_REDIRECT_URI,
        },
        headers={"Accept": "application/json"},
        timeout=10.0,
    )
    resp.raise_for_status()
    body = resp.json()
    if "error" in body:
        raise OAuthError(body["error"])
    return body["access_token"]


def fetch_github_user(access_token: str) -> dict:
    resp = httpx.get(
        _USER_URL,
        headers={"Authorization": f"token {access_token}", "Accept": "application/vnd.github+json"},
        timeout=10.0,
    )
    resp.raise_for_status()
    return resp.json()
```

- [ ] **Step 4: Run test → pass**

```bash
uv run pytest apps/identity/tests/test_github_oauth.py -v
```

- [ ] **Step 5: Commit**

```bash
git add apps/identity/github_oauth.py apps/identity/tests/test_github_oauth.py
git commit -m "feat(identity): add github OAuth helper"
```

---

### Task 7: Auth views + session

**Files:**
- Create: `apps/identity/views.py`
- Create: `apps/identity/auth.py`
- Modify: `apps/identity/urls.py`
- Create: `apps/identity/tests/test_views.py`

- [ ] **Step 1: Write failing test `apps/identity/tests/test_views.py`**

```python
from unittest.mock import patch

import pytest

from apps.identity.models import User


@pytest.mark.django_db
def test_login_redirects_to_github(api_client):
    resp = api_client.get("/api/auth/login")
    assert resp.status_code == 302
    assert resp["Location"].startswith("https://github.com/login/oauth/authorize?")


@pytest.mark.django_db
@patch("apps.identity.views.exchange_code_for_token")
@patch("apps.identity.views.fetch_github_user")
def test_callback_creates_user_and_sets_session(
    mock_fetch, mock_exchange, api_client
):
    mock_exchange.return_value = "gho_xxx"
    mock_fetch.return_value = {
        "login": "alice",
        "id": 42,
        "name": "Alice",
        "avatar_url": "https://x",
    }

    session = api_client.session
    session["oauth_state"] = "abc"
    session.save()

    resp = api_client.get("/api/auth/callback?code=c&state=abc")
    assert resp.status_code == 302
    assert User.objects.filter(github_login="alice", github_user_id=42).exists()


@pytest.mark.django_db
def test_me_returns_401_when_unauthenticated(api_client):
    resp = api_client.get("/api/auth/me")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_me_returns_current_user(api_client):
    u = User.objects.create(github_login="alice", github_user_id=42)
    session = api_client.session
    session["user_id"] = u.id
    session.save()
    resp = api_client.get("/api/auth/me")
    assert resp.status_code == 200
    assert resp.json()["github_login"] == "alice"


@pytest.mark.django_db
def test_logout_clears_session(api_client):
    u = User.objects.create(github_login="alice", github_user_id=42)
    session = api_client.session
    session["user_id"] = u.id
    session.save()
    resp = api_client.post("/api/auth/logout")
    assert resp.status_code == 204
    resp_me = api_client.get("/api/auth/me")
    assert resp_me.status_code == 401
```

- [ ] **Step 2: Run test → fail**

```bash
uv run pytest apps/identity/tests/test_views.py -v
```

- [ ] **Step 3: Write `apps/identity/auth.py` (DRF authentication class)**

```python
from rest_framework import authentication, exceptions

from apps.identity.models import User


class SessionUserAuthentication(authentication.BaseAuthentication):
    """Authenticates via session-stored user_id. No DRF Token. No django auth user."""

    def authenticate(self, request):
        user_id = request.session.get("user_id")
        if not user_id:
            return None
        try:
            user = User.objects.get(pk=user_id)
        except User.DoesNotExist:
            raise exceptions.AuthenticationFailed("stale session")
        # DRF expects (user, auth) tuple; user must have .is_authenticated truthy
        # We attach the attr dynamically since our User doesn't extend AbstractBaseUser
        setattr(user, "is_authenticated", True)
        return (user, None)
```

- [ ] **Step 4: Write `apps/identity/views.py`**

```python
import secrets

from django.conf import settings
from django.shortcuts import redirect
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from apps.identity.github_oauth import (
    build_authorize_url,
    exchange_code_for_token,
    fetch_github_user,
)
from apps.identity.models import User


@api_view(["GET"])
@permission_classes([AllowAny])
def login_view(request):
    state = secrets.token_urlsafe(24)
    request.session["oauth_state"] = state
    return redirect(build_authorize_url(state))


@api_view(["GET"])
@permission_classes([AllowAny])
def callback_view(request):
    code = request.query_params.get("code")
    state = request.query_params.get("state")
    expected = request.session.pop("oauth_state", None)
    if not code or not state or state != expected:
        return Response({"error": {"code": "bad_state"}}, status=status.HTTP_400_BAD_REQUEST)

    token = exchange_code_for_token(code)
    gh_user = fetch_github_user(token)

    user, _ = User.objects.update_or_create(
        github_user_id=gh_user["id"],
        defaults={
            "github_login": gh_user["login"],
            "display_name": gh_user.get("name") or "",
            "avatar_url": gh_user.get("avatar_url") or "",
            "last_login_at": timezone.now(),
        },
    )
    request.session["user_id"] = user.id
    return redirect("/")


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def me_view(request):
    u = request.user
    return Response({
        "id": u.id,
        "github_login": u.github_login,
        "github_user_id": u.github_user_id,
        "display_name": u.display_name,
        "avatar_url": u.avatar_url,
    })


@api_view(["POST"])
@permission_classes([AllowAny])
def logout_view(request):
    request.session.flush()
    return Response(status=status.HTTP_204_NO_CONTENT)
```

- [ ] **Step 5: Write `apps/identity/urls.py`**

```python
from django.urls import path

from apps.identity import views

urlpatterns = [
    path("login", views.login_view),
    path("callback", views.callback_view),
    path("me", views.me_view),
    path("logout", views.logout_view),
]
```

- [ ] **Step 6: Add CSRF exemption for OAuth callback** — already covered (CSRF on POST only; callback is GET).

- [ ] **Step 7: Run tests → pass**

```bash
uv run pytest apps/identity/tests/ -v
```

- [ ] **Step 8: Commit**

```bash
git add apps/identity/
git commit -m "feat(identity): OAuth login + session + /me + /logout"
```

---

## Phase 2 · GithubGateway + Workspaces

### Task 8: GithubGateway scaffold (PR get + files)

**Files:**
- Create: `apps/github_proxy/gateway.py`
- Create: `apps/github_proxy/exceptions.py`
- Create: `apps/github_proxy/tests/__init__.py`
- Create: `apps/github_proxy/tests/test_gateway.py`

- [ ] **Step 1: Write failing test `apps/github_proxy/tests/test_gateway.py`**

```python
import pytest
import respx
from httpx import Response

from apps.github_proxy.exceptions import GithubNotFound, GithubError
from apps.github_proxy.gateway import GithubGateway


@respx.mock
def test_get_pr_happy_path():
    respx.get("https://api.github.com/repos/o/r/pulls/1").mock(
        return_value=Response(200, json={"number": 1, "user": {"login": "alice"}})
    )
    g = GithubGateway(token="test-pat")
    pr = g.get_pr("o", "r", 1)
    assert pr["number"] == 1
    assert pr["user"]["login"] == "alice"


@respx.mock
def test_get_pr_not_found_raises():
    respx.get("https://api.github.com/repos/o/r/pulls/999").mock(
        return_value=Response(404, json={"message": "Not Found"})
    )
    g = GithubGateway(token="test-pat")
    with pytest.raises(GithubNotFound):
        g.get_pr("o", "r", 999)


@respx.mock
def test_list_pr_files():
    respx.get("https://api.github.com/repos/o/r/pulls/1/files").mock(
        return_value=Response(
            200,
            json=[
                {"filename": "a.py", "status": "modified"},
                {"filename": "b.py", "status": "added"},
            ],
        )
    )
    g = GithubGateway(token="test-pat")
    files = g.list_pr_files("o", "r", 1)
    assert len(files) == 2
    assert files[0]["filename"] == "a.py"


@respx.mock
def test_other_4xx_raises_github_error():
    respx.get("https://api.github.com/repos/o/r/pulls/1").mock(
        return_value=Response(422, json={"message": "Unprocessable"})
    )
    g = GithubGateway(token="test-pat")
    with pytest.raises(GithubError) as exc_info:
        g.get_pr("o", "r", 1)
    assert exc_info.value.status_code == 422
```

- [ ] **Step 2: Run test → fail**

```bash
uv run pytest apps/github_proxy/tests/test_gateway.py -v
```

- [ ] **Step 3: Write `apps/github_proxy/exceptions.py`**

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

- [ ] **Step 4: Write `apps/github_proxy/gateway.py`**

```python
from typing import Any

import httpx

from apps.github_proxy.exceptions import (
    GithubConflict,
    GithubError,
    GithubForbidden,
    GithubNotFound,
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
        if resp.status_code == 404:
            raise GithubNotFound(404, resp.json().get("message", "Not Found"), resp.json())
        if resp.status_code == 403:
            raise GithubForbidden(403, resp.json().get("message", "Forbidden"), resp.json())
        if resp.status_code in (409, 412):
            raise GithubConflict(resp.status_code, resp.json().get("message", ""), resp.json())
        if resp.status_code >= 400:
            try:
                body = resp.json()
                msg = body.get("message", resp.text)
            except Exception:
                body = {}
                msg = resp.text
            raise GithubError(resp.status_code, msg, body)
        return resp

    def get_pr(self, owner: str, repo: str, number: int) -> dict[str, Any]:
        r = self._request("GET", f"/repos/{owner}/{repo}/pulls/{number}")
        return r.json()

    def list_pr_files(self, owner: str, repo: str, number: int) -> list[dict[str, Any]]:
        r = self._request("GET", f"/repos/{owner}/{repo}/pulls/{number}/files")
        return r.json()
```

- [ ] **Step 5: Run test → pass**

```bash
uv run pytest apps/github_proxy/tests/test_gateway.py -v
```

- [ ] **Step 6: Commit**

```bash
git add apps/github_proxy/gateway.py apps/github_proxy/exceptions.py apps/github_proxy/tests/
git commit -m "feat(github_proxy): GithubGateway with PR fetch and file list"
```

---

### Task 9: Workspace model + service

**Files:**
- Create: `apps/workspaces/models.py`
- Create: `apps/workspaces/services.py`
- Create: `apps/workspaces/tests/__init__.py`
- Create: `apps/workspaces/tests/test_models.py`
- Create: `apps/workspaces/tests/test_services.py`

- [ ] **Step 1: Write failing test `apps/workspaces/tests/test_models.py`**

```python
import pytest

from apps.identity.models import User
from apps.workspaces.models import Workspace


@pytest.mark.django_db
def test_workspace_unique_per_pr():
    u = User.objects.create(github_login="alice", github_user_id=1)
    Workspace.objects.create(
        repo_owner="o", repo_name="r", pr_number=1, created_by=u
    )
    with pytest.raises(Exception):
        Workspace.objects.create(
            repo_owner="o", repo_name="r", pr_number=1, created_by=u
        )
```

- [ ] **Step 2: Run test → fail**

```bash
uv run pytest apps/workspaces/tests/test_models.py -v
```

- [ ] **Step 3: Write `apps/workspaces/models.py`**

```python
from django.db import models

from apps.identity.models import User


class Workspace(models.Model):
    repo_owner = models.CharField(max_length=255)
    repo_name = models.CharField(max_length=255)
    pr_number = models.IntegerField()
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="created_workspaces")
    created_at = models.DateTimeField(auto_now_add=True)
    archived_at = models.DateTimeField(null=True, blank=True)
    last_active_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "workspace"
        constraints = [
            models.UniqueConstraint(
                fields=["repo_owner", "repo_name", "pr_number"],
                name="uniq_workspace_pr",
            )
        ]

    @property
    def repo_full_name(self) -> str:
        return f"{self.repo_owner}/{self.repo_name}"
```

- [ ] **Step 4: Generate + apply migration**

```bash
uv run python manage.py makemigrations workspaces
uv run python manage.py migrate
```

- [ ] **Step 5: Write failing test `apps/workspaces/tests/test_services.py`**

```python
from unittest.mock import MagicMock

import pytest

from apps.identity.models import User
from apps.workspaces.services import create_workspace, WorkspaceConflictError


@pytest.mark.django_db
def test_create_workspace_verifies_pr_and_persists():
    u = User.objects.create(github_login="alice", github_user_id=1)
    gateway = MagicMock()
    gateway.get_pr.return_value = {"number": 1, "user": {"login": "alice"}}

    ws = create_workspace(
        gateway=gateway,
        user=u,
        repo_owner="o",
        repo_name="r",
        pr_number=1,
    )
    assert ws.id is not None
    gateway.get_pr.assert_called_once_with("o", "r", 1)


@pytest.mark.django_db
def test_create_workspace_rejects_duplicate():
    u = User.objects.create(github_login="alice", github_user_id=1)
    gateway = MagicMock()
    gateway.get_pr.return_value = {"number": 1, "user": {"login": "alice"}}

    create_workspace(gateway=gateway, user=u, repo_owner="o", repo_name="r", pr_number=1)
    with pytest.raises(WorkspaceConflictError):
        create_workspace(gateway=gateway, user=u, repo_owner="o", repo_name="r", pr_number=1)
```

- [ ] **Step 6: Run test → fail**

```bash
uv run pytest apps/workspaces/tests/test_services.py -v
```

- [ ] **Step 7: Write `apps/workspaces/services.py`**

```python
from django.db import IntegrityError, transaction

from apps.github_proxy.gateway import GithubGateway
from apps.identity.models import User
from apps.workspaces.models import Workspace


class WorkspaceConflictError(Exception):
    """Workspace for this PR already exists."""


@transaction.atomic
def create_workspace(
    *,
    gateway: GithubGateway,
    user: User,
    repo_owner: str,
    repo_name: str,
    pr_number: int,
) -> Workspace:
    # Verify PR exists; raises GithubNotFound otherwise
    pr = gateway.get_pr(repo_owner, repo_name, pr_number)

    try:
        ws = Workspace.objects.create(
            repo_owner=repo_owner,
            repo_name=repo_name,
            pr_number=pr_number,
            created_by=user,
        )
    except IntegrityError as exc:
        raise WorkspaceConflictError(
            f"workspace for {repo_owner}/{repo_name}#{pr_number} already exists"
        ) from exc

    # PR author identity needed downstream by storyline seeding (task 18); stash on Workspace
    # via cache or return alongside? For now we expose pr.user.login via the service return,
    # the view layer handles storyline seeding after this call.
    return ws
```

- [ ] **Step 8: Run tests → pass**

```bash
uv run pytest apps/workspaces/tests/ -v
```

- [ ] **Step 9: Commit**

```bash
git add apps/workspaces/
git commit -m "feat(workspaces): Workspace model + create_workspace service"
```

---

### Task 10: Workspace REST endpoints

**Files:**
- Create: `apps/workspaces/views.py`
- Create: `apps/workspaces/serializers.py`
- Modify: `apps/workspaces/urls.py`
- Create: `apps/workspaces/tests/test_views.py`

- [ ] **Step 1: Write failing test `apps/workspaces/tests/test_views.py`**

```python
from unittest.mock import patch, MagicMock

import pytest

from apps.identity.models import User
from apps.workspaces.models import Workspace


@pytest.fixture
def authed_client(api_client, db):
    u = User.objects.create(github_login="alice", github_user_id=1)
    session = api_client.session
    session["user_id"] = u.id
    session.save()
    return api_client, u


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_create_workspace_201(MockGateway, authed_client):
    client, u = authed_client
    inst = MockGateway.return_value
    inst.get_pr.return_value = {"number": 1, "user": {"login": "alice"}}

    resp = client.post(
        "/api/workspaces",
        data={"repo_owner": "o", "repo_name": "r", "pr_number": 1},
        format="json",
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["repo_owner"] == "o"
    assert body["pr_number"] == 1
    assert Workspace.objects.filter(pr_number=1).exists()


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_create_workspace_404_when_pr_missing(MockGateway, authed_client):
    client, _ = authed_client
    from apps.github_proxy.exceptions import GithubNotFound
    inst = MockGateway.return_value
    inst.get_pr.side_effect = GithubNotFound(404, "Not Found")

    resp = client.post(
        "/api/workspaces",
        data={"repo_owner": "o", "repo_name": "r", "pr_number": 999},
        format="json",
    )
    assert resp.status_code == 404


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_create_workspace_409_duplicate(MockGateway, authed_client):
    client, u = authed_client
    inst = MockGateway.return_value
    inst.get_pr.return_value = {"number": 1, "user": {"login": "alice"}}

    Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)

    resp = client.post(
        "/api/workspaces",
        data={"repo_owner": "o", "repo_name": "r", "pr_number": 1},
        format="json",
    )
    assert resp.status_code == 409


@pytest.mark.django_db
def test_list_workspaces(authed_client):
    client, u = authed_client
    Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    resp = client.get("/api/workspaces")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_get_workspace_includes_mode(MockGateway, authed_client):
    client, u = authed_client
    inst = MockGateway.return_value
    inst.get_pr.return_value = {"number": 1, "user": {"login": "alice"}}
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    resp = client.get(f"/api/workspaces/{ws.id}")
    assert resp.status_code == 200
    assert resp.json()["mode"] == "author"  # alice == pr author


@pytest.mark.django_db
def test_archive_workspace(authed_client):
    client, u = authed_client
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    resp = client.delete(f"/api/workspaces/{ws.id}")
    assert resp.status_code == 204
    ws.refresh_from_db()
    assert ws.archived_at is not None


@pytest.mark.django_db
def test_unauth_returns_401(api_client):
    resp = api_client.get("/api/workspaces")
    assert resp.status_code == 401
```

- [ ] **Step 2: Run test → fail**

```bash
uv run pytest apps/workspaces/tests/test_views.py -v
```

- [ ] **Step 3: Write `apps/workspaces/serializers.py`**

```python
from rest_framework import serializers

from apps.workspaces.models import Workspace


class CreateWorkspaceSerializer(serializers.Serializer):
    repo_owner = serializers.CharField(max_length=255)
    repo_name = serializers.CharField(max_length=255)
    pr_number = serializers.IntegerField(min_value=1)


class WorkspaceSerializer(serializers.ModelSerializer):
    class Meta:
        model = Workspace
        fields = [
            "id", "repo_owner", "repo_name", "pr_number",
            "created_at", "archived_at", "last_active_at",
        ]
```

- [ ] **Step 4: Write `apps/workspaces/views.py`**

```python
from django.conf import settings
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.response import Response

from apps.github_proxy.exceptions import GithubNotFound
from apps.github_proxy.gateway import GithubGateway
from apps.workspaces.models import Workspace
from apps.workspaces.serializers import CreateWorkspaceSerializer, WorkspaceSerializer
from apps.workspaces.services import WorkspaceConflictError, create_workspace


def _gateway() -> GithubGateway:
    return GithubGateway(token=settings.GITHUB_ADMIN_PAT)


def _compute_mode(workspace: Workspace, current_user_login: str, gateway: GithubGateway) -> str:
    pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
    return "author" if pr["user"]["login"] == current_user_login else "reviewer"


@api_view(["GET", "POST"])
def workspaces_list_or_create(request):
    if request.method == "GET":
        qs = (
            Workspace.objects.filter(archived_at__isnull=True)
            .filter(created_by=request.user)
            .order_by("-last_active_at")
        )
        return Response(WorkspaceSerializer(qs, many=True).data)

    serializer = CreateWorkspaceSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    g = _gateway()
    try:
        ws = create_workspace(gateway=g, user=request.user, **serializer.validated_data)
    except GithubNotFound:
        return Response({"error": {"code": "pr_not_found"}}, status=status.HTTP_404_NOT_FOUND)
    except WorkspaceConflictError:
        return Response({"error": {"code": "workspace_exists"}}, status=status.HTTP_409_CONFLICT)
    finally:
        g.close()
    return Response(WorkspaceSerializer(ws).data, status=status.HTTP_201_CREATED)


@api_view(["GET", "DELETE"])
def workspace_detail(request, workspace_id: int):
    ws = get_object_or_404(Workspace, pk=workspace_id, archived_at__isnull=True)
    if request.method == "DELETE":
        ws.archived_at = timezone.now()
        ws.save(update_fields=["archived_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    g = _gateway()
    try:
        mode = _compute_mode(ws, request.user.github_login, g)
    finally:
        g.close()
    data = WorkspaceSerializer(ws).data
    data["mode"] = mode
    return Response(data)
```

- [ ] **Step 5: Update `apps/workspaces/urls.py`**

```python
from django.urls import path

from apps.workspaces import views

urlpatterns = [
    path("workspaces", views.workspaces_list_or_create),
    path("workspaces/<int:workspace_id>", views.workspace_detail),
]
```

- [ ] **Step 6: Disable CSRF for API routes in dev**

Add to `local_review/settings/dev.py`:

```python
REST_FRAMEWORK = {  # noqa: F811
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "apps.identity.auth.SessionUserAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
}
```

(DRF's `SessionAuthentication` is the one that enforces CSRF; our custom class doesn't, so we're fine.)

- [ ] **Step 7: Run tests → pass**

```bash
uv run pytest apps/workspaces/tests/ -v
```

- [ ] **Step 8: Commit**

```bash
git add apps/workspaces/ local_review/settings/dev.py
git commit -m "feat(workspaces): REST endpoints for create/list/get/archive"
```

---

## Phase 3 · Storyline

### Task 11: Storyline + StorylineFile models

**Files:**
- Modify: `apps/workspaces/models.py` (add Storyline + StorylineFile)
- Modify: `apps/workspaces/tests/test_models.py` (add storyline tests)

- [ ] **Step 1: Append failing tests to `apps/workspaces/tests/test_models.py`**

```python
import uuid

from apps.workspaces.models import Storyline, StorylineFile


@pytest.mark.django_db
def test_storyline_one_per_workspace():
    u = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    Storyline.objects.create(workspace=ws, raw_json="{}", etag=str(uuid.uuid4()), updated_by=u)
    with pytest.raises(Exception):
        Storyline.objects.create(workspace=ws, raw_json="{}", etag=str(uuid.uuid4()), updated_by=u)


@pytest.mark.django_db
def test_storyline_file_unique_path_per_storyline():
    u = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    s = Storyline.objects.create(workspace=ws, raw_json="{}", etag=str(uuid.uuid4()), updated_by=u)
    StorylineFile.objects.create(storyline=s, diff_file_path="a.py", order_index=0)
    with pytest.raises(Exception):
        StorylineFile.objects.create(storyline=s, diff_file_path="a.py", order_index=1)
```

- [ ] **Step 2: Run test → fail**

```bash
uv run pytest apps/workspaces/tests/test_models.py -v
```

- [ ] **Step 3: Append models to `apps/workspaces/models.py`**

```python
class Storyline(models.Model):
    workspace = models.OneToOneField(Workspace, on_delete=models.CASCADE, related_name="storyline")
    raw_json = models.TextField(default="{}")
    etag = models.CharField(max_length=36)  # uuid str
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="storyline_updates")

    class Meta:
        db_table = "storyline"


class StorylineFile(models.Model):
    storyline = models.ForeignKey(Storyline, on_delete=models.CASCADE, related_name="files")
    diff_file_path = models.CharField(max_length=1024)
    order_index = models.IntegerField()
    intro_text = models.TextField(blank=True, default="")

    class Meta:
        db_table = "storyline_file"
        ordering = ["order_index"]
        constraints = [
            models.UniqueConstraint(
                fields=["storyline", "diff_file_path"],
                name="uniq_storyline_file_path",
            )
        ]
```

- [ ] **Step 4: Migrate + run tests**

```bash
uv run python manage.py makemigrations workspaces
uv run python manage.py migrate
uv run pytest apps/workspaces/tests/test_models.py -v
```

- [ ] **Step 5: Commit**

```bash
git add apps/workspaces/models.py apps/workspaces/migrations apps/workspaces/tests/test_models.py
git commit -m "feat(workspaces): Storyline and StorylineFile models"
```

---

### Task 12: Storyline service (read + write with ETag)

**Files:**
- Create: `apps/workspaces/storyline_service.py`
- Create: `apps/workspaces/tests/test_storyline_service.py`

- [ ] **Step 1: Write failing test `apps/workspaces/tests/test_storyline_service.py`**

```python
import json

import pytest

from apps.identity.models import User
from apps.workspaces.models import Storyline, StorylineFile, Workspace
from apps.workspaces.storyline_service import (
    StorylineETagMismatch,
    StorylineNotAuthor,
    read_storyline,
    seed_empty_storyline,
    write_storyline,
)


@pytest.fixture
def author_workspace(db):
    author = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=author)
    return ws, author


def test_seed_empty_creates_rows(author_workspace):
    ws, author = author_workspace
    files = [{"filename": "a.py"}, {"filename": "b.py"}]
    storyline = seed_empty_storyline(ws, author, files)
    assert storyline.workspace_id == ws.id
    assert StorylineFile.objects.filter(storyline=storyline).count() == 2


def test_read_returns_etag_and_files(author_workspace):
    ws, author = author_workspace
    seed_empty_storyline(ws, author, [{"filename": "a.py"}])
    data, etag = read_storyline(ws)
    assert etag is not None
    assert data["files"][0]["diff_file_path"] == "a.py"


def test_write_storyline_bumps_etag(author_workspace):
    ws, author = author_workspace
    seed_empty_storyline(ws, author, [{"filename": "a.py"}])
    _, old_etag = read_storyline(ws)
    new_files = [
        {"diff_file_path": "a.py", "order_index": 0, "intro_text": "hello"},
    ]
    new_etag = write_storyline(
        ws, author, pr_author_login="alice",
        files=new_files, if_match=old_etag,
    )
    assert new_etag != old_etag
    s = Storyline.objects.get(workspace=ws)
    assert s.files.first().intro_text == "hello"


def test_write_rejects_non_author(author_workspace):
    ws, author = author_workspace
    seed_empty_storyline(ws, author, [{"filename": "a.py"}])
    bob = User.objects.create(github_login="bob", github_user_id=2)
    _, etag = read_storyline(ws)
    with pytest.raises(StorylineNotAuthor):
        write_storyline(
            ws, bob, pr_author_login="alice",
            files=[{"diff_file_path": "a.py", "order_index": 0}], if_match=etag,
        )


def test_write_rejects_stale_etag(author_workspace):
    ws, author = author_workspace
    seed_empty_storyline(ws, author, [{"filename": "a.py"}])
    with pytest.raises(StorylineETagMismatch):
        write_storyline(
            ws, author, pr_author_login="alice",
            files=[{"diff_file_path": "a.py", "order_index": 0}],
            if_match="wrong-etag",
        )
```

- [ ] **Step 2: Run test → fail**

```bash
uv run pytest apps/workspaces/tests/test_storyline_service.py -v
```

- [ ] **Step 3: Write `apps/workspaces/storyline_service.py`**

```python
import json
import uuid

from django.db import transaction

from apps.identity.models import User
from apps.workspaces.models import Storyline, StorylineFile, Workspace


class StorylineNotAuthor(Exception):
    pass


class StorylineETagMismatch(Exception):
    pass


def _new_etag() -> str:
    return str(uuid.uuid4())


def seed_empty_storyline(workspace: Workspace, author: User, pr_files: list[dict]) -> Storyline:
    with transaction.atomic():
        storyline = Storyline.objects.create(
            workspace=workspace,
            raw_json=json.dumps({"files": []}),
            etag=_new_etag(),
            updated_by=author,
        )
        rows = [
            StorylineFile(
                storyline=storyline,
                diff_file_path=f["filename"],
                order_index=idx,
                intro_text="",
            )
            for idx, f in enumerate(pr_files)
        ]
        StorylineFile.objects.bulk_create(rows)
        storyline.raw_json = json.dumps({
            "files": [
                {"diff_file_path": r.diff_file_path, "order_index": r.order_index, "intro_text": ""}
                for r in rows
            ]
        })
        storyline.save(update_fields=["raw_json"])
    return storyline


def read_storyline(workspace: Workspace) -> tuple[dict, str]:
    s = Storyline.objects.select_related().prefetch_related("files").get(workspace=workspace)
    return (
        {
            "raw_json": s.raw_json,
            "files": [
                {
                    "id": f.id,
                    "diff_file_path": f.diff_file_path,
                    "order_index": f.order_index,
                    "intro_text": f.intro_text,
                }
                for f in s.files.all()
            ],
        },
        s.etag,
    )


def write_storyline(
    workspace: Workspace,
    user: User,
    *,
    pr_author_login: str,
    files: list[dict],
    if_match: str,
) -> str:
    if user.github_login != pr_author_login:
        raise StorylineNotAuthor()

    with transaction.atomic():
        s = Storyline.objects.select_for_update().get(workspace=workspace)
        if s.etag != if_match:
            raise StorylineETagMismatch()

        StorylineFile.objects.filter(storyline=s).delete()
        StorylineFile.objects.bulk_create(
            [
                StorylineFile(
                    storyline=s,
                    diff_file_path=f["diff_file_path"],
                    order_index=f.get("order_index", idx),
                    intro_text=f.get("intro_text", ""),
                )
                for idx, f in enumerate(files)
            ]
        )
        s.raw_json = json.dumps({"files": files})
        s.etag = _new_etag()
        s.updated_by = user
        s.save(update_fields=["raw_json", "etag", "updated_by", "updated_at"])
    return s.etag
```

- [ ] **Step 4: Run tests → pass**

```bash
uv run pytest apps/workspaces/tests/test_storyline_service.py -v
```

- [ ] **Step 5: Commit**

```bash
git add apps/workspaces/storyline_service.py apps/workspaces/tests/test_storyline_service.py
git commit -m "feat(workspaces): storyline read/write service with ETag concurrency"
```

---

### Task 13: Storyline REST endpoints

**Files:**
- Modify: `apps/workspaces/views.py` (add storyline views)
- Modify: `apps/workspaces/urls.py` (add storyline routes)
- Create: `apps/workspaces/tests/test_storyline_views.py`

- [ ] **Step 1: Write failing test `apps/workspaces/tests/test_storyline_views.py`**

```python
from unittest.mock import patch

import pytest

from apps.identity.models import User
from apps.workspaces.models import Workspace
from apps.workspaces.storyline_service import seed_empty_storyline


@pytest.fixture
def author_setup(api_client, db):
    author = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=author)
    seed_empty_storyline(ws, author, [{"filename": "a.py"}, {"filename": "b.py"}])
    session = api_client.session
    session["user_id"] = author.id
    session.save()
    return api_client, ws


@pytest.mark.django_db
def test_get_storyline_returns_etag_header(author_setup):
    client, ws = author_setup
    resp = client.get(f"/api/workspaces/{ws.id}/storyline")
    assert resp.status_code == 200
    assert "ETag" in resp.headers
    body = resp.json()
    assert len(body["files"]) == 2


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_put_storyline_author_only(MockGateway, author_setup):
    client, ws = author_setup
    MockGateway.return_value.get_pr.return_value = {"user": {"login": "alice"}}

    get_resp = client.get(f"/api/workspaces/{ws.id}/storyline")
    etag = get_resp.headers["ETag"]
    resp = client.put(
        f"/api/workspaces/{ws.id}/storyline",
        data={"files": [{"diff_file_path": "a.py", "order_index": 0, "intro_text": "x"}]},
        format="json",
        HTTP_IF_MATCH=etag,
    )
    assert resp.status_code == 200
    assert resp.headers["ETag"] != etag


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_put_storyline_412_without_if_match(MockGateway, author_setup):
    client, ws = author_setup
    MockGateway.return_value.get_pr.return_value = {"user": {"login": "alice"}}
    resp = client.put(
        f"/api/workspaces/{ws.id}/storyline",
        data={"files": []},
        format="json",
    )
    assert resp.status_code == 412


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_put_storyline_409_on_etag_mismatch(MockGateway, author_setup):
    client, ws = author_setup
    MockGateway.return_value.get_pr.return_value = {"user": {"login": "alice"}}
    resp = client.put(
        f"/api/workspaces/{ws.id}/storyline",
        data={"files": []},
        format="json",
        HTTP_IF_MATCH="stale-etag",
    )
    assert resp.status_code == 409


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_put_storyline_403_for_non_author(MockGateway, api_client, db):
    bob = User.objects.create(github_login="bob", github_user_id=2)
    author = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=author)
    seed_empty_storyline(ws, author, [{"filename": "a.py"}])

    session = api_client.session
    session["user_id"] = bob.id
    session.save()

    MockGateway.return_value.get_pr.return_value = {"user": {"login": "alice"}}

    get_resp = api_client.get(f"/api/workspaces/{ws.id}/storyline")
    etag = get_resp.headers["ETag"]
    resp = api_client.put(
        f"/api/workspaces/{ws.id}/storyline",
        data={"files": []},
        format="json",
        HTTP_IF_MATCH=etag,
    )
    assert resp.status_code == 403
```

- [ ] **Step 2: Run test → fail**

```bash
uv run pytest apps/workspaces/tests/test_storyline_views.py -v
```

- [ ] **Step 3: Append to `apps/workspaces/views.py`**

```python
from apps.workspaces.storyline_service import (
    StorylineETagMismatch,
    StorylineNotAuthor,
    read_storyline,
    write_storyline,
)


@api_view(["GET", "PUT"])
def storyline_detail(request, workspace_id: int):
    ws = get_object_or_404(Workspace, pk=workspace_id, archived_at__isnull=True)
    if request.method == "GET":
        data, etag = read_storyline(ws)
        resp = Response(data)
        resp["ETag"] = etag
        return resp

    if_match = request.headers.get("If-Match")
    if not if_match:
        return Response(
            {"error": {"code": "if_match_required"}},
            status=status.HTTP_412_PRECONDITION_FAILED,
        )

    files = request.data.get("files", [])
    g = _gateway()
    try:
        pr = g.get_pr(ws.repo_owner, ws.repo_name, ws.pr_number)
    finally:
        g.close()
    try:
        new_etag = write_storyline(
            ws, request.user,
            pr_author_login=pr["user"]["login"],
            files=files, if_match=if_match,
        )
    except StorylineNotAuthor:
        return Response(
            {"error": {"code": "not_pr_author"}}, status=status.HTTP_403_FORBIDDEN
        )
    except StorylineETagMismatch:
        return Response(
            {"error": {"code": "etag_mismatch"}}, status=status.HTTP_409_CONFLICT
        )

    data, _ = read_storyline(ws)
    resp = Response(data)
    resp["ETag"] = new_etag
    return resp
```

- [ ] **Step 4: Append route to `apps/workspaces/urls.py`**

```python
path("workspaces/<int:workspace_id>/storyline", views.storyline_detail),
```

- [ ] **Step 5: Run tests → pass**

```bash
uv run pytest apps/workspaces/tests/test_storyline_views.py -v
```

- [ ] **Step 6: Commit**

```bash
git add apps/workspaces/views.py apps/workspaces/urls.py apps/workspaces/tests/test_storyline_views.py
git commit -m "feat(workspaces): storyline GET/PUT endpoints with ETag"
```

---

### Task 14: Seed storyline on author-mode workspace creation

**Files:**
- Modify: `apps/workspaces/services.py` (call seed when author)
- Modify: `apps/workspaces/views.py` (pass file list)
- Modify: `apps/workspaces/tests/test_services.py` (assert seeding behavior)

- [ ] **Step 1: Append failing test**

```python
from apps.workspaces.models import Storyline


@pytest.mark.django_db
def test_create_workspace_seeds_storyline_for_author():
    u = User.objects.create(github_login="alice", github_user_id=1)
    gateway = MagicMock()
    gateway.get_pr.return_value = {"number": 1, "user": {"login": "alice"}}
    gateway.list_pr_files.return_value = [{"filename": "x.py"}, {"filename": "y.py"}]

    ws = create_workspace(
        gateway=gateway, user=u, repo_owner="o", repo_name="r", pr_number=1,
    )
    assert Storyline.objects.filter(workspace=ws).exists()
    assert Storyline.objects.get(workspace=ws).files.count() == 2


@pytest.mark.django_db
def test_create_workspace_does_not_seed_for_reviewer():
    bob = User.objects.create(github_login="bob", github_user_id=2)
    gateway = MagicMock()
    gateway.get_pr.return_value = {"number": 1, "user": {"login": "alice"}}
    gateway.list_pr_files.return_value = [{"filename": "x.py"}]

    ws = create_workspace(
        gateway=gateway, user=bob, repo_owner="o", repo_name="r", pr_number=1,
    )
    assert not Storyline.objects.filter(workspace=ws).exists()
```

- [ ] **Step 2: Run test → fail**

```bash
uv run pytest apps/workspaces/tests/test_services.py -v -k "seeds"
```

- [ ] **Step 3: Update `apps/workspaces/services.py`**

```python
from apps.workspaces.storyline_service import seed_empty_storyline


@transaction.atomic
def create_workspace(
    *,
    gateway: GithubGateway,
    user: User,
    repo_owner: str,
    repo_name: str,
    pr_number: int,
) -> Workspace:
    pr = gateway.get_pr(repo_owner, repo_name, pr_number)
    try:
        ws = Workspace.objects.create(
            repo_owner=repo_owner,
            repo_name=repo_name,
            pr_number=pr_number,
            created_by=user,
        )
    except IntegrityError as exc:
        raise WorkspaceConflictError() from exc

    if pr["user"]["login"] == user.github_login:
        pr_files = gateway.list_pr_files(repo_owner, repo_name, pr_number)
        seed_empty_storyline(ws, user, pr_files)
    return ws
```

- [ ] **Step 4: Run tests → pass**

```bash
uv run pytest apps/workspaces/tests/ -v
```

- [ ] **Step 5: Commit**

```bash
git add apps/workspaces/services.py apps/workspaces/tests/test_services.py
git commit -m "feat(workspaces): seed empty storyline when author creates workspace"
```

---

### Task 15: AIAnalysisDoc + AIAnalysisFile (data layer only)

Same pattern as Storyline. This task adds the models so the next plan can extend with endpoints if needed.

**Files:**
- Modify: `apps/workspaces/models.py` (append AI doc models)
- Modify: `apps/workspaces/tests/test_models.py` (assert constraints)

- [ ] **Step 1: Append test**

```python
from apps.workspaces.models import AIAnalysisDoc, AIAnalysisFile


@pytest.mark.django_db
def test_ai_doc_one_per_workspace():
    u = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    AIAnalysisDoc.objects.create(workspace=ws, raw_content="x", ingested_by=u)
    with pytest.raises(Exception):
        AIAnalysisDoc.objects.create(workspace=ws, raw_content="y", ingested_by=u)
```

- [ ] **Step 2: Append models to `apps/workspaces/models.py`**

```python
class AIAnalysisDoc(models.Model):
    workspace = models.OneToOneField(
        Workspace, on_delete=models.CASCADE, related_name="ai_analysis_doc"
    )
    raw_content = models.TextField()
    ingested_at = models.DateTimeField(auto_now_add=True)
    ingested_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="ai_doc_ingests")
    source_label = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        db_table = "ai_analysis_doc"


class AIAnalysisFile(models.Model):
    ai_doc = models.ForeignKey(AIAnalysisDoc, on_delete=models.CASCADE, related_name="files")
    diff_file_path = models.CharField(max_length=1024)
    sections_json = models.JSONField()

    class Meta:
        db_table = "ai_analysis_file"
        constraints = [
            models.UniqueConstraint(
                fields=["ai_doc", "diff_file_path"],
                name="uniq_ai_doc_file_path",
            )
        ]
```

- [ ] **Step 3: Migrate + run tests**

```bash
uv run python manage.py makemigrations workspaces
uv run python manage.py migrate
uv run pytest apps/workspaces/tests/test_models.py -v
```

- [ ] **Step 4: Commit**

```bash
git add apps/workspaces/models.py apps/workspaces/migrations apps/workspaces/tests/test_models.py
git commit -m "feat(workspaces): AIAnalysisDoc and AIAnalysisFile models"
```

---

## Phase 4 · Intro comments

### Task 16: IntroComment model

**Files:**
- Modify: `apps/workspaces/models.py` (append IntroComment)
- Modify: `apps/workspaces/tests/test_models.py`

- [ ] **Step 1: Append failing test**

```python
from apps.workspaces.models import IntroComment


@pytest.mark.django_db
def test_intro_comment_thread():
    u = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    s = seed_empty_storyline(ws, u, [{"filename": "a.py"}])
    sf = s.files.first()

    top = IntroComment.objects.create(storyline_file=sf, user=u, body="root")
    reply = IntroComment.objects.create(storyline_file=sf, user=u, parent=top, body="reply")
    assert reply.parent == top
    assert top.replies.first() == reply
```

(Import `seed_empty_storyline` and `User` if not already in scope.)

- [ ] **Step 2: Append `IntroComment` to `apps/workspaces/models.py`**

```python
class IntroComment(models.Model):
    storyline_file = models.ForeignKey(
        StorylineFile, on_delete=models.CASCADE, related_name="intro_comments"
    )
    user = models.ForeignKey(User, on_delete=models.PROTECT, related_name="intro_comments")
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.CASCADE, related_name="replies"
    )
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    resolved_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="resolved_intro_comments",
    )
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "intro_comment"
        ordering = ["created_at"]
```

- [ ] **Step 3: Migrate + run tests**

```bash
uv run python manage.py makemigrations workspaces
uv run python manage.py migrate
uv run pytest apps/workspaces/tests/test_models.py -v
```

- [ ] **Step 4: Commit**

```bash
git add apps/workspaces/models.py apps/workspaces/migrations apps/workspaces/tests/test_models.py
git commit -m "feat(workspaces): IntroComment model with threading + soft-delete + resolve"
```

---

### Task 17: IntroComment CRUD endpoints

**Files:**
- Create: `apps/workspaces/intro_comment_service.py`
- Modify: `apps/workspaces/views.py` (intro comment views)
- Modify: `apps/workspaces/urls.py`
- Create: `apps/workspaces/tests/test_intro_comments.py`

- [ ] **Step 1: Write failing test**

```python
from unittest.mock import patch
import pytest

from apps.identity.models import User
from apps.workspaces.models import IntroComment, Workspace
from apps.workspaces.storyline_service import seed_empty_storyline


@pytest.fixture
def setup(api_client, db):
    author = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=author)
    s = seed_empty_storyline(ws, author, [{"filename": "a.py"}])
    sf = s.files.first()
    session = api_client.session
    session["user_id"] = author.id
    session.save()
    return api_client, ws, sf, author


@pytest.mark.django_db
def test_post_intro_comment(setup):
    client, ws, sf, _ = setup
    resp = client.post(
        f"/api/workspaces/{ws.id}/intro-comments",
        data={"storyline_file_id": sf.id, "body": "hi"},
        format="json",
    )
    assert resp.status_code == 201
    assert IntroComment.objects.count() == 1


@pytest.mark.django_db
def test_get_intro_comments_filtered_by_file(setup):
    client, ws, sf, author = setup
    IntroComment.objects.create(storyline_file=sf, user=author, body="x")
    resp = client.get(
        f"/api/workspaces/{ws.id}/intro-comments?file_id={sf.id}"
    )
    assert resp.status_code == 200
    assert len(resp.json()) == 1


@pytest.mark.django_db
def test_patch_intro_comment_owner_only(setup):
    client, ws, sf, author = setup
    bob = User.objects.create(github_login="bob", github_user_id=2)
    ic = IntroComment.objects.create(storyline_file=sf, user=bob, body="x")
    resp = client.patch(f"/api/intro-comments/{ic.id}", data={"body": "y"}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_delete_intro_comment_soft(setup):
    client, ws, sf, author = setup
    ic = IntroComment.objects.create(storyline_file=sf, user=author, body="x")
    resp = client.delete(f"/api/intro-comments/{ic.id}")
    assert resp.status_code == 204
    ic.refresh_from_db()
    assert ic.deleted_at is not None


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_resolve_author_only(MockGateway, setup):
    client, ws, sf, author = setup
    MockGateway.return_value.get_pr.return_value = {"user": {"login": "alice"}}
    ic = IntroComment.objects.create(storyline_file=sf, user=author, body="x")
    resp = client.post(f"/api/intro-comments/{ic.id}/resolve")
    assert resp.status_code == 200
    ic.refresh_from_db()
    assert ic.resolved_at is not None


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_resolve_403_for_non_author(MockGateway, api_client, db):
    author = User.objects.create(github_login="alice", github_user_id=1)
    bob = User.objects.create(github_login="bob", github_user_id=2)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=author)
    s = seed_empty_storyline(ws, author, [{"filename": "a.py"}])
    sf = s.files.first()
    ic = IntroComment.objects.create(storyline_file=sf, user=author, body="x")

    session = api_client.session
    session["user_id"] = bob.id
    session.save()
    MockGateway.return_value.get_pr.return_value = {"user": {"login": "alice"}}

    resp = api_client.post(f"/api/intro-comments/{ic.id}/resolve")
    assert resp.status_code == 403
```

- [ ] **Step 2: Run → fail**

```bash
uv run pytest apps/workspaces/tests/test_intro_comments.py -v
```

- [ ] **Step 3: Append intro-comment views to `apps/workspaces/views.py`**

```python
from django.utils import timezone

from apps.workspaces.models import IntroComment, StorylineFile


def _serialize_intro(ic: IntroComment) -> dict:
    return {
        "id": ic.id,
        "storyline_file_id": ic.storyline_file_id,
        "parent_id": ic.parent_id,
        "user": {"id": ic.user_id, "github_login": ic.user.github_login},
        "body": ic.body,
        "created_at": ic.created_at.isoformat(),
        "updated_at": ic.updated_at.isoformat(),
        "deleted_at": ic.deleted_at.isoformat() if ic.deleted_at else None,
        "resolved_at": ic.resolved_at.isoformat() if ic.resolved_at else None,
    }


@api_view(["GET", "POST"])
def intro_comments_list_or_create(request, workspace_id: int):
    ws = get_object_or_404(Workspace, pk=workspace_id, archived_at__isnull=True)
    if request.method == "GET":
        file_id = request.query_params.get("file_id")
        qs = IntroComment.objects.select_related("user").filter(
            storyline_file__storyline__workspace=ws,
            deleted_at__isnull=True,
        )
        if file_id:
            qs = qs.filter(storyline_file_id=file_id)
        return Response([_serialize_intro(ic) for ic in qs])

    body = request.data.get("body", "").strip()
    sf_id = request.data.get("storyline_file_id")
    parent_id = request.data.get("parent_id")
    if not body or not sf_id:
        return Response({"error": {"code": "invalid_input"}}, status=400)
    sf = get_object_or_404(StorylineFile, pk=sf_id, storyline__workspace=ws)
    ic = IntroComment.objects.create(
        storyline_file=sf, user=request.user, parent_id=parent_id, body=body
    )
    return Response(_serialize_intro(ic), status=201)


@api_view(["PATCH", "DELETE"])
def intro_comment_detail(request, comment_id: int):
    ic = get_object_or_404(IntroComment, pk=comment_id)
    if ic.user_id != request.user.id:
        return Response({"error": {"code": "not_owner"}}, status=403)
    if request.method == "DELETE":
        ic.deleted_at = timezone.now()
        ic.save(update_fields=["deleted_at"])
        return Response(status=204)
    new_body = request.data.get("body", "").strip()
    if not new_body:
        return Response({"error": {"code": "invalid_input"}}, status=400)
    ic.body = new_body
    ic.save(update_fields=["body", "updated_at"])
    return Response(_serialize_intro(ic))


def _is_pr_author(user, workspace: Workspace) -> bool:
    g = _gateway()
    try:
        pr = g.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
    finally:
        g.close()
    return user.github_login == pr["user"]["login"]


@api_view(["POST"])
def intro_comment_resolve(request, comment_id: int):
    ic = get_object_or_404(IntroComment, pk=comment_id)
    ws = ic.storyline_file.storyline.workspace
    if not _is_pr_author(request.user, ws):
        return Response({"error": {"code": "not_pr_author"}}, status=403)
    ic.resolved_by = request.user
    ic.resolved_at = timezone.now()
    ic.save(update_fields=["resolved_by", "resolved_at"])
    return Response(_serialize_intro(ic))


@api_view(["POST"])
def intro_comment_unresolve(request, comment_id: int):
    ic = get_object_or_404(IntroComment, pk=comment_id)
    ws = ic.storyline_file.storyline.workspace
    if not _is_pr_author(request.user, ws):
        return Response({"error": {"code": "not_pr_author"}}, status=403)
    ic.resolved_by = None
    ic.resolved_at = None
    ic.save(update_fields=["resolved_by", "resolved_at"])
    return Response(_serialize_intro(ic))
```

- [ ] **Step 4: Append routes to `apps/workspaces/urls.py`**

```python
path("workspaces/<int:workspace_id>/intro-comments", views.intro_comments_list_or_create),
path("intro-comments/<int:comment_id>", views.intro_comment_detail),
path("intro-comments/<int:comment_id>/resolve", views.intro_comment_resolve),
path("intro-comments/<int:comment_id>/unresolve", views.intro_comment_unresolve),
```

- [ ] **Step 5: Run tests → pass**

```bash
uv run pytest apps/workspaces/tests/test_intro_comments.py -v
```

- [ ] **Step 6: Commit**

```bash
git add apps/workspaces/views.py apps/workspaces/urls.py apps/workspaces/tests/test_intro_comments.py
git commit -m "feat(workspaces): IntroComment CRUD + resolve/unresolve endpoints"
```

---

## Phase 5 · AI doc

### Task 18: AI doc parser + REST endpoints

**Files:**
- Create: `apps/workspaces/ai_doc_service.py`
- Create: `apps/workspaces/tests/test_ai_doc_service.py`
- Modify: `apps/workspaces/views.py` (ai-doc views)
- Modify: `apps/workspaces/urls.py`
- Create: `apps/workspaces/tests/test_ai_doc_views.py`

- [ ] **Step 1: Write failing parser test**

```python
import pytest

from apps.identity.models import User
from apps.workspaces.ai_doc_service import (
    AIDocNotAuthor,
    ingest_ai_doc,
    parse_ai_doc,
)
from apps.workspaces.models import AIAnalysisDoc, AIAnalysisFile, Workspace
from apps.workspaces.storyline_service import seed_empty_storyline


def test_parse_ai_doc_splits_by_file_header():
    doc = """## Summary
Overall description.

## File: a.py
Concerns: x

## File: b.py
Suggestions: y
"""
    parsed = parse_ai_doc(doc)
    assert parsed["summary"] == "Overall description."
    assert "a.py" in parsed["files"]
    assert "b.py" in parsed["files"]
    assert "Concerns: x" in parsed["files"]["a.py"]


@pytest.mark.django_db
def test_ingest_ai_doc_author_only():
    author = User.objects.create(github_login="alice", github_user_id=1)
    bob = User.objects.create(github_login="bob", github_user_id=2)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=author)
    seed_empty_storyline(ws, author, [{"filename": "a.py"}])

    with pytest.raises(AIDocNotAuthor):
        ingest_ai_doc(ws, bob, pr_author_login="alice", raw_content="## File: a.py\nhi")


@pytest.mark.django_db
def test_ingest_ai_doc_replaces_prior():
    author = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=author)
    seed_empty_storyline(ws, author, [{"filename": "a.py"}])

    ingest_ai_doc(ws, author, pr_author_login="alice", raw_content="## File: a.py\nv1")
    ingest_ai_doc(ws, author, pr_author_login="alice", raw_content="## File: a.py\nv2")
    docs = AIAnalysisDoc.objects.filter(workspace=ws)
    assert docs.count() == 1
    assert "v2" in docs.first().raw_content
```

- [ ] **Step 2: Run → fail**

```bash
uv run pytest apps/workspaces/tests/test_ai_doc_service.py -v
```

- [ ] **Step 3: Write `apps/workspaces/ai_doc_service.py`**

```python
import re

from django.db import transaction

from apps.identity.models import User
from apps.workspaces.models import AIAnalysisDoc, AIAnalysisFile, Workspace


class AIDocNotAuthor(Exception):
    pass


_HEADER_RE = re.compile(r"^##\s*File:\s*(.+?)\s*$", re.MULTILINE)


def parse_ai_doc(raw: str) -> dict:
    files: dict[str, str] = {}
    summary = ""

    # Try to find summary block between "## Summary" and the first "## File:"
    summary_match = re.search(r"^##\s*Summary\s*\n(.*?)(?=^##\s)", raw, re.MULTILINE | re.DOTALL)
    if summary_match:
        summary = summary_match.group(1).strip()

    # Split by ## File: headers
    parts = _HEADER_RE.split(raw)
    # parts: [pre, filename1, body1, filename2, body2, ...]
    for i in range(1, len(parts), 2):
        fname = parts[i].strip()
        body = parts[i + 1].strip() if i + 1 < len(parts) else ""
        files[fname] = body

    return {"summary": summary, "files": files}


@transaction.atomic
def ingest_ai_doc(
    workspace: Workspace,
    user: User,
    *,
    pr_author_login: str,
    raw_content: str,
    source_label: str = "",
) -> AIAnalysisDoc:
    if user.github_login != pr_author_login:
        raise AIDocNotAuthor()

    AIAnalysisDoc.objects.filter(workspace=workspace).delete()

    doc = AIAnalysisDoc.objects.create(
        workspace=workspace,
        raw_content=raw_content,
        ingested_by=user,
        source_label=source_label,
    )

    parsed = parse_ai_doc(raw_content)
    AIAnalysisFile.objects.bulk_create([
        AIAnalysisFile(ai_doc=doc, diff_file_path=path, sections_json={"body": body})
        for path, body in parsed["files"].items()
    ])
    return doc
```

- [ ] **Step 4: Run → pass**

```bash
uv run pytest apps/workspaces/tests/test_ai_doc_service.py -v
```

- [ ] **Step 5: Write failing view test `apps/workspaces/tests/test_ai_doc_views.py`**

```python
from unittest.mock import patch
import pytest

from apps.identity.models import User
from apps.workspaces.models import AIAnalysisDoc, Workspace
from apps.workspaces.storyline_service import seed_empty_storyline


@pytest.fixture
def author_setup(api_client, db):
    author = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=author)
    seed_empty_storyline(ws, author, [{"filename": "a.py"}])
    session = api_client.session
    session["user_id"] = author.id
    session.save()
    return api_client, ws


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_post_ai_doc(MockGateway, author_setup):
    client, ws = author_setup
    MockGateway.return_value.get_pr.return_value = {"user": {"login": "alice"}}
    resp = client.post(
        f"/api/workspaces/{ws.id}/ai-doc",
        data={"raw_content": "## File: a.py\nstuff"},
        format="json",
    )
    assert resp.status_code == 201
    assert AIAnalysisDoc.objects.filter(workspace=ws).exists()


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_get_ai_doc(MockGateway, author_setup):
    client, ws = author_setup
    MockGateway.return_value.get_pr.return_value = {"user": {"login": "alice"}}
    client.post(
        f"/api/workspaces/{ws.id}/ai-doc",
        data={"raw_content": "## File: a.py\nbody"},
        format="json",
    )
    resp = client.get(f"/api/workspaces/{ws.id}/ai-doc")
    assert resp.status_code == 200
    assert resp.json()["raw_content"].startswith("## File")


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_delete_ai_doc(MockGateway, author_setup):
    client, ws = author_setup
    MockGateway.return_value.get_pr.return_value = {"user": {"login": "alice"}}
    client.post(
        f"/api/workspaces/{ws.id}/ai-doc",
        data={"raw_content": "## File: a.py\nbody"},
        format="json",
    )
    resp = client.delete(f"/api/workspaces/{ws.id}/ai-doc")
    assert resp.status_code == 204
    assert not AIAnalysisDoc.objects.filter(workspace=ws).exists()
```

- [ ] **Step 6: Run → fail**

```bash
uv run pytest apps/workspaces/tests/test_ai_doc_views.py -v
```

- [ ] **Step 7: Append AI doc view to `apps/workspaces/views.py`**

```python
from apps.workspaces.ai_doc_service import AIDocNotAuthor, ingest_ai_doc
from apps.workspaces.models import AIAnalysisDoc


@api_view(["GET", "POST", "DELETE"])
def ai_doc_detail(request, workspace_id: int):
    ws = get_object_or_404(Workspace, pk=workspace_id, archived_at__isnull=True)
    if request.method == "GET":
        try:
            doc = AIAnalysisDoc.objects.get(workspace=ws)
        except AIAnalysisDoc.DoesNotExist:
            return Response({"error": {"code": "not_ingested"}}, status=404)
        return Response({
            "raw_content": doc.raw_content,
            "ingested_at": doc.ingested_at.isoformat(),
            "source_label": doc.source_label,
            "files": [
                {"diff_file_path": f.diff_file_path, "sections": f.sections_json}
                for f in doc.files.all()
            ],
        })

    if request.method == "DELETE":
        deleted, _ = AIAnalysisDoc.objects.filter(workspace=ws).delete()
        if deleted == 0:
            return Response({"error": {"code": "not_ingested"}}, status=404)
        return Response(status=204)

    raw = request.data.get("raw_content", "")
    label = request.data.get("source_label", "")
    g = _gateway()
    try:
        pr = g.get_pr(ws.repo_owner, ws.repo_name, ws.pr_number)
    finally:
        g.close()
    try:
        doc = ingest_ai_doc(
            ws, request.user,
            pr_author_login=pr["user"]["login"],
            raw_content=raw, source_label=label,
        )
    except AIDocNotAuthor:
        return Response({"error": {"code": "not_pr_author"}}, status=403)
    return Response({"id": doc.id}, status=201)
```

- [ ] **Step 8: Append route**

```python
path("workspaces/<int:workspace_id>/ai-doc", views.ai_doc_detail),
```

- [ ] **Step 9: Run tests → pass**

```bash
uv run pytest apps/workspaces/tests/test_ai_doc_views.py -v
```

- [ ] **Step 10: Commit**

```bash
git add apps/workspaces/
git commit -m "feat(workspaces): AI-doc ingestion (parse + REST endpoints)"
```

---

## Phase 6 · Drafts + publish

### Task 19: DraftReview + DraftComment models

**Files:**
- Modify: `apps/workspaces/models.py` (append draft models)
- Modify: `apps/workspaces/tests/test_models.py`

- [ ] **Step 1: Append failing test**

```python
from apps.workspaces.models import DraftComment, DraftReview


@pytest.mark.django_db
def test_draft_review_singleton_per_user_workspace():
    u = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    DraftReview.objects.create(workspace=ws, user=u, event="COMMENT")
    with pytest.raises(Exception):
        DraftReview.objects.create(workspace=ws, user=u, event="APPROVE")


@pytest.mark.django_db
def test_draft_comment_creation():
    u = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    dc = DraftComment.objects.create(
        workspace=ws, user=u, kind="review",
        diff_file_path="a.py", line=10, side="RIGHT", body="x",
    )
    assert dc.id is not None
```

- [ ] **Step 2: Append models to `apps/workspaces/models.py`**

```python
class DraftReview(models.Model):
    EVENT_CHOICES = [
        ("COMMENT", "COMMENT"),
        ("APPROVE", "APPROVE"),
        ("REQUEST_CHANGES", "REQUEST_CHANGES"),
    ]
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="draft_reviews")
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="draft_reviews")
    body = models.TextField(blank=True, default="")
    event = models.CharField(max_length=16, choices=EVENT_CHOICES, default="COMMENT")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "draft_review"
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "user"], name="uniq_draft_review_ws_user"
            )
        ]


class DraftComment(models.Model):
    KIND_CHOICES = [("issue", "issue"), ("review", "review")]
    SIDE_CHOICES = [("LEFT", "LEFT"), ("RIGHT", "RIGHT")]

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="draft_comments")
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="draft_comments")
    draft_review = models.ForeignKey(
        DraftReview, null=True, blank=True, on_delete=models.CASCADE, related_name="draft_comments"
    )
    kind = models.CharField(max_length=8, choices=KIND_CHOICES)
    diff_file_path = models.CharField(max_length=1024, blank=True, default="")
    position = models.IntegerField(null=True, blank=True)
    line = models.IntegerField(null=True, blank=True)
    side = models.CharField(max_length=8, choices=SIDE_CHOICES, blank=True, default="")
    body = models.TextField()
    parent_comment_github_id = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "draft_comment"
```

- [ ] **Step 3: Migrate + run tests**

```bash
uv run python manage.py makemigrations workspaces
uv run python manage.py migrate
uv run pytest apps/workspaces/tests/test_models.py -v
```

- [ ] **Step 4: Commit**

```bash
git add apps/workspaces/models.py apps/workspaces/migrations apps/workspaces/tests/test_models.py
git commit -m "feat(workspaces): DraftReview and DraftComment models"
```

---

### Task 20: Draft CRUD endpoints

**Files:**
- Modify: `apps/workspaces/views.py` (drafts views)
- Modify: `apps/workspaces/urls.py`
- Create: `apps/workspaces/tests/test_drafts.py`

- [ ] **Step 1: Write failing test**

```python
import pytest

from apps.identity.models import User
from apps.workspaces.models import DraftComment, DraftReview, Workspace


@pytest.fixture
def authed(api_client, db):
    u = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    session = api_client.session
    session["user_id"] = u.id
    session.save()
    return api_client, u, ws


@pytest.mark.django_db
def test_create_draft_comment(authed):
    client, u, ws = authed
    resp = client.post(
        f"/api/workspaces/{ws.id}/drafts",
        data={"kind": "review", "diff_file_path": "a.py", "line": 1, "side": "RIGHT", "body": "x"},
        format="json",
    )
    assert resp.status_code == 201
    assert DraftComment.objects.count() == 1


@pytest.mark.django_db
def test_create_draft_attaches_review(authed):
    client, u, ws = authed
    resp = client.post(
        f"/api/workspaces/{ws.id}/drafts",
        data={
            "kind": "review", "diff_file_path": "a.py", "line": 1, "side": "RIGHT",
            "body": "x", "attach_to_review_draft": True,
        },
        format="json",
    )
    assert resp.status_code == 201
    assert DraftReview.objects.filter(workspace=ws, user=u).exists()
    dc = DraftComment.objects.get()
    assert dc.draft_review is not None


@pytest.mark.django_db
def test_list_my_drafts(authed):
    client, u, ws = authed
    DraftComment.objects.create(workspace=ws, user=u, kind="issue", body="x")
    other = User.objects.create(github_login="bob", github_user_id=2)
    DraftComment.objects.create(workspace=ws, user=other, kind="issue", body="y")
    resp = client.get(f"/api/workspaces/{ws.id}/drafts")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


@pytest.mark.django_db
def test_patch_draft_owner_only(authed):
    client, u, ws = authed
    other = User.objects.create(github_login="bob", github_user_id=2)
    dc = DraftComment.objects.create(workspace=ws, user=other, kind="issue", body="x")
    resp = client.patch(f"/api/drafts/{dc.id}", data={"body": "y"}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_delete_draft(authed):
    client, u, ws = authed
    dc = DraftComment.objects.create(workspace=ws, user=u, kind="issue", body="x")
    resp = client.delete(f"/api/drafts/{dc.id}")
    assert resp.status_code == 204
    assert not DraftComment.objects.filter(pk=dc.id).exists()


@pytest.mark.django_db
def test_put_draft_review_upsert(authed):
    client, u, ws = authed
    resp = client.put(
        f"/api/workspaces/{ws.id}/draft-review",
        data={"body": "looks good", "event": "APPROVE"},
        format="json",
    )
    assert resp.status_code == 200
    dr = DraftReview.objects.get(workspace=ws, user=u)
    assert dr.event == "APPROVE"
```

- [ ] **Step 2: Run → fail**

```bash
uv run pytest apps/workspaces/tests/test_drafts.py -v
```

- [ ] **Step 3: Append views to `apps/workspaces/views.py`**

```python
from apps.workspaces.models import DraftComment, DraftReview


def _serialize_draft(dc: DraftComment) -> dict:
    return {
        "id": dc.id,
        "kind": dc.kind,
        "diff_file_path": dc.diff_file_path,
        "position": dc.position,
        "line": dc.line,
        "side": dc.side,
        "body": dc.body,
        "parent_comment_github_id": dc.parent_comment_github_id,
        "draft_review_id": dc.draft_review_id,
        "created_at": dc.created_at.isoformat(),
        "updated_at": dc.updated_at.isoformat(),
    }


def _serialize_draft_review(dr: DraftReview) -> dict:
    return {
        "id": dr.id,
        "body": dr.body,
        "event": dr.event,
        "created_at": dr.created_at.isoformat(),
        "updated_at": dr.updated_at.isoformat(),
    }


@api_view(["GET", "POST"])
def drafts_list_or_create(request, workspace_id: int):
    ws = get_object_or_404(Workspace, pk=workspace_id, archived_at__isnull=True)
    if request.method == "GET":
        qs = DraftComment.objects.filter(workspace=ws, user=request.user)
        return Response([_serialize_draft(d) for d in qs])

    data = request.data
    kind = data.get("kind")
    body = (data.get("body") or "").strip()
    if kind not in ("issue", "review") or not body:
        return Response({"error": {"code": "invalid_input"}}, status=400)

    draft_review = None
    if data.get("attach_to_review_draft"):
        draft_review, _ = DraftReview.objects.get_or_create(
            workspace=ws, user=request.user,
            defaults={"event": "COMMENT", "body": ""},
        )

    dc = DraftComment.objects.create(
        workspace=ws, user=request.user, draft_review=draft_review,
        kind=kind,
        diff_file_path=data.get("diff_file_path", ""),
        position=data.get("position"),
        line=data.get("line"),
        side=data.get("side", ""),
        body=body,
        parent_comment_github_id=data.get("parent_comment_github_id", ""),
    )
    return Response(_serialize_draft(dc), status=201)


@api_view(["PATCH", "DELETE"])
def draft_detail(request, draft_id: int):
    dc = get_object_or_404(DraftComment, pk=draft_id)
    if dc.user_id != request.user.id:
        return Response({"error": {"code": "not_owner"}}, status=403)
    if request.method == "DELETE":
        dc.delete()
        return Response(status=204)
    new_body = (request.data.get("body") or "").strip()
    if new_body:
        dc.body = new_body
    for field in ("diff_file_path", "position", "line", "side"):
        if field in request.data:
            setattr(dc, field, request.data[field])
    dc.save()
    return Response(_serialize_draft(dc))


@api_view(["GET", "PUT"])
def draft_review_detail(request, workspace_id: int):
    ws = get_object_or_404(Workspace, pk=workspace_id, archived_at__isnull=True)
    if request.method == "GET":
        try:
            dr = DraftReview.objects.get(workspace=ws, user=request.user)
        except DraftReview.DoesNotExist:
            return Response({"error": {"code": "not_found"}}, status=404)
        return Response(_serialize_draft_review(dr))

    event = request.data.get("event", "COMMENT")
    if event not in ("COMMENT", "APPROVE", "REQUEST_CHANGES"):
        return Response({"error": {"code": "invalid_event"}}, status=400)
    body = request.data.get("body") or ""
    dr, _ = DraftReview.objects.update_or_create(
        workspace=ws, user=request.user,
        defaults={"event": event, "body": body},
    )
    return Response(_serialize_draft_review(dr))
```

- [ ] **Step 4: Append routes**

```python
path("workspaces/<int:workspace_id>/drafts", views.drafts_list_or_create),
path("workspaces/<int:workspace_id>/draft-review", views.draft_review_detail),
path("drafts/<int:draft_id>", views.draft_detail),
```

- [ ] **Step 5: Run tests → pass**

```bash
uv run pytest apps/workspaces/tests/test_drafts.py -v
```

- [ ] **Step 6: Commit**

```bash
git add apps/workspaces/
git commit -m "feat(workspaces): draft comment + draft review CRUD endpoints"
```

---

### Task 21: Gateway methods for posting comments + reviews

**Files:**
- Modify: `apps/github_proxy/gateway.py`
- Modify: `apps/github_proxy/tests/test_gateway.py`

- [ ] **Step 1: Append failing tests**

```python
@respx.mock
def test_post_issue_comment():
    respx.post("https://api.github.com/repos/o/r/issues/1/comments").mock(
        return_value=Response(201, json={"id": 100, "body": "hi"})
    )
    g = GithubGateway(token="test-pat")
    out = g.post_issue_comment("o", "r", 1, "hi")
    assert out["id"] == 100


@respx.mock
def test_post_review_comment():
    respx.post("https://api.github.com/repos/o/r/pulls/1/comments").mock(
        return_value=Response(201, json={"id": 200})
    )
    g = GithubGateway(token="test-pat")
    out = g.post_review_comment(
        "o", "r", 1,
        body="x", commit_id="sha", path="a.py", line=1, side="RIGHT",
    )
    assert out["id"] == 200


@respx.mock
def test_post_review_batch():
    respx.post("https://api.github.com/repos/o/r/pulls/1/reviews").mock(
        return_value=Response(200, json={"id": 999, "state": "COMMENTED"})
    )
    g = GithubGateway(token="test-pat")
    out = g.post_review(
        "o", "r", 1,
        body="overall", event="COMMENT",
        comments=[{"path": "a.py", "line": 1, "side": "RIGHT", "body": "x"}],
    )
    assert out["id"] == 999
```

- [ ] **Step 2: Run → fail**

```bash
uv run pytest apps/github_proxy/tests/test_gateway.py -v -k "post"
```

- [ ] **Step 3: Append gateway methods**

```python
    def post_issue_comment(self, owner: str, repo: str, number: int, body: str) -> dict:
        r = self._request(
            "POST", f"/repos/{owner}/{repo}/issues/{number}/comments",
            json={"body": body},
        )
        return r.json()

    def post_review_comment(
        self, owner: str, repo: str, number: int, *,
        body: str, commit_id: str | None = None,
        path: str, line: int | None = None, side: str | None = None,
        position: int | None = None, in_reply_to: int | None = None,
    ) -> dict:
        payload: dict = {"body": body, "path": path}
        if in_reply_to:
            payload["in_reply_to"] = in_reply_to
        else:
            if commit_id:
                payload["commit_id"] = commit_id
            if line:
                payload["line"] = line
            if side:
                payload["side"] = side
            if position is not None:
                payload["position"] = position
        r = self._request(
            "POST", f"/repos/{owner}/{repo}/pulls/{number}/comments",
            json=payload,
        )
        return r.json()

    def post_review(
        self, owner: str, repo: str, number: int, *,
        body: str = "", event: str = "COMMENT", comments: list[dict] | None = None,
    ) -> dict:
        payload: dict = {"body": body, "event": event, "comments": comments or []}
        r = self._request(
            "POST", f"/repos/{owner}/{repo}/pulls/{number}/reviews",
            json=payload,
        )
        return r.json()
```

- [ ] **Step 4: Run → pass**

```bash
uv run pytest apps/github_proxy/tests/test_gateway.py -v
```

- [ ] **Step 5: Commit**

```bash
git add apps/github_proxy/
git commit -m "feat(github_proxy): gateway methods for posting comments and reviews"
```

---

### Task 22: Publish single draft + publish-all batch

**Files:**
- Create: `apps/workspaces/publish_service.py`
- Create: `apps/workspaces/tests/test_publish_service.py`
- Modify: `apps/workspaces/views.py` (publish views)
- Modify: `apps/workspaces/urls.py`
- Create: `apps/workspaces/tests/test_publish_views.py`

- [ ] **Step 1: Write failing service test**

```python
from unittest.mock import MagicMock

import pytest

from apps.identity.models import User
from apps.workspaces.models import DraftComment, DraftReview, Workspace
from apps.workspaces.publish_service import publish_draft, publish_all_drafts


@pytest.mark.django_db
def test_publish_single_issue_comment_deletes_row():
    u = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    dc = DraftComment.objects.create(workspace=ws, user=u, kind="issue", body="x")
    gateway = MagicMock()
    gateway.post_issue_comment.return_value = {"id": 100}

    response = publish_draft(gateway, dc)
    assert response["id"] == 100
    gateway.post_issue_comment.assert_called_once_with("o", "r", 1, "x")
    assert not DraftComment.objects.filter(pk=dc.id).exists()


@pytest.mark.django_db
def test_publish_single_review_comment():
    u = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    dc = DraftComment.objects.create(
        workspace=ws, user=u, kind="review",
        diff_file_path="a.py", line=10, side="RIGHT", body="x",
    )
    gateway = MagicMock()
    gateway.get_pr.return_value = {"head": {"sha": "deadbeef"}}
    gateway.post_review_comment.return_value = {"id": 200}

    response = publish_draft(gateway, dc)
    assert response["id"] == 200
    assert not DraftComment.objects.filter(pk=dc.id).exists()


@pytest.mark.django_db
def test_publish_all_creates_review_and_clears_drafts():
    u = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    dr = DraftReview.objects.create(workspace=ws, user=u, body="overall", event="COMMENT")
    DraftComment.objects.create(
        workspace=ws, user=u, draft_review=dr, kind="review",
        diff_file_path="a.py", line=1, side="RIGHT", body="x",
    )
    DraftComment.objects.create(
        workspace=ws, user=u, draft_review=dr, kind="review",
        diff_file_path="b.py", line=2, side="RIGHT", body="y",
    )
    gateway = MagicMock()
    gateway.post_review.return_value = {"id": 999, "state": "COMMENTED"}

    result = publish_all_drafts(gateway, ws, u)
    assert result["id"] == 999
    assert not DraftReview.objects.filter(workspace=ws, user=u).exists()
    assert not DraftComment.objects.filter(workspace=ws, user=u).exists()
```

- [ ] **Step 2: Run → fail**

```bash
uv run pytest apps/workspaces/tests/test_publish_service.py -v
```

- [ ] **Step 3: Write `apps/workspaces/publish_service.py`**

```python
from django.db import transaction

from apps.github_proxy.gateway import GithubGateway
from apps.identity.models import User
from apps.workspaces.models import DraftComment, DraftReview, Workspace


class PublishError(Exception):
    pass


def publish_draft(gateway: GithubGateway, draft: DraftComment) -> dict:
    ws = draft.workspace
    if draft.kind == "issue":
        resp = gateway.post_issue_comment(
            ws.repo_owner, ws.repo_name, ws.pr_number, draft.body
        )
    else:
        # need commit sha for review comment unless replying
        if draft.parent_comment_github_id:
            resp = gateway.post_review_comment(
                ws.repo_owner, ws.repo_name, ws.pr_number,
                body=draft.body, path=draft.diff_file_path,
                in_reply_to=int(draft.parent_comment_github_id),
            )
        else:
            pr = gateway.get_pr(ws.repo_owner, ws.repo_name, ws.pr_number)
            resp = gateway.post_review_comment(
                ws.repo_owner, ws.repo_name, ws.pr_number,
                body=draft.body, commit_id=pr["head"]["sha"],
                path=draft.diff_file_path,
                line=draft.line or None,
                side=draft.side or None,
                position=draft.position,
            )
    draft.delete()
    return resp


def publish_all_drafts(gateway: GithubGateway, workspace: Workspace, user: User) -> dict:
    drafts = list(DraftComment.objects.filter(workspace=workspace, user=user))
    try:
        review = DraftReview.objects.get(workspace=workspace, user=user)
        body = review.body
        event = review.event
    except DraftReview.DoesNotExist:
        body = ""
        event = "COMMENT"

    comments_payload = [
        {
            "path": d.diff_file_path,
            "line": d.line,
            "side": d.side or "RIGHT",
            "body": d.body,
        }
        for d in drafts if d.kind == "review"
    ]

    resp = gateway.post_review(
        workspace.repo_owner, workspace.repo_name, workspace.pr_number,
        body=body, event=event, comments=comments_payload,
    )

    with transaction.atomic():
        DraftComment.objects.filter(workspace=workspace, user=user).delete()
        DraftReview.objects.filter(workspace=workspace, user=user).delete()

    return resp
```

- [ ] **Step 4: Run → pass**

```bash
uv run pytest apps/workspaces/tests/test_publish_service.py -v
```

- [ ] **Step 5: Write failing view test `apps/workspaces/tests/test_publish_views.py`**

```python
from unittest.mock import patch
import pytest

from apps.identity.models import User
from apps.workspaces.models import DraftComment, Workspace


@pytest.fixture
def authed(api_client, db):
    u = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    session = api_client.session
    session["user_id"] = u.id
    session.save()
    return api_client, u, ws


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_publish_single_draft(MockGateway, authed):
    client, u, ws = authed
    inst = MockGateway.return_value
    inst.post_issue_comment.return_value = {"id": 1}
    dc = DraftComment.objects.create(workspace=ws, user=u, kind="issue", body="hi")
    resp = client.post(f"/api/drafts/{dc.id}/publish")
    assert resp.status_code == 200
    assert resp.json()["id"] == 1


@pytest.mark.django_db
@patch("apps.workspaces.views.GithubGateway")
def test_publish_all(MockGateway, authed):
    client, u, ws = authed
    inst = MockGateway.return_value
    inst.post_review.return_value = {"id": 999}
    DraftComment.objects.create(
        workspace=ws, user=u, kind="review",
        diff_file_path="a.py", line=1, side="RIGHT", body="x",
    )
    resp = client.post(f"/api/workspaces/{ws.id}/drafts/publish-all")
    assert resp.status_code == 200
    assert resp.json()["id"] == 999
```

- [ ] **Step 6: Run → fail**

```bash
uv run pytest apps/workspaces/tests/test_publish_views.py -v
```

- [ ] **Step 7: Append publish views**

```python
from apps.workspaces.publish_service import publish_all_drafts, publish_draft


@api_view(["POST"])
def draft_publish(request, draft_id: int):
    dc = get_object_or_404(DraftComment, pk=draft_id, user=request.user)
    g = _gateway()
    try:
        resp = publish_draft(g, dc)
    finally:
        g.close()
    return Response(resp)


@api_view(["POST"])
def drafts_publish_all(request, workspace_id: int):
    ws = get_object_or_404(Workspace, pk=workspace_id, archived_at__isnull=True)
    g = _gateway()
    try:
        resp = publish_all_drafts(g, ws, request.user)
    finally:
        g.close()
    return Response(resp)
```

- [ ] **Step 8: Add routes**

```python
path("drafts/<int:draft_id>/publish", views.draft_publish),
path("workspaces/<int:workspace_id>/drafts/publish-all", views.drafts_publish_all),
```

- [ ] **Step 9: Run → pass**

```bash
uv run pytest apps/workspaces/tests/test_publish_views.py -v
```

- [ ] **Step 10: Commit**

```bash
git add apps/workspaces/ apps/github_proxy/
git commit -m "feat(workspaces): publish single draft + publish-all batch endpoints"
```

---

## Phase 7 · Proxy routes

### Task 23: Read proxy routes (PR / files / comments / reviews / checks / workflows)

**Files:**
- Modify: `apps/github_proxy/gateway.py` (add read methods if missing)
- Create: `apps/github_proxy/views.py`
- Modify: `apps/github_proxy/urls.py`
- Create: `apps/github_proxy/tests/test_views.py`

- [ ] **Step 1: Append gateway read methods to `apps/github_proxy/gateway.py`**

```python
    def list_issue_comments(self, owner: str, repo: str, number: int) -> list[dict]:
        r = self._request("GET", f"/repos/{owner}/{repo}/issues/{number}/comments")
        return r.json()

    def list_review_comments(self, owner: str, repo: str, number: int) -> list[dict]:
        r = self._request("GET", f"/repos/{owner}/{repo}/pulls/{number}/comments")
        return r.json()

    def list_reviews(self, owner: str, repo: str, number: int) -> list[dict]:
        r = self._request("GET", f"/repos/{owner}/{repo}/pulls/{number}/reviews")
        return r.json()

    def list_check_runs(self, owner: str, repo: str, ref: str) -> dict:
        r = self._request("GET", f"/repos/{owner}/{repo}/commits/{ref}/check-runs")
        return r.json()

    def list_workflow_runs(self, owner: str, repo: str, head_sha: str) -> dict:
        r = self._request(
            "GET", f"/repos/{owner}/{repo}/actions/runs",
            params={"head_sha": head_sha},
        )
        return r.json()

    def get_file_content(self, owner: str, repo: str, path: str, ref: str) -> dict:
        r = self._request(
            "GET", f"/repos/{owner}/{repo}/contents/{path}",
            params={"ref": ref},
        )
        return r.json()
```

- [ ] **Step 2: Write failing view test `apps/github_proxy/tests/test_views.py`**

```python
from unittest.mock import patch
import pytest

from apps.identity.models import User
from apps.workspaces.models import Workspace


@pytest.fixture
def authed(api_client, db):
    u = User.objects.create(github_login="alice", github_user_id=1)
    ws = Workspace.objects.create(repo_owner="o", repo_name="r", pr_number=1, created_by=u)
    session = api_client.session
    session["user_id"] = u.id
    session.save()
    return api_client, ws


@pytest.mark.django_db
@patch("apps.github_proxy.views.GithubGateway")
def test_proxy_pr(MockGateway, authed):
    client, ws = authed
    MockGateway.return_value.get_pr.return_value = {"number": 1}
    resp = client.get(f"/api/workspaces/{ws.id}/pr")
    assert resp.status_code == 200
    assert resp.json()["number"] == 1


@pytest.mark.django_db
@patch("apps.github_proxy.views.GithubGateway")
def test_proxy_files(MockGateway, authed):
    client, ws = authed
    MockGateway.return_value.list_pr_files.return_value = [{"filename": "a.py"}]
    resp = client.get(f"/api/workspaces/{ws.id}/files")
    assert resp.status_code == 200
    assert resp.json()[0]["filename"] == "a.py"


@pytest.mark.django_db
@patch("apps.github_proxy.views.GithubGateway")
def test_proxy_comments_combined(MockGateway, authed):
    client, ws = authed
    g = MockGateway.return_value
    g.list_issue_comments.return_value = [{"id": 1, "body": "i"}]
    g.list_review_comments.return_value = [{"id": 2, "body": "r"}]
    resp = client.get(f"/api/workspaces/{ws.id}/comments")
    assert resp.status_code == 200
    out = resp.json()
    assert len(out["issue_comments"]) == 1
    assert len(out["review_comments"]) == 1


@pytest.mark.django_db
@patch("apps.github_proxy.views.GithubGateway")
def test_proxy_reviews(MockGateway, authed):
    client, ws = authed
    MockGateway.return_value.list_reviews.return_value = [{"id": 1}]
    resp = client.get(f"/api/workspaces/{ws.id}/reviews")
    assert resp.status_code == 200


@pytest.mark.django_db
@patch("apps.github_proxy.views.GithubGateway")
def test_proxy_checks(MockGateway, authed):
    client, ws = authed
    MockGateway.return_value.list_check_runs.return_value = {"check_runs": []}
    resp = client.get(f"/api/workspaces/{ws.id}/checks?ref=abc123")
    assert resp.status_code == 200


@pytest.mark.django_db
@patch("apps.github_proxy.views.GithubGateway")
def test_proxy_workflow_runs(MockGateway, authed):
    client, ws = authed
    MockGateway.return_value.list_workflow_runs.return_value = {"workflow_runs": []}
    resp = client.get(f"/api/workspaces/{ws.id}/workflow-runs?head_sha=abc")
    assert resp.status_code == 200
```

- [ ] **Step 3: Run → fail**

```bash
uv run pytest apps/github_proxy/tests/test_views.py -v
```

- [ ] **Step 4: Write `apps/github_proxy/views.py`**

```python
from django.conf import settings
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.response import Response

from apps.github_proxy.exceptions import (
    GithubConflict,
    GithubError,
    GithubForbidden,
    GithubNotFound,
)
from apps.github_proxy.gateway import GithubGateway
from apps.workspaces.models import Workspace


def _gateway() -> GithubGateway:
    return GithubGateway(token=settings.GITHUB_ADMIN_PAT)


def _ws(workspace_id: int) -> Workspace:
    return get_object_or_404(Workspace, pk=workspace_id, archived_at__isnull=True)


def _proxy(call):
    g = _gateway()
    try:
        return Response(call(g))
    except GithubNotFound as e:
        return Response({"error": {"code": "not_found", "message": e.message}}, status=404)
    except GithubForbidden as e:
        return Response({"error": {"code": "forbidden", "message": e.message}}, status=403)
    except GithubConflict as e:
        return Response({"error": {"code": "conflict", "message": e.message}}, status=e.status_code)
    except GithubError as e:
        return Response({"error": {"code": "github_error", "message": e.message}}, status=e.status_code)
    finally:
        g.close()


@api_view(["GET"])
def proxy_pr(request, workspace_id: int):
    ws = _ws(workspace_id)
    return _proxy(lambda g: g.get_pr(ws.repo_owner, ws.repo_name, ws.pr_number))


@api_view(["GET"])
def proxy_files(request, workspace_id: int):
    ws = _ws(workspace_id)
    return _proxy(lambda g: g.list_pr_files(ws.repo_owner, ws.repo_name, ws.pr_number))


@api_view(["GET"])
def proxy_file_content(request, workspace_id: int):
    ws = _ws(workspace_id)
    path = request.query_params.get("path", "")
    ref = request.query_params.get("ref", "")
    if not path or not ref:
        return Response({"error": {"code": "missing_params"}}, status=400)
    return _proxy(lambda g: g.get_file_content(ws.repo_owner, ws.repo_name, path, ref))


@api_view(["GET"])
def proxy_comments(request, workspace_id: int):
    ws = _ws(workspace_id)
    g = _gateway()
    try:
        return Response({
            "issue_comments": g.list_issue_comments(ws.repo_owner, ws.repo_name, ws.pr_number),
            "review_comments": g.list_review_comments(ws.repo_owner, ws.repo_name, ws.pr_number),
        })
    finally:
        g.close()


@api_view(["GET"])
def proxy_reviews(request, workspace_id: int):
    ws = _ws(workspace_id)
    return _proxy(lambda g: g.list_reviews(ws.repo_owner, ws.repo_name, ws.pr_number))


@api_view(["GET"])
def proxy_checks(request, workspace_id: int):
    ws = _ws(workspace_id)
    ref = request.query_params.get("ref")
    if not ref:
        return Response({"error": {"code": "missing_ref"}}, status=400)
    return _proxy(lambda g: g.list_check_runs(ws.repo_owner, ws.repo_name, ref))


@api_view(["GET"])
def proxy_workflow_runs(request, workspace_id: int):
    ws = _ws(workspace_id)
    head_sha = request.query_params.get("head_sha", "")
    if not head_sha:
        return Response({"error": {"code": "missing_head_sha"}}, status=400)
    return _proxy(lambda g: g.list_workflow_runs(ws.repo_owner, ws.repo_name, head_sha))
```

- [ ] **Step 5: Write `apps/github_proxy/urls.py`**

```python
from django.urls import path

from apps.github_proxy import views

urlpatterns = [
    path("workspaces/<int:workspace_id>/pr", views.proxy_pr),
    path("workspaces/<int:workspace_id>/files", views.proxy_files),
    path("workspaces/<int:workspace_id>/files/content", views.proxy_file_content),
    path("workspaces/<int:workspace_id>/comments", views.proxy_comments),
    path("workspaces/<int:workspace_id>/reviews", views.proxy_reviews),
    path("workspaces/<int:workspace_id>/checks", views.proxy_checks),
    path("workspaces/<int:workspace_id>/workflow-runs", views.proxy_workflow_runs),
]
```

- [ ] **Step 6: Run tests → pass**

```bash
uv run pytest apps/github_proxy/tests/test_views.py -v
```

- [ ] **Step 7: Commit**

```bash
git add apps/github_proxy/
git commit -m "feat(github_proxy): read passthrough routes (pr/files/comments/reviews/checks/workflows)"
```

---

### Task 24: Write proxy routes (lifecycle actions + comment edit/delete + thread resolve)

**Files:**
- Modify: `apps/github_proxy/gateway.py` (write methods + GraphQL helper)
- Modify: `apps/github_proxy/views.py`
- Modify: `apps/github_proxy/urls.py`
- Modify: `apps/github_proxy/tests/test_views.py`

- [ ] **Step 1: Append gateway write methods + GraphQL helper**

```python
    def patch_pr(self, owner: str, repo: str, number: int, **fields) -> dict:
        r = self._request("PATCH", f"/repos/{owner}/{repo}/pulls/{number}", json=fields)
        return r.json()

    def merge_pr(self, owner: str, repo: str, number: int, *, method: str = "merge") -> dict:
        r = self._request(
            "PUT", f"/repos/{owner}/{repo}/pulls/{number}/merge",
            json={"merge_method": method},
        )
        return r.json()

    def edit_issue_comment(self, owner: str, repo: str, comment_id: int, body: str) -> dict:
        r = self._request(
            "PATCH", f"/repos/{owner}/{repo}/issues/comments/{comment_id}",
            json={"body": body},
        )
        return r.json()

    def delete_issue_comment(self, owner: str, repo: str, comment_id: int) -> None:
        self._request("DELETE", f"/repos/{owner}/{repo}/issues/comments/{comment_id}")

    def edit_review_comment(self, owner: str, repo: str, comment_id: int, body: str) -> dict:
        r = self._request(
            "PATCH", f"/repos/{owner}/{repo}/pulls/comments/{comment_id}",
            json={"body": body},
        )
        return r.json()

    def delete_review_comment(self, owner: str, repo: str, comment_id: int) -> None:
        self._request("DELETE", f"/repos/{owner}/{repo}/pulls/comments/{comment_id}")

    def react_to_comment(
        self, owner: str, repo: str, kind: str, comment_id: int, content: str,
    ) -> dict:
        # kind: 'issue' or 'review' (pulls)
        path = "issues/comments" if kind == "issue" else "pulls/comments"
        r = self._request(
            "POST", f"/repos/{owner}/{repo}/{path}/{comment_id}/reactions",
            json={"content": content},
        )
        return r.json()

    def graphql(self, query: str, variables: dict | None = None) -> dict:
        r = self._client.post(
            "https://api.github.com/graphql",
            json={"query": query, "variables": variables or {}},
        )
        if r.status_code >= 400:
            raise GithubError(r.status_code, r.text)
        body = r.json()
        if "errors" in body:
            raise GithubError(500, str(body["errors"]), body)
        return body["data"]

    def resolve_review_thread(self, thread_id: str) -> dict:
        return self.graphql(
            """mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}""",
            {"id": thread_id},
        )

    def unresolve_review_thread(self, thread_id: str) -> dict:
        return self.graphql(
            """mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}""",
            {"id": thread_id},
        )

    def list_review_threads(self, owner: str, repo: str, number: int) -> dict:
        query = """
        query($o:String!,$r:String!,$n:Int!){
          repository(owner:$o,name:$r){
            pullRequest(number:$n){
              reviewThreads(first:100){
                nodes{
                  id isResolved isOutdated
                  comments(first:50){nodes{id databaseId body author{login}}}
                }
              }
            }
          }
        }
        """
        return self.graphql(query, {"o": owner, "r": repo, "n": number})
```

- [ ] **Step 2: Append failing view tests**

```python
@pytest.mark.django_db
@patch("apps.github_proxy.views.GithubGateway")
def test_proxy_close_pr(MockGateway, authed):
    client, ws = authed
    MockGateway.return_value.patch_pr.return_value = {"state": "closed"}
    resp = client.post(f"/api/workspaces/{ws.id}/actions/close")
    assert resp.status_code == 200
    assert resp.json()["state"] == "closed"


@pytest.mark.django_db
@patch("apps.github_proxy.views.GithubGateway")
def test_proxy_reopen_pr(MockGateway, authed):
    client, ws = authed
    MockGateway.return_value.patch_pr.return_value = {"state": "open"}
    resp = client.post(f"/api/workspaces/{ws.id}/actions/reopen")
    assert resp.status_code == 200


@pytest.mark.django_db
@patch("apps.github_proxy.views.GithubGateway")
def test_proxy_toggle_draft(MockGateway, authed):
    client, ws = authed
    g = MockGateway.return_value
    g.get_pr.return_value = {"draft": False}
    g.patch_pr.return_value = {"draft": True}
    resp = client.post(f"/api/workspaces/{ws.id}/actions/toggle-draft")
    assert resp.status_code == 200
    g.patch_pr.assert_called_with("o", "r", 1, draft=True)


@pytest.mark.django_db
@patch("apps.github_proxy.views.GithubGateway")
def test_proxy_merge(MockGateway, authed):
    client, ws = authed
    MockGateway.return_value.merge_pr.return_value = {"merged": True}
    resp = client.post(
        f"/api/workspaces/{ws.id}/actions/merge",
        data={"method": "squash"},
        format="json",
    )
    assert resp.status_code == 200
    MockGateway.return_value.merge_pr.assert_called_with("o", "r", 1, method="squash")


@pytest.mark.django_db
@patch("apps.github_proxy.views.GithubGateway")
def test_proxy_edit_review_comment(MockGateway, authed):
    client, ws = authed
    MockGateway.return_value.edit_review_comment.return_value = {"id": 99, "body": "new"}
    resp = client.patch(
        f"/api/workspaces/{ws.id}/comments/99",
        data={"kind": "review", "body": "new"},
        format="json",
    )
    assert resp.status_code == 200


@pytest.mark.django_db
@patch("apps.github_proxy.views.GithubGateway")
def test_proxy_delete_comment(MockGateway, authed):
    client, ws = authed
    resp = client.delete(f"/api/workspaces/{ws.id}/comments/99?kind=review")
    assert resp.status_code == 204
    MockGateway.return_value.delete_review_comment.assert_called_with("o", "r", 99)


@pytest.mark.django_db
@patch("apps.github_proxy.views.GithubGateway")
def test_proxy_resolve_thread(MockGateway, authed):
    client, ws = authed
    MockGateway.return_value.resolve_review_thread.return_value = {"thread": {"isResolved": True}}
    resp = client.post(
        f"/api/workspaces/{ws.id}/threads/abc/resolve",
    )
    assert resp.status_code == 200
```

- [ ] **Step 3: Run → fail**

```bash
uv run pytest apps/github_proxy/tests/test_views.py -v
```

- [ ] **Step 4: Append write proxy views**

```python
@api_view(["POST"])
def proxy_close(request, workspace_id: int):
    ws = _ws(workspace_id)
    return _proxy(lambda g: g.patch_pr(ws.repo_owner, ws.repo_name, ws.pr_number, state="closed"))


@api_view(["POST"])
def proxy_reopen(request, workspace_id: int):
    ws = _ws(workspace_id)
    return _proxy(lambda g: g.patch_pr(ws.repo_owner, ws.repo_name, ws.pr_number, state="open"))


@api_view(["POST"])
def proxy_toggle_draft(request, workspace_id: int):
    ws = _ws(workspace_id)
    g = _gateway()
    try:
        pr = g.get_pr(ws.repo_owner, ws.repo_name, ws.pr_number)
        new_draft = not pr.get("draft", False)
        return Response(g.patch_pr(ws.repo_owner, ws.repo_name, ws.pr_number, draft=new_draft))
    finally:
        g.close()


@api_view(["POST"])
def proxy_merge(request, workspace_id: int):
    ws = _ws(workspace_id)
    method = request.data.get("method", "merge")
    if method not in ("merge", "squash", "rebase"):
        return Response({"error": {"code": "invalid_method"}}, status=400)
    return _proxy(lambda g: g.merge_pr(ws.repo_owner, ws.repo_name, ws.pr_number, method=method))


@api_view(["PATCH", "DELETE"])
def proxy_comment(request, workspace_id: int, comment_id: int):
    ws = _ws(workspace_id)
    kind = request.query_params.get("kind") or request.data.get("kind")
    if kind not in ("issue", "review"):
        return Response({"error": {"code": "kind_required"}}, status=400)
    g = _gateway()
    try:
        if request.method == "DELETE":
            if kind == "issue":
                g.delete_issue_comment(ws.repo_owner, ws.repo_name, comment_id)
            else:
                g.delete_review_comment(ws.repo_owner, ws.repo_name, comment_id)
            return Response(status=204)
        body = request.data.get("body", "")
        if kind == "issue":
            return Response(g.edit_issue_comment(ws.repo_owner, ws.repo_name, comment_id, body))
        return Response(g.edit_review_comment(ws.repo_owner, ws.repo_name, comment_id, body))
    finally:
        g.close()


@api_view(["POST"])
def proxy_comment_react(request, workspace_id: int, comment_id: int):
    ws = _ws(workspace_id)
    kind = request.data.get("kind")
    content = request.data.get("content")
    if kind not in ("issue", "review") or not content:
        return Response({"error": {"code": "invalid_input"}}, status=400)
    return _proxy(lambda g: g.react_to_comment(ws.repo_owner, ws.repo_name, kind, comment_id, content))


@api_view(["GET"])
def proxy_threads(request, workspace_id: int):
    ws = _ws(workspace_id)
    return _proxy(lambda g: g.list_review_threads(ws.repo_owner, ws.repo_name, ws.pr_number))


@api_view(["POST"])
def proxy_thread_resolve(request, workspace_id: int, thread_id: str):
    return _proxy(lambda g: g.resolve_review_thread(thread_id))


@api_view(["POST"])
def proxy_thread_unresolve(request, workspace_id: int, thread_id: str):
    return _proxy(lambda g: g.unresolve_review_thread(thread_id))
```

- [ ] **Step 5: Append routes to `apps/github_proxy/urls.py`**

```python
path("workspaces/<int:workspace_id>/threads", views.proxy_threads),
path("workspaces/<int:workspace_id>/threads/<str:thread_id>/resolve", views.proxy_thread_resolve),
path("workspaces/<int:workspace_id>/threads/<str:thread_id>/unresolve", views.proxy_thread_unresolve),
path("workspaces/<int:workspace_id>/actions/close", views.proxy_close),
path("workspaces/<int:workspace_id>/actions/reopen", views.proxy_reopen),
path("workspaces/<int:workspace_id>/actions/toggle-draft", views.proxy_toggle_draft),
path("workspaces/<int:workspace_id>/actions/merge", views.proxy_merge),
path("workspaces/<int:workspace_id>/comments/<int:comment_id>", views.proxy_comment),
path("workspaces/<int:workspace_id>/comments/<int:comment_id>/reactions", views.proxy_comment_react),
```

- [ ] **Step 6: Run tests → pass**

```bash
uv run pytest apps/github_proxy/tests/test_views.py -v
```

- [ ] **Step 7: Commit**

```bash
git add apps/github_proxy/
git commit -m "feat(github_proxy): write proxy routes (PR state, merge, comment edit/delete, threads, reactions)"
```

---

## Phase 8 · Polish

### Task 25: Error envelope middleware

**Files:**
- Create: `apps/identity/middleware.py`
- Modify: `local_review/settings/base.py` (add middleware)
- Create: `apps/identity/tests/test_middleware.py`

- [ ] **Step 1: Write failing test**

```python
import pytest


@pytest.mark.django_db
def test_500_returns_envelope(api_client, settings, monkeypatch):
    from django.urls import path
    from rest_framework.decorators import api_view, permission_classes
    from rest_framework.permissions import AllowAny

    @api_view(["GET"])
    @permission_classes([AllowAny])
    def boom(request):
        raise RuntimeError("explode")

    from local_review import urls

    urls.urlpatterns.append(path("api/__boom__", boom))
    settings.DEBUG = False
    resp = api_client.get("/api/__boom__")
    assert resp.status_code == 500
    body = resp.json()
    assert "error" in body
    assert body["error"]["code"] == "internal_error"
```

- [ ] **Step 2: Run → fail**

```bash
uv run pytest apps/identity/tests/test_middleware.py -v
```

- [ ] **Step 3: Write `apps/identity/middleware.py`**

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
            {"error": {"code": "internal_error", "message": str(exc)}},
            status=500,
        )
```

- [ ] **Step 4: Add to MIDDLEWARE in `local_review/settings/base.py`**

```python
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "apps.identity.middleware.ErrorEnvelopeMiddleware",
]
```

- [ ] **Step 5: Run → pass**

```bash
uv run pytest apps/identity/tests/test_middleware.py -v
```

- [ ] **Step 6: Commit**

```bash
git add apps/identity/middleware.py apps/identity/tests/test_middleware.py local_review/settings/base.py
git commit -m "feat(identity): error envelope middleware for /api/ 5xx responses"
```

---

### Task 26: Final smoke test — full suite + dev server boot

**Files:** none

- [ ] **Step 1: Run full test suite**

```bash
uv run pytest -v
```

Expected: all tests pass. Note any flakes.

- [ ] **Step 2: Lint check — verify imports + obvious issues**

```bash
uv run python -m compileall apps local_review
```

Expected: no syntax errors.

- [ ] **Step 3: Boot dev server smoke**

```bash
uv run python manage.py migrate
uv run python manage.py runserver 8000 &
sleep 2
curl -s http://localhost:8000/api/auth/me -o /dev/null -w "%{http_code}\n"
kill %1
```

Expected: `401` (no session) — server up, routes wired.

- [ ] **Step 4: Coverage report**

```bash
uv run pytest --cov=apps --cov-report=term-missing
```

Review coverage. Patch any obvious untested paths.

- [ ] **Step 5: Commit summary tag**

```bash
git tag -a v0.1.0-spec-complete -m "spec implementation complete"
git log --oneline | head -30
```

---

## Coverage map (spec section → tasks)

| Spec section | Tasks covering it |
|---|---|
| §4 Architecture | T1–T4 (scaffold), T8 (gateway), T25 (middleware) |
| §5.1 Identity models | T5 |
| §5.2 Workspace | T9 |
| §5.3 Storyline / StorylineFile | T11, T12 |
| §5.4 IntroComment | T16, T17 |
| §5.5 AIAnalysisDoc / AIAnalysisFile | T15, T18 |
| §5.6 DraftReview / DraftComment | T19, T20 |
| §6.1 Native routes | T7 (auth), T10 (workspace), T13 (storyline), T17 (intros), T18 (ai-doc), T20 (drafts), T22 (publish) |
| §6.2 Proxy routes | T23 (read), T24 (write) |
| §6.3 Auth routes | T7 |
| §7 Request flows | All scenarios covered by view tests in T10/T13/T17/T18/T20/T22/T23/T24 |
| §8 Auth model | T6, T7 |
| §9 Persistence + migrations | Migrations generated in T5/T9/T11/T15/T16/T19 |
| §10 Testing approach | Tests per-task throughout |
| §11 Tech debt | Documented in spec; no implementation tasks (intentional) |

---

## Done criteria

After T26: the backend boots, all routes return expected status codes for happy + sad paths, the test suite is green, and a developer with a real github admin PAT + a real github OAuth app can: log in, create a workspace bound to a real PR, edit a storyline (as author), post intro comments + replies, ingest an AI doc, compose drafts, publish single or batch, view all PR data via proxy routes, and execute PR-lifecycle actions.

UI is out of scope — this plan delivers the API the UI will consume.
