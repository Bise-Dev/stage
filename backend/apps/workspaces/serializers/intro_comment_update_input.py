from rest_framework import serializers


class IntroCommentUpdateInputSerializer(serializers.Serializer):
    body = serializers.CharField()
