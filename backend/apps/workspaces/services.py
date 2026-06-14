import uuid
from datetime import datetime

import structlog
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.core.exceptions import ApplicationError
from apps.github_proxy.exceptions import GithubError
from apps.users.models import User
from apps.workspaces.models import IntroComment, Storyline, StorylineFile, Workspace

logger = structlog.get_logger(__name__)


def _new_etag() -> str:
    return str(uuid.uuid4())


def _github_detail(exc: GithubError) -> str:
    """GitHub's human reason for a 4xx, for surfacing verbatim to the user.

    GitHub's top-level `message` on a 422 is the unhelpful "Validation Failed";
    the actionable text (e.g. "No commits between main and <branch>") lives in
    the per-field `errors[]`. Prefer that detail, falling back to the message.
    """
    detail = exc.message
    errors = exc.body.get("errors") if isinstance(exc.body, dict) else None
    if isinstance(errors, list):
        parts = [
            str(e.get("message") or e.get("code"))
            for e in errors
            if isinstance(e, dict) and (e.get("message") or e.get("code"))
        ]
        if parts:
            detail = f"{detail}: {'; '.join(parts)}"
    return detail


@transaction.atomic
def storyline_create(*, workspace: Workspace, author: User) -> Storyline:
    return Storyline.objects.create(
        workspace=workspace,
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
                "This workspace is frozen — its GitHub PR is closed or merged. "
                "Reopen the PR on GitHub to make changes again.",
                extra={"code": "workspace_frozen", "workspace_id": str(workspace.id)},
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
    StorylineFile.objects.bulk_create(
        [
            StorylineFile(
                storyline=s,
                diff_file_path=f["diff_file_path"],
                order_index=f.get("order_index", idx),
                intro_text=f.get("intro_text", ""),
            )
            for idx, f in enumerate(files)
        ]
    )

    s.etag = _new_etag()
    s.updated_by = user
    s.save(update_fields=["etag", "updated_by", "updated_at"])

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
    title: str = "",
) -> Workspace:
    try:
        ws = Workspace.objects.create(
            created_by=creator,
            repo_owner=repo_owner,
            repo_name=repo_name,
            head_ref=head_ref,
            base_ref=base_ref,
            title=title,
        )
    except (IntegrityError, DjangoValidationError) as exc:
        raise ApplicationError(
            "A workspace already exists for that branch in this repo.",
            extra={
                "code": "workspace_exists",
                "repo_owner": repo_owner,
                "repo_name": repo_name,
                "head_ref": head_ref,
            },
            status=409,
        ) from exc
    storyline_create(workspace=ws, author=creator)
    return ws


def _assert_not_frozen(workspace: Workspace, gateway) -> None:
    if workspace.pr_number is not None:
        pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
        if pr.get("state") == "closed":
            raise ApplicationError(
                "This workspace is frozen — its GitHub PR is closed or merged. "
                "Reopen the PR on GitHub to make changes again.",
                extra={"code": "workspace_frozen", "workspace_id": str(workspace.id)},
                status=409,
            )


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
    if workspace.pr_number is None and user.pk != workspace.created_by_id:
        raise ApplicationError("creator_only_pre_publish", status=403)
    _assert_not_frozen(workspace, gateway)
    if parent is not None and parent.parent_id is not None:
        raise ApplicationError("depth_exceeded", status=400)
    return IntroComment.objects.create(
        storyline_file=storyline_file,
        user=user,
        body=body,
        parent=parent,
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


def _apply_pr_warnings(
    gateway, o: str, r: str, n: int, reviewers: list[str], labels: list[str]
) -> list[str]:
    warnings: list[str] = []
    if reviewers:
        try:
            gateway.request_reviewers(o, r, n, reviewers=reviewers)
        except GithubError as e:
            warnings.append(f"reviewers_failed: {e}")
    if labels:
        try:
            gateway.add_labels(o, r, n, labels=labels)
        except GithubError as e:
            warnings.append(f"labels_failed: {e}")
    return warnings


@transaction.atomic
def pull_request_open(
    *,
    workspace: Workspace,
    creator: User,
    title: str,
    body: str,
    reviewers: list[str],
    labels: list[str],
    draft: bool,
    gateway,
) -> dict:
    if creator.pk != workspace.created_by_id:
        raise ApplicationError("creator_only", status=403)

    o, r = workspace.repo_owner, workspace.repo_name
    log = logger.bind(
        workspace_id=str(workspace.id), head=workspace.head_ref, base=workspace.base_ref
    )

    if workspace.pr_number is None:
        try:
            existing = gateway.list_open_pulls(o, r, head=workspace.head_ref)
        except GithubError as exc:
            log.exception("open_pr_list_failed")
            raise ApplicationError(
                f"Couldn't check GitHub for an existing pull request — {_github_detail(exc)}.",
                extra={
                    "code": "open_pr_failed",
                    "cause": str(exc),
                    "github_status": exc.status_code,
                },
                status=502,
            ) from exc
        if existing:
            pr = existing[0]
            workspace.pr_number = pr["number"]
            workspace.pr_opened_at = datetime.fromisoformat(pr["created_at"].replace("Z", "+00:00"))
            workspace.save(update_fields=["pr_number", "pr_opened_at", "updated_at"])
            warnings = _apply_pr_warnings(gateway, o, r, workspace.pr_number, reviewers, labels)
            return {"workspace": workspace, "pr": pr, "warnings": warnings}
    else:
        try:
            pr = gateway.get_pr(o, r, workspace.pr_number)
        except GithubError as exc:
            log.exception("open_pr_get_failed", pr_number=workspace.pr_number)
            raise ApplicationError(
                f"Couldn't load PR #{workspace.pr_number} from GitHub — {_github_detail(exc)}.",
                extra={
                    "code": "open_pr_failed",
                    "cause": str(exc),
                    "github_status": exc.status_code,
                },
                status=502,
            ) from exc
        if pr.get("state") == "open":
            raise ApplicationError("pr_already_open", status=409)

    # GitHub commonly 422s here when the head branch has no commits ahead of base
    # ("No commits between …"), isn't pushed, or a PR already exists. Surface the
    # reason verbatim (fail loud, CLAUDE.md) rather than letting it 500.
    try:
        pr = gateway.create_pull(
            o,
            r,
            title=title,
            body=body,
            base=workspace.base_ref,
            head=workspace.head_ref,
            draft=draft,
        )
    except GithubError as exc:
        log.exception("open_pr_create_pull_failed")
        raise ApplicationError(
            f"GitHub wouldn't open the pull request — {_github_detail(exc)}.",
            extra={"code": "open_pr_failed", "cause": str(exc), "github_status": exc.status_code},
            status=502,
        ) from exc
    workspace.pr_number = pr["number"]
    workspace.pr_opened_at = timezone.now()
    workspace.save(update_fields=["pr_number", "pr_opened_at", "updated_at"])
    warnings = _apply_pr_warnings(gateway, o, r, workspace.pr_number, reviewers, labels)
    return {"workspace": workspace, "pr": pr, "warnings": warnings}


@transaction.atomic
def pull_request_reopen(*, workspace: Workspace, creator: User, gateway) -> dict:
    if creator.pk != workspace.created_by_id:
        raise ApplicationError("creator_only", status=403)
    if workspace.pr_number is None:
        raise ApplicationError("no_pr_to_reopen", status=409)
    return gateway.patch_pr(
        workspace.repo_owner, workspace.repo_name, workspace.pr_number, state="open"
    )


@transaction.atomic
def workspace_delete(*, workspace: Workspace, user: User) -> None:
    if user.pk != workspace.created_by_id:
        raise ApplicationError(
            "Only the workspace's creator can discard it.",
            extra={"code": "creator_only", "workspace_id": str(workspace.id)},
            status=403,
        )
    if workspace.pr_number is not None:
        raise ApplicationError(
            f"This workspace is published (PR #{workspace.pr_number}) — Stage keeps it "
            "for the record. Discard only applies to pre-publish drafts.",
            extra={
                "code": "workspace_published",
                "workspace_id": str(workspace.id),
                "pr_number": workspace.pr_number,
            },
            status=409,
        )
    workspace.delete()


@transaction.atomic
def workspace_update_local_phase(
    *,
    workspace: Workspace,
    user: User,
    head_ref: str | None = None,
    base_ref: str | None = None,
) -> Workspace:
    if user.pk != workspace.created_by_id:
        raise ApplicationError("creator_only", status=403)
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
