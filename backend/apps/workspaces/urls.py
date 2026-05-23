from django.urls import path

from apps.workspaces.apis import (
    StorylineDetailApi,
    StorylineFileDetailApi,
    WorkspaceDetailApi,
    WorkspaceListApi,
    WorkspaceLookupApi,
)

app_name = "workspaces"

urlpatterns = [
    path("workspaces/", WorkspaceListApi.as_view(), name="list"),
    path("workspaces/lookup/", WorkspaceLookupApi.as_view(), name="lookup"),
    path("workspaces/<uuid:workspace_id>/", WorkspaceDetailApi.as_view(), name="detail"),
    path("workspaces/<uuid:workspace_id>/storyline/", StorylineDetailApi.as_view(), name="storyline-detail"),
    path("workspaces/<uuid:workspace_id>/storyline/files/<uuid:file_id>/", StorylineFileDetailApi.as_view(), name="storyline-file-detail"),
]
