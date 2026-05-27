import datetime as dt
import hashlib
import secrets

from django.db import transaction
from django.utils import timezone

from apps.core.exceptions import ApplicationError
from apps.identity import github_app
from apps.identity.models import GitHubIdentity, Session
from apps.users.models import User


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


@transaction.atomic
def session_issue(*, user: User) -> tuple[str, Session]:
    raw = "stg_" + secrets.token_urlsafe(32)
    session = Session.objects.create(user=user, token_hash=_hash_token(raw))
    return raw, session


@transaction.atomic
def session_revoke(*, session: Session) -> None:
    session.revoked_at = timezone.now()
    session.save(update_fields=["revoked_at", "updated_at"])


@transaction.atomic
def user_upsert_from_github(*, github_payload: dict) -> User:
    user, _ = User.objects.update_or_create(
        github_user_id=github_payload["id"],
        defaults={
            "username": github_payload["login"],
            "github_login": github_payload["login"],
            "display_name": github_payload.get("name") or "",
            "avatar_url": github_payload.get("avatar_url") or "",
            "last_login_at": timezone.now(),
        },
    )
    return user


@transaction.atomic
def github_identity_upsert(*, user: User, payload: dict) -> GitHubIdentity:
    now = timezone.now()
    identity, _ = GitHubIdentity.objects.update_or_create(
        user=user,
        defaults={
            "access_token": payload["access_token"],
            "refresh_token": payload["refresh_token"],
            "access_token_expires_at": now + dt.timedelta(seconds=payload["expires_in"]),
            "refresh_token_expires_at": now
            + dt.timedelta(seconds=payload["refresh_token_expires_in"]),
        },
    )
    return identity


def github_identity_ensure_fresh(*, identity: GitHubIdentity) -> GitHubIdentity:
    """Refresh the access token if it expires within 60 s.

    Deletes identity + raises on bad_refresh_token.
    """
    threshold = timezone.now() + dt.timedelta(seconds=60)
    if identity.access_token_expires_at > threshold:
        return identity
    user = identity.user
    try:
        new_payload = github_app.refresh(refresh_token=identity.refresh_token)
    except ApplicationError as exc:
        if exc.message == "github_reauth_required":
            identity.delete()
        raise
    return github_identity_upsert(user=user, payload=new_payload)
