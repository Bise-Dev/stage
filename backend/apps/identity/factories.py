import hashlib
import secrets

import factory
from factory.django import DjangoModelFactory

from apps.identity.models import Session
from apps.users.factories import UserFactory


class SessionFactory(DjangoModelFactory):
    class Meta:
        model = Session

    user = factory.SubFactory(UserFactory)
    token_hash = factory.LazyFunction(
        lambda: hashlib.sha256(secrets.token_urlsafe(32).encode()).hexdigest()
    )
