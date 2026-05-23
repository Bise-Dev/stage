import uuid
from typing import cast

from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.exceptions import ApplicationError
from apps.users.models import User
from apps.workspaces.models import Workspace
from apps.workspaces.selectors import workspace_get, workspace_list, workspace_lookup
from apps.workspaces.serializers.workspace_create_input import WorkspaceCreateInputSerializer
from apps.workspaces.serializers.workspace_lookup_output import WorkspaceLookupOutputSerializer
from apps.workspaces.serializers.workspace_output import WorkspaceOutputSerializer
from apps.workspaces.serializers.workspace_update_input import WorkspaceUpdateInputSerializer
from apps.workspaces.services import workspace_create, workspace_update_local_phase


class WorkspaceCreateApi(APIView):
    def post(self, request: Request) -> Response:
        serializer = WorkspaceCreateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        ws = workspace_create(creator=cast(User, request.user), **serializer.validated_data)
        return Response(WorkspaceOutputSerializer(ws).data, status=status.HTTP_201_CREATED)


class WorkspaceListApi(APIView):
    def get(self, request: Request) -> Response:
        qs = workspace_list()
        return Response(WorkspaceOutputSerializer(qs, many=True).data)

    def post(self, request: Request) -> Response:
        serializer = WorkspaceCreateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        ws = workspace_create(creator=cast(User, request.user), **serializer.validated_data)
        return Response(WorkspaceOutputSerializer(ws).data, status=status.HTTP_201_CREATED)


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
            WorkspaceLookupOutputSerializer({
                "workspace_id": ws.id,
                "created_by": {"id": ws.created_by_id, "github_login": ws.created_by.github_login},
            }).data,
        )


class WorkspaceDetailApi(APIView):
    def _get_workspace(self, workspace_id: uuid.UUID) -> Workspace:
        try:
            return workspace_get(workspace_id=workspace_id)
        except Workspace.DoesNotExist:
            raise ApplicationError("Not found", status=404)

    def get(self, request: Request, workspace_id: uuid.UUID) -> Response:
        ws = self._get_workspace(workspace_id)
        return Response(WorkspaceOutputSerializer(ws).data)

    def patch(self, request: Request, workspace_id: uuid.UUID) -> Response:
        ws = self._get_workspace(workspace_id)
        serializer = WorkspaceUpdateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        updated = workspace_update_local_phase(workspace=ws, **serializer.validated_data)
        return Response(WorkspaceOutputSerializer(updated).data)


class WorkspaceUpdateApi(APIView):
    def patch(self, request: Request, workspace_id: uuid.UUID) -> Response:
        try:
            ws = workspace_get(workspace_id=workspace_id)
        except Workspace.DoesNotExist:
            raise ApplicationError("Not found", status=404)
        serializer = WorkspaceUpdateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        updated = workspace_update_local_phase(workspace=ws, **serializer.validated_data)
        return Response(WorkspaceOutputSerializer(updated).data)
