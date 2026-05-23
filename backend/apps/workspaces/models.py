from django.db import models

from apps.core.models import BaseModel
from apps.users.models import User


class Workspace(BaseModel):
    repo_owner = models.CharField(max_length=255)
    repo_name = models.CharField(max_length=255)
    head_ref = models.CharField(max_length=255)
    base_ref = models.CharField(max_length=255)
    pr_number = models.IntegerField(null=True, blank=True)
    pr_opened_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="created_workspaces")
    last_active_at = models.DateTimeField(auto_now=True)

    class Meta:  # pyrefly: ignore[bad-override]
        db_table = "workspace"
        constraints = [
            models.UniqueConstraint(
                fields=["repo_owner", "repo_name", "head_ref"],
                name="uniq_workspace_repo_head",
            ),
            models.UniqueConstraint(
                fields=["repo_owner", "repo_name", "pr_number"],
                name="uniq_workspace_repo_pr",
                condition=models.Q(pr_number__isnull=False),
            ),
        ]
