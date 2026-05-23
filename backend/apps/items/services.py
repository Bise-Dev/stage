from django.db import transaction

from apps.core.exceptions import ApplicationError
from apps.items.models import Item, ItemStatus
from apps.users.models import User


@transaction.atomic
def item_create(
    *,
    owner: User,
    name: str,
    description: str = "",
    quantity: int = 0,
) -> Item:
    return Item.objects.create(
        owner=owner,
        name=name,
        description=description,
        quantity=quantity,
    )


@transaction.atomic
def item_update(
    *,
    item: Item,
    name: str | None = None,
    description: str | None = None,
    quantity: int | None = None,
) -> Item:
    if name is not None:
        item.name = name
    if description is not None:
        item.description = description
    if quantity is not None:
        item.quantity = quantity
    item.save()
    return item


@transaction.atomic
def item_archive(*, item: Item) -> Item:
    if item.status == ItemStatus.ARCHIVED:
        raise ApplicationError(
            "Item is already archived",
            extra={"item_id": str(item.id)},
        )
    item.status = ItemStatus.ARCHIVED
    item.save()
    return item


@transaction.atomic
def item_delete(*, item: Item) -> None:
    item.delete()
