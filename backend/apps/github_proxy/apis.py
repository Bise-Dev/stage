from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.github_proxy.gateway import GithubGateway
from config.settings.env_schemas import env


def _gateway() -> GithubGateway:
    return GithubGateway(token=env.GITHUB_ADMIN_PAT)


class PullRequestDetailApi(APIView):
    def get(self, request: Request, o: str, r: str, n: int) -> Response:
        with _gateway() as g:
            return Response(g.get_pr(o, r, n))


class PullRequestFilesApi(APIView):
    def get(self, request: Request, o: str, r: str, n: int) -> Response:
        with _gateway() as g:
            return Response(g.list_pr_files(o, r, n))


class PullRequestFileDiffApi(APIView):
    def get(self, request: Request, o: str, r: str, n: int, file_path: str) -> Response:
        with _gateway() as g:
            diff = g.get_file_diff(o, r, n, file_path)
        if diff is None:
            return Response(status=404)
        return Response(diff)


class PullRequestFileCommentsApi(APIView):
    def get(self, request: Request, o: str, r: str, n: int, file_path: str) -> Response:
        with _gateway() as g:
            comments = g.list_review_comments(o, r, n)
        return Response([c for c in comments if c.get("path") == file_path])


class PullRequestCommentsApi(APIView):
    def get(self, request: Request, o: str, r: str, n: int) -> Response:
        with _gateway() as g:
            issue = g.list_issue_comments(o, r, n)
            review = g.list_review_comments(o, r, n)
        return Response({"issue": issue, "review": review})


class PullRequestReviewsApi(APIView):
    def get(self, request: Request, o: str, r: str, n: int) -> Response:
        with _gateway() as g:
            return Response(g.list_reviews(o, r, n))


class PullRequestChecksApi(APIView):
    def get(self, request: Request, o: str, r: str, n: int) -> Response:
        with _gateway() as g:
            pr = g.get_pr(o, r, n)
            head_sha = pr["head"]["sha"]
            check_runs = g.list_check_runs(o, r, head_sha)
            workflow_runs = g.list_workflow_runs(o, r, head_sha)
        return Response({"check_runs": check_runs, "workflow_runs": workflow_runs})
