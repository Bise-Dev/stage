from typing import cast

import pytest

from apps.items.factories import ItemFactory
from apps.items.models import Item, ItemStatus
from apps.items.selectors import item_list


@pytest.mark.django_db
def test_item_list_filters_by_status() -> None:
    cast(Item, ItemFactory(status=ItemStatus.ACTIVE))
    cast(Item, ItemFactory(status=ItemStatus.ARCHIVED))

    active = list(item_list(status=ItemStatus.ACTIVE.value))

    assert len(active) == 1
    assert active[0].status == ItemStatus.ACTIVE


@pytest.mark.django_db
def test_item_list_filters_by_name_contains() -> None:
    cast(Item, ItemFactory(name="hammer"))
    cast(Item, ItemFactory(name="nail"))

    matches = list(item_list(name_contains="ham"))

    assert len(matches) == 1
    assert matches[0].name == "hammer"
