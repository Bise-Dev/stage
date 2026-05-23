from rest_framework import serializers


class IntroCommentCreateInputSerializer(serializers.Serializer):
    body = serializers.CharField()
    parent_id = serializers.UUIDField(required=False, allow_null=True, default=None)
