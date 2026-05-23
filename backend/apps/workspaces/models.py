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


class Storyline(BaseModel):
    workspace = models.OneToOneField(Workspace, on_delete=models.CASCADE, related_name="storyline")
    etag = models.CharField(max_length=36)
    updated_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="storyline_updates")

    class Meta:  # pyrefly: ignore[bad-override]
        db_table = "storyline"


class StorylineFile(BaseModel):
    storyline = models.ForeignKey(Storyline, on_delete=models.CASCADE, related_name="files")
    diff_file_path = models.CharField(max_length=1024)
    order_index = models.IntegerField()
    title = models.CharField(max_length=255, blank=True, default="")
    intro_text = models.TextField(blank=True, default="")

    class Meta:  # pyrefly: ignore[bad-override]
        db_table = "storyline_file"
        ordering = ["order_index"]
        constraints = [
            models.UniqueConstraint(fields=["storyline", "diff_file_path"], name="uniq_storyline_file_path"),
        ]


class IntroComment(BaseModel):
    storyline_file = models.ForeignKey(StorylineFile, on_delete=models.CASCADE, related_name="intro_comments")
    user = models.ForeignKey(User, on_delete=models.PROTECT, related_name="intro_comments")
    body = models.TextField()
    parent = models.ForeignKey("self", on_delete=models.CASCADE, null=True, blank=True, related_name="replies")
    deleted_at = models.DateTimeField(null=True, blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolved_by = models.ForeignKey(User, on_delete=models.PROTECT, null=True, blank=True, related_name="intro_comments_resolved")

    class Meta:  # pyrefly: ignore[bad-override]
        db_table = "intro_comment"
        ordering = ["created_at"]
        constraints = [
            models.CheckConstraint(
                name="intro_comment_replies_have_no_resolution",
                condition=(
                    models.Q(parent__isnull=True)
                    | (models.Q(resolved_at__isnull=True) & models.Q(resolved_by__isnull=True))
                ),
            ),
        ]
