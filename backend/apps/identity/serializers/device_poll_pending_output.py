from rest_framework import serializers


class DevicePollPendingOutputSerializer(serializers.Serializer):
    status = serializers.CharField(default="pending")
