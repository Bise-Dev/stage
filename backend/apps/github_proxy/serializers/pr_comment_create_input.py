from rest_framework import serializers


class PullRequestCommentCreateInputSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=["issue", "review"])
    body = serializers.CharField()
    path = serializers.CharField(required=False, default=None, allow_null=True)
    line = serializers.IntegerField(required=False, default=None, allow_null=True)
    side = serializers.ChoiceField(
        choices=["LEFT", "RIGHT"], required=False, default=None, allow_null=True
    )
    commit_id = serializers.CharField(required=False, default=None, allow_null=True)
    in_reply_to = serializers.IntegerField(required=False, default=None, allow_null=True)

    def validate(self, attrs):
        if attrs["kind"] == "review" and attrs.get("in_reply_to") is None:
            missing = [f for f in ("path", "line", "side") if not attrs.get(f)]
            if missing:
                raise serializers.ValidationError(
                    {f: "required for kind=review without in_reply_to" for f in missing}
                )
        return attrs
