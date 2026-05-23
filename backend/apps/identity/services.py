import hashlib
import secrets

from django.db import transaction
from django.utils import timezone

from apps.identity.models import Session
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
