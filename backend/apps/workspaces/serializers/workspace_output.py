from rest_framework import serializers

from apps.workspaces.models import Workspace


class WorkspaceOutputSerializer(serializers.ModelSerializer):
    created_by = serializers.SerializerMethodField()

    class Meta:  # pyrefly: ignore[bad-override]
        model = Workspace
        fields = (
            "id",
            "repo_owner",
            "repo_name",
            "head_ref",
            "base_ref",
            "title",
            "pr_number",
            "pr_opened_at",
            "created_by",
            "created_at",
            "last_active_at",
        )

    def get_created_by(self, obj: Workspace) -> dict:
        u = obj.created_by
        return {"id": u.pk, "github_login": u.github_login}
