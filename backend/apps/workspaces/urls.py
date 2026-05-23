from django.urls import path

from apps.workspaces.apis import (
    WorkspaceCreateApi,
    WorkspaceDetailApi,
    WorkspaceListApi,
    WorkspaceLookupApi,
    WorkspaceUpdateApi,
)

app_name = "workspaces"

urlpatterns = [
    path("workspaces/", WorkspaceListApi.as_view(), name="list"),
    path("workspaces/create/", WorkspaceCreateApi.as_view(), name="create"),
    path("workspaces/lookup/", WorkspaceLookupApi.as_view(), name="lookup"),
    path("workspaces/<uuid:workspace_id>/", WorkspaceDetailApi.as_view(), name="detail"),
    path("workspaces/<uuid:workspace_id>/update/", WorkspaceUpdateApi.as_view(), name="update"),
]
