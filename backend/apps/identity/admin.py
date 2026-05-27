from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.identity.models import GitHubIdentity, Session


@admin.register(Session)
class SessionAdmin(ModelAdmin):
    list_display = ["user", "last_used_at", "revoked_at", "created_at"]  # noqa: RUF012
    list_filter = ["revoked_at", "last_used_at", "created_at"]  # noqa: RUF012
    search_fields = ["user__username", "user__email"]  # noqa: RUF012
    autocomplete_fields = ["user"]  # noqa: RUF012
    # token_hash is a credential-derived secret — exclude it from the form.
    exclude = ["token_hash"]  # noqa: RUF012
    readonly_fields = ["created_at", "updated_at", "last_used_at"]  # noqa: RUF012
    ordering = ["-last_used_at"]  # noqa: RUF012


@admin.register(GitHubIdentity)
class GitHubIdentityAdmin(ModelAdmin):
    list_display = [  # noqa: RUF012
        "user",
        "access_token_expires_at",
        "refresh_token_expires_at",
        "created_at",
    ]
    list_filter = ["access_token_expires_at", "refresh_token_expires_at"]  # noqa: RUF012
    search_fields = ["user__username", "user__email"]  # noqa: RUF012
    autocomplete_fields = ["user"]  # noqa: RUF012
    # OAuth tokens are secrets — never surface them in the admin form.
    exclude = ["access_token", "refresh_token"]  # noqa: RUF012
    readonly_fields = ["created_at", "updated_at"]  # noqa: RUF012
