from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction

from apps.core.exceptions import ApplicationError
from apps.users.models import User
from apps.workspaces.models import Workspace


@transaction.atomic
def workspace_create(
    *,
    creator: User,
    repo_owner: str,
    repo_name: str,
    head_ref: str,
    base_ref: str,
) -> Workspace:
    try:
        return Workspace.objects.create(
            created_by=creator,
            repo_owner=repo_owner,
            repo_name=repo_name,
            head_ref=head_ref,
            base_ref=base_ref,
        )
    except (IntegrityError, DjangoValidationError) as exc:
        raise ApplicationError(
            "Workspace already exists for that repo + head_ref",
            extra={"repo_owner": repo_owner, "repo_name": repo_name, "head_ref": head_ref},
            status=409,
        ) from exc


@transaction.atomic
def workspace_update_local_phase(
    *,
    workspace: Workspace,
    head_ref: str | None = None,
    base_ref: str | None = None,
) -> Workspace:
    if workspace.pr_number is not None:
        raise ApplicationError(
            "head_ref / base_ref not editable once a PR is open",
            extra={"workspace_id": str(workspace.id)},
            status=409,
        )
    if head_ref is not None:
        workspace.head_ref = head_ref
    if base_ref is not None:
        workspace.base_ref = base_ref
    try:
        workspace.save(update_fields=["head_ref", "base_ref", "updated_at"])
    except (IntegrityError, DjangoValidationError) as exc:
        raise ApplicationError(
            "Update collides with existing workspace",
            extra={"workspace_id": str(workspace.id)},
            status=409,
        ) from exc
    return workspace
