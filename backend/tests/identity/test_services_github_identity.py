import datetime as dt
from typing import cast

import httpx
import pytest
import respx
from django.utils import timezone

from apps.core.exceptions import ApplicationError
from apps.identity.factories import GitHubIdentityFactory
from apps.identity.models import GitHubIdentity
from apps.identity.services import github_identity_ensure_fresh, github_identity_upsert
from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_github_identity_upsert_creates_row_when_missing():
    user = cast(User, UserFactory())
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
    identity = cast(GitHubIdentity, GitHubIdentityFactory())
    payload = {
        "access_token": "ghu_ROTATED",
        "refresh_token": "ghr_ROTATED",
        "expires_in": 28800,
        "refresh_token_expires_in": 15897600,
    }
    updated = github_identity_upsert(user=cast(User, identity.user), payload=payload)
    assert updated.pk == identity.pk
    assert updated.access_token == "ghu_ROTATED"
    assert updated.refresh_token == "ghr_ROTATED"
    assert GitHubIdentity.objects.count() == 1


@pytest.mark.django_db
@respx.mock
def test_github_identity_ensure_fresh_skips_refresh_when_far_from_expiry():
    identity = cast(GitHubIdentity, GitHubIdentityFactory())  # default: 8 h future
    result = github_identity_ensure_fresh(identity=identity)
    assert result.pk == identity.pk
    assert result.access_token == identity.access_token
    # No route registered → any HTTP call fails with respx.MockNotMatched.


@pytest.mark.django_db
@respx.mock
def test_github_identity_ensure_fresh_refreshes_near_expiry():
    identity = cast(
        GitHubIdentity,
        GitHubIdentityFactory(access_token_expires_at=timezone.now() + dt.timedelta(seconds=10)),
    )
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=httpx.Response(
            200,
            json={
                "access_token": "ghu_REFRESHED",
                "refresh_token": "ghr_REFRESHED",
                "expires_in": 28800,
                "refresh_token_expires_in": 15897600,
                "token_type": "bearer",
            },
        )
    )
    result = github_identity_ensure_fresh(identity=identity)
    assert result.access_token == "ghu_REFRESHED"
    assert result.refresh_token == "ghr_REFRESHED"


@pytest.mark.django_db
@respx.mock
def test_github_identity_ensure_fresh_deletes_row_on_bad_refresh():
    identity = cast(
        GitHubIdentity,
        GitHubIdentityFactory(access_token_expires_at=timezone.now() - dt.timedelta(minutes=1)),
    )
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=httpx.Response(200, json={"error": "bad_refresh_token"})
    )
    with pytest.raises(ApplicationError) as exc:
        github_identity_ensure_fresh(identity=identity)
    assert exc.value.message == "github_reauth_required"
    assert not GitHubIdentity.objects.filter(pk=identity.pk).exists()
