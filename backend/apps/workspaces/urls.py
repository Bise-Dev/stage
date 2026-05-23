from django.urls import path

from apps.workspaces.apis import (
    WorkspaceDetailApi,
    WorkspaceListApi,
    WorkspaceLookupApi,
)

app_name = "workspaces"

urlpatterns = [
    path("workspaces/", WorkspaceListApi.as_view(), name="list"),
    path("workspaces/lookup/", WorkspaceLookupApi.as_view(), name="lookup"),
    path("workspaces/<uuid:workspace_id>/", WorkspaceDetailApi.as_view(), name="detail"),
]
