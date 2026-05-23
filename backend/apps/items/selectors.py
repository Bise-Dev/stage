import uuid

from django.db.models import QuerySet

from apps.items.models import Item


def item_list(
    *,
    status: str | None = None,
    owner_id: int | None = None,
    name_contains: str | None = None,
) -> QuerySet[Item]:
    qs = Item.objects.select_related("owner").all()
    if status is not None:
        qs = qs.filter(status=status)
    if owner_id is not None:
        qs = qs.filter(owner_id=owner_id)
    if name_contains is not None:
        qs = qs.filter(name__icontains=name_contains)
    return qs


def item_get(*, item_id: uuid.UUID) -> Item:
    return Item.objects.select_related("owner").get(id=item_id)
