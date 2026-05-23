from rest_framework import serializers

from apps.identity.serializers.user_output import UserOutputSerializer


class DevicePollOkOutputSerializer(serializers.Serializer):
    status = serializers.CharField(default="ok")
    session_token = serializers.CharField()
    user = UserOutputSerializer()
