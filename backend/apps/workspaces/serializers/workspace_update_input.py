from rest_framework import serializers


class WorkspaceUpdateInputSerializer(serializers.Serializer):
    head_ref = serializers.CharField(max_length=255, required=False)
    base_ref = serializers.CharField(max_length=255, required=False)
