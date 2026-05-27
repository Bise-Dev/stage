from typing import cast

import pytest
from django.db import IntegrityError

from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_user_has_github_fields() -> None:
    user = cast(User, UserFactory(github_login="alice", github_user_id=42))
    assert user.github_login == "alice"
    assert user.github_user_id == 42
    assert user.display_name == ""
    assert user.avatar_url == ""
    assert user.last_login_at is None


@pytest.mark.django_db
def test_user_github_login_unique() -> None:
    UserFactory(github_login="alice", github_user_id=1)
    with pytest.raises(IntegrityError):
        UserFactory(github_login="alice", github_user_id=2)


@pytest.mark.django_db
def test_user_github_user_id_unique() -> None:
    UserFactory(github_login="alice", github_user_id=1)
    with pytest.raises(IntegrityError):
        UserFactory(github_login="bob", github_user_id=1)
