from rest_framework import serializers


class WorkspaceLookupOutputSerializer(serializers.Serializer):
    workspace_id = serializers.UUIDField()
    created_by = serializers.DictField()
