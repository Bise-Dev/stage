import httpx
import pytest
import respx

from apps.core.exceptions import ApplicationError
from apps.identity import github_app


@respx.mock
def test_exchange_code_returns_payload_on_ok():
    route = respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=httpx.Response(
            200,
            json={
                "access_token": "ghu_AAA",
                "refresh_token": "ghr_BBB",
                "expires_in": 28800,
                "refresh_token_expires_in": 15897600,
                "token_type": "bearer",
                "scope": "",
            },
        )
    )
    result = github_app.exchange_code(
        code="abc",
        code_verifier="verifier_xyz",
        redirect_uri="http://127.0.0.1:1234/cb",
    )
    assert result["access_token"] == "ghu_AAA"
    assert result["refresh_token"] == "ghr_BBB"
    assert result["expires_in"] == 28800
    # Request shape: body must include code_verifier and redirect_uri exactly
    sent = route.calls[0].request
    body = dict(pair.split("=", 1) for pair in sent.content.decode().split("&"))
    assert body["code"] == "abc"
    assert body["code_verifier"] == "verifier_xyz"
    assert body["redirect_uri"] == "http%3A%2F%2F127.0.0.1%3A1234%2Fcb"


@respx.mock
def test_exchange_code_raises_on_bad_verification_code():
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=httpx.Response(200, json={"error": "bad_verification_code"})
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


@respx.mock
def test_exchange_code_raises_misconfigured_on_token_endpoint_401():
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=httpx.Response(401, json={"message": "Bad credentials"})
    )
    with pytest.raises(ApplicationError) as exc:
        github_app.exchange_code(
            code="abc",
            code_verifier="v",
            redirect_uri="http://127.0.0.1:1234/cb",
        )
    assert exc.value.message == "github_app_misconfigured"
    assert exc.value.status == 500


@respx.mock
def test_exchange_code_raises_unreachable_on_5xx():
    respx.post("https://github.com/login/oauth/access_token").mock(return_value=httpx.Response(503))
    with pytest.raises(ApplicationError) as exc:
        github_app.exchange_code(
            code="abc",
            code_verifier="v",
            redirect_uri="http://127.0.0.1:1234/cb",
        )
    assert exc.value.message == "github_unreachable"
    assert exc.value.status == 502


@respx.mock
def test_exchange_code_raises_unreachable_on_network_error():
    respx.post("https://github.com/login/oauth/access_token").mock(
        side_effect=httpx.ConnectError("network down")
    )
    with pytest.raises(ApplicationError) as exc:
        github_app.exchange_code(
            code="abc",
            code_verifier="v",
            redirect_uri="http://127.0.0.1:1234/cb",
        )
    assert exc.value.message == "github_unreachable"
    assert exc.value.status == 502


@respx.mock
def test_refresh_returns_payload_on_ok():
    route = respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=httpx.Response(
            200,
            json={
                "access_token": "ghu_CCC",
                "refresh_token": "ghr_DDD",
                "expires_in": 28800,
                "refresh_token_expires_in": 15897600,
                "token_type": "bearer",
            },
        )
    )
    result = github_app.refresh(refresh_token="ghr_BBB")
    assert result["access_token"] == "ghu_CCC"
    assert result["refresh_token"] == "ghr_DDD"
    # Verify grant_type and refresh_token in body
    sent = route.calls[0].request
    body = dict(pair.split("=", 1) for pair in sent.content.decode().split("&"))
    assert body["grant_type"] == "refresh_token"
    assert body["refresh_token"] == "ghr_BBB"


@respx.mock
def test_refresh_raises_reauth_required_on_bad_refresh_token():
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=httpx.Response(200, json={"error": "bad_refresh_token"})
    )
    with pytest.raises(ApplicationError) as exc:
        github_app.refresh(refresh_token="ghr_dead")
    assert exc.value.message == "github_reauth_required"
    assert exc.value.status == 401


@respx.mock
def test_fetch_user_returns_profile():
    route = respx.get(github_app._USER_URL).mock(
        return_value=httpx.Response(
            200, json={"id": 42, "login": "alice", "name": "Alice", "avatar_url": "https://a"}
        )
    )
    result = github_app.fetch_user(access_token="ghu_X")
    assert result["login"] == "alice"
    # Verify Bearer header
    sent = route.calls[0].request
    assert sent.headers["Authorization"] == "Bearer ghu_X"
    assert sent.headers["Accept"] == "application/vnd.github+json"


@respx.mock
def test_fetch_user_raises_unreachable_on_401():
    respx.get(github_app._USER_URL).mock(
        return_value=httpx.Response(401, json={"message": "Bad credentials"})
    )
    with pytest.raises(ApplicationError) as exc:
        github_app.fetch_user(access_token="ghu_bad")
    assert exc.value.message == "github_unreachable"
    assert exc.value.status == 502


@respx.mock
def test_fetch_user_raises_unreachable_on_network_error():
    respx.get(github_app._USER_URL).mock(side_effect=httpx.ConnectError("network down"))
    with pytest.raises(ApplicationError) as exc:
        github_app.fetch_user(access_token="ghu_X")
    assert exc.value.message == "github_unreachable"
    assert exc.value.status == 502


def test_mint_installation_token_is_stub():
    with pytest.raises(NotImplementedError):
        github_app.mint_installation_token(installation_id=1)
