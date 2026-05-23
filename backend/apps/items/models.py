from django.conf import settings
from django.db import models

from apps.core.models import BaseModel


class ItemStatus(models.TextChoices):
    ACTIVE = "active", "Active"
    ARCHIVED = "archived", "Archived"


class Item(BaseModel):
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    quantity = models.PositiveIntegerField(default=0)
    status = models.CharField(
        max_length=16,
        choices=ItemStatus.choices,
        default=ItemStatus.ACTIVE,
    )
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="items",
    )

    def __str__(self) -> str:
        return self.name
