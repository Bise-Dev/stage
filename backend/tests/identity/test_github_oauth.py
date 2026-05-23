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
