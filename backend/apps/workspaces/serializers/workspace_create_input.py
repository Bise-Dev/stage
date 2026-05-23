from rest_framework import serializers


class WorkspaceCreateInputSerializer(serializers.Serializer):
    repo_owner = serializers.CharField(max_length=255)
    repo_name = serializers.CharField(max_length=255)
    head_ref = serializers.CharField(max_length=255)
    base_ref = serializers.CharField(max_length=255, required=False, default="main")
