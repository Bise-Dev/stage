from rest_framework import serializers

from apps.items.models import Item


class ItemOutputSerializer(serializers.ModelSerializer):
    class Meta:  # pyrefly: ignore[bad-override]
        model = Item
        fields = (
            "id",
            "name",
            "description",
            "quantity",
            "status",
            "owner",
            "created_at",
            "updated_at",
        )
