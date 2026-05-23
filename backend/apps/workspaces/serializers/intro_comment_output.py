from rest_framework import serializers


class IntroCommentOutputSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    user = serializers.DictField()
    body = serializers.CharField()
    parent_id = serializers.UUIDField(allow_null=True)
    created_at = serializers.DateTimeField()
    resolved_at = serializers.DateTimeField(allow_null=True)
    resolved_by = serializers.DictField(allow_null=True)
    replies = serializers.ListField(child=serializers.DictField())
