import factory
from factory.django import DjangoModelFactory

from apps.items.models import Item, ItemStatus
from apps.users.factories import UserFactory


class ItemFactory(DjangoModelFactory):
    class Meta:
        model = Item

    name = factory.Sequence(lambda n: f"item-{n}")
    description = factory.Faker("sentence")
    quantity = factory.Faker("pyint", min_value=0, max_value=100)
    status = ItemStatus.ACTIVE
    owner = factory.SubFactory(UserFactory)
