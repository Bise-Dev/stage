from rest_framework import serializers


class PullRequestReviewCreateInputSerializer(serializers.Serializer):
    body = serializers.CharField()
    event = serializers.CharField()
    comments = serializers.ListField(child=serializers.DictField(), required=False, default=list)
