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
