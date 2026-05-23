from rest_framework import serializers


class PullRequestMergeInputSerializer(serializers.Serializer):
    method = serializers.ChoiceField(choices=["merge", "squash", "rebase"], default="merge")
