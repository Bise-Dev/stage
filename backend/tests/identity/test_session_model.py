from typing import cast

import pytest

from apps.identity.factories import SessionFactory
from apps.identity.models import Session
from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_session_links_to_user() -> None:
    user = cast(User, UserFactory())
    session = cast(Session, SessionFactory(user=user))
    assert session.user_id == user.pk
    assert session.revoked_at is None
    assert session.token_hash


@pytest.mark.django_db
def test_session_token_hash_is_indexed() -> None:
    Session._meta.get_field("token_hash")  # raises if absent
