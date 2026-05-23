from typing import cast

import pytest

from apps.identity.selectors import session_find_user
from apps.identity.services import session_issue, session_revoke
from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_session_find_user_returns_user_for_valid_token() -> None:
    user = cast(User, UserFactory())
    raw, _ = session_issue(user=user)
    assert session_find_user(raw_token=raw) == user


@pytest.mark.django_db
def test_session_find_user_returns_none_for_revoked() -> None:
    user = cast(User, UserFactory())
    raw, session = session_issue(user=user)
    session_revoke(session=session)
    assert session_find_user(raw_token=raw) is None


@pytest.mark.django_db
def test_session_find_user_returns_none_for_unknown() -> None:
    assert session_find_user(raw_token="not-a-real-token") is None
