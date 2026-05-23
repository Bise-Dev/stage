from rest_framework import serializers

from apps.workspaces.serializers.workspace_output import WorkspaceOutputSerializer


class OpenPrOutputSerializer(serializers.Serializer):
    workspace = WorkspaceOutputSerializer()
    pr = serializers.DictField()
    warnings = serializers.ListField(child=serializers.CharField())
