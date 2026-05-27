from rest_framework import serializers

from apps.identity.serializers.user_output import UserOutputSerializer


class WebExchangeOutputSerializer(serializers.Serializer):
    status = serializers.CharField()
    session_token = serializers.CharField()
    user = UserOutputSerializer()
