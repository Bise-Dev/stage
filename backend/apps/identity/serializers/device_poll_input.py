from rest_framework import serializers


class DevicePollInputSerializer(serializers.Serializer):
    device_code = serializers.CharField()
