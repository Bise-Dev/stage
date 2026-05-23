from django.urls import path

from apps.workspaces.apis import (
    IntroCommentCollectionApi,
    IntroCommentDeleteApi,
    IntroCommentDetailApi,
    IntroCommentResolveApi,
    IntroCommentUnresolveApi,
    OpenPrApi,
    ReopenPrApi,
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
    path("workspaces/<uuid:workspace_id>/storyline/files/<uuid:file_id>/intro-comments/", IntroCommentCollectionApi.as_view(), name="intro-comment-collection"),
    path("intro-comments/<uuid:comment_id>/", IntroCommentDetailApi.as_view(), name="intro-comment-detail"),
    path("intro-comments/<uuid:comment_id>/delete/", IntroCommentDeleteApi.as_view(), name="intro-comment-delete"),
    path("intro-comments/<uuid:comment_id>/resolve/", IntroCommentResolveApi.as_view(), name="intro-comment-resolve"),
    path("intro-comments/<uuid:comment_id>/unresolve/", IntroCommentUnresolveApi.as_view(), name="intro-comment-unresolve"),
    path("workspaces/<uuid:workspace_id>/open-pr/", OpenPrApi.as_view(), name="open-pr"),
    path("workspaces/<uuid:workspace_id>/reopen-pr/", ReopenPrApi.as_view(), name="reopen-pr"),
]
