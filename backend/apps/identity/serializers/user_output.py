from rest_framework import serializers

from apps.users.models import User


class UserOutputSerializer(serializers.ModelSerializer):
    class Meta:  # pyrefly: ignore[bad-override]
        model = User
        fields = (
            "id",
            "github_login",
            "github_user_id",
            "display_name",
            "avatar_url",
        )
