import uuid
from typing import cast

from django.core.cache import cache
from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.exceptions import ApplicationError
from apps.github_proxy.gateway import make_user_gateway
from apps.users.models import User
from apps.workspaces.models import IntroComment, StorylineFile, Workspace
from apps.workspaces.selectors import (
    intro_comment_thread,
    repo_overview,
    storyline_read,
    workspace_get,
    workspace_list,
    workspace_lookup,
)
from apps.workspaces.serializers.intro_comment_create_input import IntroCommentCreateInputSerializer
from apps.workspaces.serializers.intro_comment_output import IntroCommentOutputSerializer
from apps.workspaces.serializers.intro_comment_update_input import IntroCommentUpdateInputSerializer
from apps.workspaces.serializers.open_pr_input import OpenPrInputSerializer
from apps.workspaces.serializers.open_pr_output import OpenPrOutputSerializer
from apps.workspaces.serializers.storyline_update_input import StorylineUpdateInputSerializer
from apps.workspaces.serializers.workspace_create_input import WorkspaceCreateInputSerializer
from apps.workspaces.serializers.workspace_lookup_output import WorkspaceLookupOutputSerializer
from apps.workspaces.serializers.workspace_output import WorkspaceOutputSerializer
from apps.workspaces.serializers.workspace_update_input import WorkspaceUpdateInputSerializer
from apps.workspaces.services import (
    intro_comment_create,
    intro_comment_resolve,
    intro_comment_soft_delete,
    intro_comment_unresolve,
    intro_comment_update,
    pull_request_open,
    pull_request_reopen,
    storyline_replace,
    workspace_create,
    workspace_delete,
    workspace_update_local_phase,
)


def _overview_cache_key(user_pk: int | None, owner: str, repo: str) -> str:
    """Cache key for RepoOverviewApi, shared with the create/delete handlers
    that must bust it. Single source of truth so the three sites can't drift."""
    return f"overview:{user_pk}:{owner}/{repo}"


class WorkspaceListApi(APIView):
    def get(self, request: Request) -> Response:
        qs = workspace_list(user=cast(User, request.user))
        return Response(WorkspaceOutputSerializer(qs, many=True).data)

    def post(self, request: Request) -> Response:
        serializer = WorkspaceCreateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        ws = workspace_create(creator=cast(User, request.user), **serializer.validated_data)
        # The overview is cached per (user, repo) for 30s (see RepoOverviewApi).
        # Bust it so the new workspace shows up immediately.
        cache.delete(
            _overview_cache_key(
                request.user.pk,
                serializer.validated_data["repo_owner"],
                serializer.validated_data["repo_name"],
            )
        )
        return Response(WorkspaceOutputSerializer(ws).data, status=status.HTTP_201_CREATED)


class RepoOverviewApi(APIView):
    """Unified Workspace + Open-PR overview for one repo (see docs/adr/0009).

    Short-TTL cached per (user, repo) since each call fans out to GitHub.
    """

    def get(self, request: Request, owner: str, repo: str) -> Response:
        cache_key = _overview_cache_key(request.user.pk, owner, repo)
        cached = cache.get(cache_key)
        if cached is not None:
            return Response(cached)
        with make_user_gateway(cast(User, request.user)) as g:
            rows = repo_overview(
                user=cast(User, request.user), repo_owner=owner, repo_name=repo, gateway=g
            )
        cache.set(cache_key, rows, timeout=30)
        return Response(rows)


class WorkspaceLookupApi(APIView):
    def get(self, request: Request) -> Response:
        o = request.query_params.get("repo_owner")
        r = request.query_params.get("repo_name")
        pr = request.query_params.get("pr_number")
        if not (o and r and pr):
            raise ApplicationError(
                "repo_owner, repo_name, pr_number are required",
                extra={"received": dict(request.query_params)},
                status=400,
            )
        ws = workspace_lookup(repo_owner=o, repo_name=r, pr_number=int(pr))
        if ws is None:
            raise ApplicationError("Not found", status=404)
        return Response(
            WorkspaceLookupOutputSerializer(
                {
                    "workspace_id": ws.id,
                    "created_by": {
                        "id": ws.created_by_id,
                        "github_login": ws.created_by.github_login,
                    },
                }
            ).data,
        )


class WorkspaceDetailApi(APIView):
    def _get_workspace(self, workspace_id: uuid.UUID) -> Workspace:
        try:
            return workspace_get(workspace_id=workspace_id)
        except Workspace.DoesNotExist:
            raise ApplicationError("Not found", status=404) from None

    def get(self, request: Request, workspace_id: uuid.UUID) -> Response:
        ws = self._get_workspace(workspace_id)
        if ws.pr_number is None and request.user.pk != ws.created_by_id:
            raise ApplicationError("Not found", status=404)
        return Response(WorkspaceOutputSerializer(ws).data)

    def patch(self, request: Request, workspace_id: uuid.UUID) -> Response:
        ws = self._get_workspace(workspace_id)
        serializer = WorkspaceUpdateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        updated = workspace_update_local_phase(
            workspace=ws, user=cast(User, request.user), **serializer.validated_data
        )
        return Response(WorkspaceOutputSerializer(updated).data)

    def delete(self, request: Request, workspace_id: uuid.UUID) -> Response:
        ws = self._get_workspace(workspace_id)
        # Preserve pre-publish privacy: a non-creator must not learn the
        # workspace exists (same 404 rule as GET).
        if ws.pr_number is None and request.user.pk != ws.created_by_id:
            raise ApplicationError("Not found", status=404)
        workspace_delete(workspace=ws, user=cast(User, request.user))
        cache.delete(_overview_cache_key(request.user.pk, ws.repo_owner, ws.repo_name))
        return Response(status=status.HTTP_204_NO_CONTENT)


class StorylineDetailApi(APIView):
    def get(self, request: Request, workspace_id: uuid.UUID) -> Response:
        ws = workspace_get(workspace_id=workspace_id)
        if ws.pr_number is None and request.user.pk != ws.created_by_id:
            raise ApplicationError("Not found", status=404)
        with make_user_gateway(cast(User, request.user)) as g:
            data, etag = storyline_read(workspace=ws, gateway=g)
        response = Response(data)
        response["ETag"] = etag
        return response

    def put(self, request: Request, workspace_id: uuid.UUID) -> Response:
        ws = workspace_get(workspace_id=workspace_id)
        if_match = request.headers.get("If-Match")
        if not if_match:
            return Response(
                {"message": "precondition_required", "extra": {}},
                status=status.HTTP_412_PRECONDITION_FAILED,
            )
        serializer = StorylineUpdateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        with make_user_gateway(cast(User, request.user)) as g:
            storyline_replace(
                workspace=ws,
                user=cast(User, request.user),
                files=[dict(f) for f in serializer.validated_data["files"]],
                if_match=if_match,
                gateway=g,
            )
            data, etag = storyline_read(workspace=ws, gateway=g)
        response = Response(data)
        response["ETag"] = etag
        return response


class StorylineFileDetailApi(APIView):
    def get(self, request: Request, workspace_id: uuid.UUID, file_id: uuid.UUID) -> Response:
        ws = workspace_get(workspace_id=workspace_id)
        with make_user_gateway(cast(User, request.user)) as g:
            data, _ = storyline_read(workspace=ws, gateway=g)
        for f in data["files"]:
            if str(f["id"]) == str(file_id):
                return Response(f)
        raise ApplicationError("not_found", status=404)


def _get_storyline_file(workspace_id: uuid.UUID, file_id: uuid.UUID) -> StorylineFile:
    try:
        return StorylineFile.objects.select_related("storyline__workspace").get(
            pk=file_id, storyline__workspace_id=workspace_id
        )
    except StorylineFile.DoesNotExist:
        raise ApplicationError("not_found", status=404) from None


def _get_intro_comment(comment_id: uuid.UUID) -> IntroComment:
    try:
        return IntroComment.objects.select_related(
            "storyline_file__storyline__workspace",
            "user",
            "resolved_by",
        ).get(pk=comment_id)
    except IntroComment.DoesNotExist:
        raise ApplicationError("not_found", status=404) from None


def _comment_to_dict(comment: IntroComment) -> dict:
    return {
        "id": comment.pk,
        "user": {"id": comment.user_id, "github_login": comment.user.github_login},
        "body": comment.body,
        "parent_id": comment.parent_id,
        "created_at": comment.created_at,
        "resolved_at": comment.resolved_at,
        "resolved_by": (
            {"id": comment.resolved_by_id, "github_login": comment.resolved_by.github_login}  # pyrefly: ignore[missing-attribute]
            if comment.resolved_by_id
            else None
        ),
        "replies": [],
    }


class IntroCommentCollectionApi(APIView):
    def get(self, request: Request, workspace_id: uuid.UUID, file_id: uuid.UUID) -> Response:
        sf = _get_storyline_file(workspace_id, file_id)
        ws = sf.storyline.workspace
        if ws.pr_number is None and request.user.pk != ws.created_by_id:
            raise ApplicationError("Not found", status=404)
        include_resolved = request.query_params.get("include_resolved", "").lower() in (
            "true",
            "1",
            "yes",
        )
        thread = intro_comment_thread(storyline_file=sf, include_resolved=include_resolved)
        return Response(IntroCommentOutputSerializer(thread, many=True).data)

    def post(self, request: Request, workspace_id: uuid.UUID, file_id: uuid.UUID) -> Response:
        sf = _get_storyline_file(workspace_id, file_id)
        serializer = IntroCommentCreateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        parent_id = serializer.validated_data.get("parent_id")
        parent = None
        if parent_id:
            try:
                parent = IntroComment.objects.get(pk=parent_id)
            except IntroComment.DoesNotExist:
                raise ApplicationError("parent_not_found", status=404) from None
        with make_user_gateway(cast(User, request.user)) as g:
            comment = intro_comment_create(
                storyline_file=sf,
                user=cast(User, request.user),
                body=serializer.validated_data["body"],
                parent=parent,
                gateway=g,
            )
        comment.refresh_from_db()
        comment.user  # ensure user is loaded  # noqa: B018
        return Response(
            IntroCommentOutputSerializer(_comment_to_dict(comment)).data,
            status=status.HTTP_201_CREATED,
        )


class IntroCommentDetailApi(APIView):
    def patch(self, request: Request, comment_id: uuid.UUID) -> Response:
        comment = _get_intro_comment(comment_id)
        serializer = IntroCommentUpdateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        updated = intro_comment_update(
            comment=comment,
            user=cast(User, request.user),
            body=serializer.validated_data["body"],
        )
        return Response(IntroCommentOutputSerializer(_comment_to_dict(updated)).data)


class IntroCommentDeleteApi(APIView):
    def post(self, request: Request, comment_id: uuid.UUID) -> Response:
        comment = _get_intro_comment(comment_id)
        intro_comment_soft_delete(comment=comment, user=cast(User, request.user))
        return Response(status=status.HTTP_204_NO_CONTENT)


class IntroCommentResolveApi(APIView):
    def post(self, request: Request, comment_id: uuid.UUID) -> Response:
        comment = _get_intro_comment(comment_id)
        resolved = intro_comment_resolve(comment=comment, creator=cast(User, request.user))
        return Response(IntroCommentOutputSerializer(_comment_to_dict(resolved)).data)


class IntroCommentUnresolveApi(APIView):
    def post(self, request: Request, comment_id: uuid.UUID) -> Response:
        comment = _get_intro_comment(comment_id)
        unresolved = intro_comment_unresolve(comment=comment, creator=cast(User, request.user))
        return Response(IntroCommentOutputSerializer(_comment_to_dict(unresolved)).data)


class OpenPrApi(APIView):
    def post(self, request: Request, workspace_id: uuid.UUID) -> Response:
        try:
            ws = workspace_get(workspace_id=workspace_id)
        except Workspace.DoesNotExist:
            raise ApplicationError("Not found", status=404) from None
        serializer = OpenPrInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        with make_user_gateway(cast(User, request.user)) as g:
            result = pull_request_open(
                workspace=ws,
                creator=cast(User, request.user),
                gateway=g,
                **serializer.validated_data,
            )
        return Response(OpenPrOutputSerializer(result).data, status=status.HTTP_201_CREATED)


class ReopenPrApi(APIView):
    def post(self, request: Request, workspace_id: uuid.UUID) -> Response:
        try:
            ws = workspace_get(workspace_id=workspace_id)
        except Workspace.DoesNotExist:
            raise ApplicationError("Not found", status=404) from None
        with make_user_gateway(cast(User, request.user)) as g:
            pr = pull_request_reopen(workspace=ws, creator=cast(User, request.user), gateway=g)
        return Response(pr)
