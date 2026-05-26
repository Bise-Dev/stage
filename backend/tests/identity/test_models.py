from typing import cast

import pytest
from django.core.exceptions import ValidationError
from django.utils import timezone

from apps.identity.factories import GitHubIdentityFactory
from apps.identity.models import GitHubIdentity


@pytest.mark.django_db
def test_github_identity_factory_creates_row():
    identity = cast(GitHubIdentity, GitHubIdentityFactory())
    assert identity.pk is not None
    assert identity.access_token.startswith("ghu_test_access_")
    assert identity.refresh_token.startswith("ghr_test_refresh_")
    assert identity.access_token_expires_at > timezone.now()
    assert identity.refresh_token_expires_at > identity.access_token_expires_at


@pytest.mark.django_db
def test_github_identity_one_per_user():
    identity = cast(GitHubIdentity, GitHubIdentityFactory())
    # OneToOne ⇒ second attempt for same user must fail. BaseModel.save() calls
    # full_clean() before super().save(), so ValidationError fires before the
    # DB IntegrityError; we assert on ValidationError specifically.
    with pytest.raises(ValidationError):
        GitHubIdentityFactory(user=identity.user)
