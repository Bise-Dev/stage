import datetime as dt
import hashlib
import secrets

import factory
from django.utils import timezone
from factory.django import DjangoModelFactory

from apps.identity.models import GitHubIdentity, Session
from apps.users.factories import UserFactory


class SessionFactory(DjangoModelFactory):
    class Meta:
        model = Session

    user = factory.SubFactory(UserFactory)
    token_hash = factory.LazyFunction(
        lambda: hashlib.sha256(secrets.token_urlsafe(32).encode()).hexdigest()
    )


class GitHubIdentityFactory(DjangoModelFactory):
    class Meta:
        model = GitHubIdentity

    user = factory.SubFactory(UserFactory)
    access_token = factory.Sequence(lambda n: f"ghu_test_access_{n}")
    refresh_token = factory.Sequence(lambda n: f"ghr_test_refresh_{n}")
    access_token_expires_at = factory.LazyFunction(lambda: timezone.now() + dt.timedelta(hours=8))
    refresh_token_expires_at = factory.LazyFunction(lambda: timezone.now() + dt.timedelta(days=180))
