from typing import cast

import pytest
from rest_framework.test import APIClient

from apps.items.factories import ItemFactory
from apps.items.models import Item, ItemStatus
from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.mark.django_db
def test_item_create_returns_201_and_persists() -> None:
    owner = cast(User, UserFactory())
    client = APIClient()

    response = client.post(
        "/api/v1/items/create/",
        data={"name": "widget", "quantity": 5, "owner_id": owner.pk},
        format="json",
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "widget"
    assert body["quantity"] == 5
    assert body["owner"] == owner.pk
    assert Item.objects.filter(pk=body["id"]).exists()


@pytest.mark.django_db
def test_item_archive_twice_returns_application_error_shape() -> None:
    item = cast(Item, ItemFactory(status=ItemStatus.ARCHIVED))
    client = APIClient()

    response = client.post(f"/api/v1/items/{item.pk}/archive/")

    assert response.status_code == 400
    body = response.json()
    assert body == {
        "message": "Item is already archived",
        "extra": {"item_id": str(item.pk)},
    }
