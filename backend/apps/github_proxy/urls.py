from django.urls import path

from apps.github_proxy.apis import (
    PullRequestChecksApi,
    PullRequestCommentsApi,
    PullRequestDetailApi,
    PullRequestFileDiffApi,
    PullRequestFileCommentsApi,
    PullRequestFilesApi,
    PullRequestReviewsApi,
)

app_name = "github_proxy"

urlpatterns = [
    path("repos/<str:o>/<str:r>/pulls/<int:n>/files/<path:file_path>/diff/", PullRequestFileDiffApi.as_view(), name="pr-file-diff"),
    path("repos/<str:o>/<str:r>/pulls/<int:n>/files/<path:file_path>/comments/", PullRequestFileCommentsApi.as_view(), name="pr-file-comments"),
    path("repos/<str:o>/<str:r>/pulls/<int:n>/files/", PullRequestFilesApi.as_view(), name="pr-files"),
    path("repos/<str:o>/<str:r>/pulls/<int:n>/comments/", PullRequestCommentsApi.as_view(), name="pr-comments"),
    path("repos/<str:o>/<str:r>/pulls/<int:n>/reviews/", PullRequestReviewsApi.as_view(), name="pr-reviews"),
    path("repos/<str:o>/<str:r>/pulls/<int:n>/checks/", PullRequestChecksApi.as_view(), name="pr-checks"),
    path("repos/<str:o>/<str:r>/pulls/<int:n>/", PullRequestDetailApi.as_view(), name="pr-detail"),
]
