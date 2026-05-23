import uuid

from django.db.models import QuerySet

from apps.workspaces.models import Workspace


def workspace_list() -> QuerySet[Workspace]:
    return (
        Workspace.objects.select_related("created_by")
        .all()
        .order_by("-last_active_at")
    )


def workspace_get(*, workspace_id: uuid.UUID) -> Workspace:
    return Workspace.objects.select_related("created_by").get(pk=workspace_id)


def workspace_lookup(*, repo_owner: str, repo_name: str, pr_number: int) -> Workspace | None:
    return (
        Workspace.objects.select_related("created_by")
        .filter(repo_owner=repo_owner, repo_name=repo_name, pr_number=pr_number)
        .first()
    )
