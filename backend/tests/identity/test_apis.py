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
