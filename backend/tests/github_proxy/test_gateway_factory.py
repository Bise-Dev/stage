import datetime as dt
from typing import cast

import httpx
import pytest
import respx
from django.utils import timezone

from apps.core.exceptions import ApplicationError
from apps.github_proxy.gateway import make_user_gateway
from apps.identity.factories import GitHubIdentityFactory
from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_make_user_gateway_uses_user_token():
    identity = GitHubIdentityFactory(access_token="ghu_FRESH")
    gw = make_user_gateway(cast(User, identity.user))
    # Inspect httpx client headers (read-only).
    auth_header = gw._client.headers["Authorization"]
    assert auth_header == "token ghu_FRESH"
    gw.close()


@pytest.mark.django_db
@respx.mock
def test_make_user_gateway_refreshes_near_expiry():
    identity = GitHubIdentityFactory(
        access_token="ghu_STALE",
        access_token_expires_at=timezone.now() + dt.timedelta(seconds=10),
    )
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=httpx.Response(
            200,
            json={
                "access_token": "ghu_REFRESHED",
                "refresh_token": "ghr_NEW",
                "expires_in": 28800,
                "refresh_token_expires_in": 15897600,
                "token_type": "bearer",
            },
        )
    )
    gw = make_user_gateway(cast(User, identity.user))
    assert gw._client.headers["Authorization"] == "token ghu_REFRESHED"
    gw.close()


@pytest.mark.django_db
def test_make_user_gateway_raises_reauth_required_when_no_identity():
    user = cast(User, UserFactory())  # no GitHubIdentity
    with pytest.raises(ApplicationError) as exc:
        make_user_gateway(user)
    assert exc.value.message == "github_reauth_required"
    assert exc.value.status == 401
