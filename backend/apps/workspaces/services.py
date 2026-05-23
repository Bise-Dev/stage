import json
import uuid

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.core.exceptions import ApplicationError
from apps.users.models import User
from apps.workspaces.models import Storyline, StorylineFile, Workspace


def _new_etag() -> str:
    return str(uuid.uuid4())


@transaction.atomic
def storyline_create(*, workspace: Workspace, author: User) -> Storyline:
    return Storyline.objects.create(
        workspace=workspace,
        raw_json=json.dumps({"files": []}),
        etag=_new_etag(),
        updated_by=author,
    )


@transaction.atomic
def storyline_replace(
    *,
    workspace: Workspace,
    user: User,
    files: list[dict],
    if_match: str,
    gateway,
) -> str:
    if user.pk != workspace.created_by_id:
        raise ApplicationError(
            "Only the workspace creator can edit the storyline",
            extra={"workspace_id": str(workspace.id)},
            status=403,
        )

    if workspace.pr_number is not None:
        pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
        if pr.get("state") == "closed":
            raise ApplicationError(
                "workspace_frozen",
                extra={"workspace_id": str(workspace.id)},
                status=409,
            )

    s = Storyline.objects.select_for_update().get(workspace=workspace)
    if s.etag != if_match:
        raise ApplicationError(
            "etag_mismatch",
            extra={"current_etag": s.etag},
            status=409,
        )

    StorylineFile.objects.filter(storyline=s).delete()
    StorylineFile.objects.bulk_create([
        StorylineFile(
            storyline=s,
            diff_file_path=f["diff_file_path"],
            order_index=f.get("order_index", idx),
            title=f.get("title", ""),
            intro_text=f.get("intro_text", ""),
        )
        for idx, f in enumerate(files)
    ])

    s.raw_json = json.dumps({"files": files})
    s.etag = _new_etag()
    s.updated_by = user
    s.save(update_fields=["raw_json", "etag", "updated_by", "updated_at"])

    Workspace.objects.filter(pk=workspace.pk).update(last_active_at=timezone.now())

    return s.etag


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
        ws = Workspace.objects.create(
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
    storyline_create(workspace=ws, author=creator)
    return ws


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
