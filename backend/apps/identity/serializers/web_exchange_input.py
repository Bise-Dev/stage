from rest_framework import serializers


class WebExchangeInputSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=512)
    code_verifier = serializers.CharField(min_length=43, max_length=128)
    redirect_uri = serializers.URLField()
