from django.contrib import admin
from unfold.admin import ModelAdmin, TabularInline

from apps.workspaces.models import (
    IntroComment,
    Storyline,
    StorylineFile,
    Workspace,
)


@admin.register(Workspace)
class WorkspaceAdmin(ModelAdmin):
    list_display = [  # noqa: RUF012
        "repo_owner",
        "repo_name",
        "head_ref",
        "pr_number",
        "created_by",
        "last_active_at",
    ]
    list_filter = ["repo_owner", "pr_opened_at", "last_active_at", "created_at"]  # noqa: RUF012
    search_fields = ["repo_owner", "repo_name", "head_ref", "base_ref"]  # noqa: RUF012
    autocomplete_fields = ["created_by"]  # noqa: RUF012
    readonly_fields = ["created_at", "updated_at", "last_active_at"]  # noqa: RUF012
    ordering = ["-last_active_at"]  # noqa: RUF012


class StorylineFileInline(TabularInline):
    model = StorylineFile
    extra = 0
    fields = ["order_index", "diff_file_path"]  # noqa: RUF012
    ordering = ["order_index"]  # noqa: RUF012


@admin.register(Storyline)
class StorylineAdmin(ModelAdmin):
    list_display = ["workspace", "etag", "updated_by", "updated_at"]  # noqa: RUF012
    search_fields = ["workspace__title", "workspace__repo_name"]  # noqa: RUF012
    autocomplete_fields = ["workspace", "updated_by"]  # noqa: RUF012
    readonly_fields = ["created_at", "updated_at"]  # noqa: RUF012
    inlines = [StorylineFileInline]  # noqa: RUF012


@admin.register(StorylineFile)
class StorylineFileAdmin(ModelAdmin):
    list_display = ["diff_file_path", "order_index", "storyline"]  # noqa: RUF012
    list_filter = ["storyline__workspace__repo_owner"]  # noqa: RUF012
    search_fields = ["diff_file_path"]  # noqa: RUF012
    autocomplete_fields = ["storyline"]  # noqa: RUF012
    readonly_fields = ["created_at", "updated_at"]  # noqa: RUF012
    ordering = ["storyline", "order_index"]  # noqa: RUF012


@admin.register(IntroComment)
class IntroCommentAdmin(ModelAdmin):
    list_display = [  # noqa: RUF012
        "user",
        "storyline_file",
        "parent",
        "resolved_at",
        "deleted_at",
        "created_at",
    ]
    list_filter = ["resolved_at", "deleted_at", "created_at"]  # noqa: RUF012
    search_fields = ["body", "user__username"]  # noqa: RUF012
    autocomplete_fields = ["storyline_file", "user", "parent", "resolved_by"]  # noqa: RUF012
    readonly_fields = ["created_at", "updated_at"]  # noqa: RUF012
    ordering = ["-created_at"]  # noqa: RUF012
