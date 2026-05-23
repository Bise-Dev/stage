from rest_framework import serializers


class OpenPrInputSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=255)
    body = serializers.CharField(required=False, allow_blank=True, default="")
    reviewers = serializers.ListField(child=serializers.CharField(), required=False, default=list)
    labels = serializers.ListField(child=serializers.CharField(), required=False, default=list)
    draft = serializers.BooleanField(required=False, default=False)
