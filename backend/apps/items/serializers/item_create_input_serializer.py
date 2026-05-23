from rest_framework import serializers


class ItemCreateInputSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255)
    description = serializers.CharField(required=False, allow_blank=True, default="")
    quantity = serializers.IntegerField(min_value=0, required=False, default=0)
    owner_id = serializers.IntegerField()
