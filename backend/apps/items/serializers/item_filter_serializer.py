from rest_framework import serializers

from apps.items.models import ItemStatus


class ItemFilterSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=ItemStatus.choices, required=False)
    owner_id = serializers.IntegerField(required=False)
    name_contains = serializers.CharField(required=False)
