import hashlib

from django.utils import timezone

from apps.identity.models import Session
from apps.users.models import User


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def session_find_user(*, raw_token: str) -> User | None:
    try:
        session = Session.objects.select_related("user").get(
            token_hash=_hash_token(raw_token),
            revoked_at__isnull=True,
        )
    except Session.DoesNotExist:
        return None
    Session.objects.filter(pk=session.pk).update(last_used_at=timezone.now())
    return session.user
