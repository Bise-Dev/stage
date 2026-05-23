from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.exceptions import ApplicationError
from apps.github_proxy.gateway import GithubGateway
from apps.github_proxy.serializers.pr_comment_create_input import PullRequestCommentCreateInputSerializer
from apps.github_proxy.serializers.pr_merge_input import PullRequestMergeInputSerializer
from apps.github_proxy.serializers.pr_review_create_input import PullRequestReviewCreateInputSerializer
from apps.workspaces.selectors import workspaces_existing_for_prs
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


class PullRequestCommentCreateApi(APIView):
    def post(self, request: Request, o: str, r: str, n: int) -> Response:
        serializer = PullRequestCommentCreateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        with _gateway() as g:
            if data["kind"] == "issue":
                result = g.post_issue_comment(o, r, n, body=data["body"])
            else:
                result = g.post_review_comment(
                    o,
                    r,
                    n,
                    body=data["body"],
                    path=data["path"],
                    line=data["line"],
                    side=data["side"],
                    commit_id=data["commit_id"],
                    in_reply_to=data["in_reply_to"],
                )
        return Response(result, status=status.HTTP_201_CREATED)


class PullRequestReviewCreateApi(APIView):
    def post(self, request: Request, o: str, r: str, n: int) -> Response:
        serializer = PullRequestReviewCreateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        with _gateway() as g:
            result = g.post_review(o, r, n, body=data["body"], event=data["event"], comments=data["comments"])
        return Response(result)


class GithubPullsSearchApi(APIView):
    def get(self, request: Request) -> Response:
        login = getattr(request.user, "github_login", None)
        if not login:
            raise ApplicationError("no_github_identity", status=400)

        role = request.query_params.get("role")
        if role == "author":
            query = f"is:pr is:open author:{login}"
        elif role == "reviewer":
            query = f"is:pr is:open review-requested:{login}"
        else:
            raise ApplicationError("invalid_role", status=400)

        with _gateway() as g:
            result = g.search_issues(query)

        items = result.get("items", [])
        prs: list[tuple[str, str, int]] = []
        for item in items:
            repo_url: str = item["repository_url"]
            parts = repo_url.split("/repos/", 1)[1].split("/")
            prs.append((parts[0], parts[1], item["number"]))

        existing = workspaces_existing_for_prs(prs=prs)
        filtered = [item for item, key in zip(items, prs) if key not in existing]
        return Response({"items": filtered, "count": len(filtered)})


class PullRequestActionApi(APIView):
    def post(self, request: Request, o: str, r: str, n: int, action: str) -> Response:
        with _gateway() as g:
            if action == "close":
                result = g.patch_pr(o, r, n, state="closed")
            elif action == "reopen":
                result = g.patch_pr(o, r, n, state="open")
            elif action == "toggle-draft":
                pr = g.get_pr(o, r, n)
                result = g.patch_pr(o, r, n, draft=not pr["draft"])
            elif action == "merge":
                serializer = PullRequestMergeInputSerializer(data=request.data)
                serializer.is_valid(raise_exception=True)
                result = g.merge_pr(o, r, n, method=serializer.validated_data["method"])
            else:
                raise ApplicationError(f"Unknown action: {action}", status=400)
        return Response(result)
