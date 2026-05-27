import httpx
import pytest
import respx
from django.urls import reverse
from rest_framework.test import APIClient

from apps.identity.models import GitHubIdentity, Session
from apps.users.models import User


@pytest.mark.django_db
@respx.mock
def test_auth_web_exchange_creates_user_identity_and_session():
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=httpx.Response(
            200,
            json={
                "access_token": "ghu_TESTAA",
                "refresh_token": "ghr_TESTBB",
                "expires_in": 28800,
                "refresh_token_expires_in": 15897600,
                "token_type": "bearer",
            },
        )
    )
    respx.get("https://api.github.com/user").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": 99,
                "login": "carol",
                "name": "Carol",
                "avatar_url": "https://a.example/carol.png",
            },
        )
    )
    client = APIClient()
    resp = client.post(
        reverse("v1:identity:auth_web_exchange"),
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
@respx.mock
def test_auth_web_exchange_returns_400_on_bad_verification_code():
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=httpx.Response(200, json={"error": "bad_verification_code"})
    )
    client = APIClient()
    resp = client.post(
        reverse("v1:identity:auth_web_exchange"),
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
        reverse("v1:identity:auth_web_exchange"),
        {
            "code": "abc",
            "code_verifier": "too-short",
            "redirect_uri": "http://127.0.0.1:8765/cb",
        },
        format="json",
    )
    assert resp.status_code == 400
