import httpx
import structlog

from apps.core.exceptions import ApplicationError
from config.settings.env_schemas import env

logger = structlog.get_logger(__name__)

_TOKEN_URL = "https://github.com/login/oauth/access_token"
_USER_URL = f"{env.GITHUB_API_BASE}/user"
_REQUEST_TIMEOUT_S = 10.0


def _post_token_endpoint(data: dict) -> dict:
    """POST to the GitHub OAuth token endpoint. Maps httpx errors to spec §6.2 slugs.

    Returns the parsed JSON body (which may contain an `error` key; callers decide
    how to interpret error slugs like `bad_verification_code` vs `bad_refresh_token`).
    """
    try:
        r = httpx.post(
            _TOKEN_URL,
            data=data,
            headers={"Accept": "application/json"},
            timeout=_REQUEST_TIMEOUT_S,
        )
        r.raise_for_status()
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status == 401:
            logger.error("github_app_misconfigured", status=status)
            raise ApplicationError("github_app_misconfigured", status=500) from exc
        logger.warning("github_unreachable", status=status)
        raise ApplicationError("github_unreachable", status=502) from exc
    except httpx.RequestError as exc:
        logger.warning("github_unreachable", error=str(exc))
        raise ApplicationError("github_unreachable", status=502) from exc
    return r.json()


def exchange_code(*, code: str, code_verifier: str, redirect_uri: str) -> dict:
    """Exchange an OAuth code for user-to-server tokens. Returns the GitHub payload."""
    body = _post_token_endpoint(
        {
            "client_id": env.GITHUB_APP_CLIENT_ID,
            "client_secret": env.GITHUB_APP_CLIENT_SECRET,
            "code": code,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
        }
    )
    err = body.get("error")
    if err:
        logger.warning("github_code_exchange_error", error=err)
        raise ApplicationError(
            "github_code_invalid",
            extra={"error": err},
            status=400,
        )
    logger.info("github_code_exchange_ok")
    return body


def refresh(*, refresh_token: str) -> dict:
    """Refresh a user-to-server token. Returns the new GitHub payload."""
    body = _post_token_endpoint(
        {
            "client_id": env.GITHUB_APP_CLIENT_ID,
            "client_secret": env.GITHUB_APP_CLIENT_SECRET,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }
    )
    err = body.get("error")
    if err:
        logger.warning("github_refresh_error", error=err)
        raise ApplicationError(
            "github_reauth_required",
            extra={"error": err},
            status=401,
        )
    logger.info("github_refresh_ok")
    return body


def fetch_user(*, access_token: str) -> dict:
    """GET /user with the provided access token. Returns the GitHub user profile."""
    try:
        r = httpx.get(
            _USER_URL,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/vnd.github+json",
            },
            timeout=_REQUEST_TIMEOUT_S,
        )
        r.raise_for_status()
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        logger.warning("github_unreachable", path="/user", status=status)
        raise ApplicationError("github_unreachable", status=502) from exc
    except httpx.RequestError as exc:
        logger.warning("github_unreachable", path="/user", error=str(exc))
        raise ApplicationError("github_unreachable", status=502) from exc
    return r.json()


def mint_installation_token(*, installation_id: int) -> dict:
    """Mints an installation access token (bot-mode). Out of scope this slice."""
    raise NotImplementedError("Bot-mode installation tokens land in a follow-up.")
