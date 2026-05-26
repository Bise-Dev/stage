import httpx
import structlog

from apps.core.exceptions import ApplicationError
from config.settings.env_schemas import env

logger = structlog.get_logger(__name__)

_DEVICE_CODE_URL = "https://github.com/login/device/code"
_TOKEN_URL = "https://github.com/login/oauth/access_token"
_USER_URL = f"{env.GITHUB_API_BASE}/user"

_TERMINAL_ERRORS = {
    "expired_token",
    "access_denied",
    "incorrect_device_code",
    "unsupported_grant_type",
}
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
