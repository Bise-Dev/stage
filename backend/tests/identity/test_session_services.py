from typing import cast

import pytest

from apps.identity.selectors import session_find_user
from apps.identity.services import session_issue, session_revoke
from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_session_issue_returns_token_and_persists_only_hash() -> None:
    user = cast(User, UserFactory())
    raw, session = session_issue(user=user)

    assert isinstance(raw, str) and raw.startswith("stg_")
    assert len(raw) > 20
    session.refresh_from_db()
    assert session.token_hash and session.token_hash != raw


@pytest.mark.django_db
def test_session_revoke_sets_timestamp() -> None:
    user = cast(User, UserFactory())
    _, session = session_issue(user=user)
    session_revoke(session=session)
    session.refresh_from_db()
    assert session.revoked_at is not None
