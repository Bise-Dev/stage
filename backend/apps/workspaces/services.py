import json
import uuid

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.core.exceptions import ApplicationError
from apps.users.models import User
from apps.workspaces.models import IntroComment, Storyline, StorylineFile, Workspace


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


def _assert_not_frozen(workspace: Workspace, gateway) -> None:
    if workspace.pr_number is not None:
        pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
        if pr.get("state") == "closed":
            raise ApplicationError("workspace_frozen", status=409)


@transaction.atomic
def intro_comment_create(
    *,
    storyline_file: StorylineFile,
    user: User,
    body: str,
    parent: IntroComment | None = None,
    gateway,
) -> IntroComment:
    workspace = storyline_file.storyline.workspace
    _assert_not_frozen(workspace, gateway)
    if parent is not None and parent.parent_id is not None:
        raise ApplicationError("depth_exceeded", status=400)
    return IntroComment.objects.create(
        storyline_file=storyline_file, user=user, body=body, parent=parent,
    )


@transaction.atomic
def intro_comment_update(*, comment: IntroComment, user: User, body: str) -> IntroComment:
    if comment.user_id != user.pk:
        raise ApplicationError("not_owner", status=403)
    if comment.deleted_at is not None:
        raise ApplicationError("comment_deleted", status=409)
    comment.body = body
    comment.save(update_fields=["body", "updated_at"])
    return comment


@transaction.atomic
def intro_comment_soft_delete(*, comment: IntroComment, user: User) -> None:
    if comment.user_id != user.pk:
        raise ApplicationError("not_owner", status=403)
    comment.deleted_at = timezone.now()
    comment.save(update_fields=["deleted_at", "updated_at"])


@transaction.atomic
def intro_comment_resolve(*, comment: IntroComment, creator: User) -> IntroComment:
    workspace = comment.storyline_file.storyline.workspace
    if creator.pk != workspace.created_by_id:
        raise ApplicationError("not_creator", status=403)
    if comment.parent_id is not None:
        raise ApplicationError("only_roots_can_be_resolved", status=400)
    comment.resolved_at = timezone.now()
    comment.resolved_by = creator
    comment.save(update_fields=["resolved_at", "resolved_by", "updated_at"])
    return comment


@transaction.atomic
def intro_comment_unresolve(*, comment: IntroComment, creator: User) -> IntroComment:
    workspace = comment.storyline_file.storyline.workspace
    if creator.pk != workspace.created_by_id:
        raise ApplicationError("not_creator", status=403)
    comment.resolved_at = None
    comment.resolved_by = None
    comment.save(update_fields=["resolved_at", "resolved_by", "updated_at"])
    return comment


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
