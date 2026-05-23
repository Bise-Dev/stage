from typing import cast

import pytest

from apps.core.exceptions import ApplicationError
from apps.items.factories import ItemFactory
from apps.items.models import Item, ItemStatus
from apps.items.services import item_archive, item_create, item_update
from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_item_create_persists_with_owner() -> None:
    owner = cast(User, UserFactory())
    item = item_create(owner=owner, name="widget", description="hi", quantity=3)

    assert item.pk is not None
    assert item.owner.pk == owner.pk
    assert Item.objects.filter(pk=item.pk).exists()


@pytest.mark.django_db
def test_item_archive_transitions_status() -> None:
    item = cast(Item, ItemFactory(status=ItemStatus.ACTIVE))
    archived = item_archive(item=item)
    assert archived.status == ItemStatus.ARCHIVED


@pytest.mark.django_db
def test_item_archive_rejects_already_archived() -> None:
    item = cast(Item, ItemFactory(status=ItemStatus.ARCHIVED))
    with pytest.raises(ApplicationError):
        item_archive(item=item)


@pytest.mark.django_db
def test_item_update_changes_fields() -> None:
    item = cast(Item, ItemFactory())
    updated = item_update(item=item, name="renamed", quantity=99)
    assert updated.name == "renamed"
    assert updated.quantity == 99
