from typing import cast

import pytest

from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_user_factory_creates_persisted_user() -> None:
    user = cast(User, UserFactory())

    assert user.pk is not None
    assert User.objects.filter(pk=user.pk).exists()
    assert user.email.endswith("@example.com")
