from typing import Any

import httpx
import structlog

from apps.github_proxy.exceptions import GithubConflict, GithubError, GithubForbidden, GithubNotFound
from config.settings.env_schemas import env

logger = structlog.get_logger(__name__)

_STATUS_TO_EXC = {404: GithubNotFound, 403: GithubForbidden, 409: GithubConflict, 412: GithubConflict}


class GithubGateway:
    def __init__(self, token: str) -> None:
        self._client = httpx.Client(
            base_url=env.GITHUB_API_BASE,
            headers={
                "Authorization": f"token {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=15.0,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "GithubGateway":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        resp = self._client.request(method, path, **kwargs)
        if resp.status_code < 400:
            return resp
        try:
            body = resp.json()
            msg = body.get("message", resp.text)
        except Exception:
            body, msg = {}, resp.text
        logger.warning("github_error", method=method, path=path, status=resp.status_code, message=msg)
        cls = _STATUS_TO_EXC.get(resp.status_code, GithubError)
        raise cls(resp.status_code, msg, body)

    def get_pr(self, o: str, r: str, n: int) -> dict[str, Any]:
        return self._request("GET", f"/repos/{o}/{r}/pulls/{n}").json()

    def list_pr_files(self, o: str, r: str, n: int) -> list[dict[str, Any]]:
        return self._request("GET", f"/repos/{o}/{r}/pulls/{n}/files").json()

    def get_file_diff(self, o: str, r: str, n: int, path: str) -> dict[str, Any] | None:
        for f in self.list_pr_files(o, r, n):
            if f["filename"] == path:
                return f
        return None

    def list_issue_comments(self, o: str, r: str, n: int) -> list[dict]:
        return self._request("GET", f"/repos/{o}/{r}/issues/{n}/comments").json()

    def list_review_comments(self, o: str, r: str, n: int) -> list[dict]:
        return self._request("GET", f"/repos/{o}/{r}/pulls/{n}/comments").json()

    def list_reviews(self, o: str, r: str, n: int) -> list[dict]:
        return self._request("GET", f"/repos/{o}/{r}/pulls/{n}/reviews").json()

    def list_check_runs(self, o: str, r: str, head_sha: str) -> dict:
        return self._request("GET", f"/repos/{o}/{r}/commits/{head_sha}/check-runs").json()

    def list_workflow_runs(self, o: str, r: str, head_sha: str) -> dict:
        return self._request("GET", f"/repos/{o}/{r}/actions/runs", params={"head_sha": head_sha}).json()

    def list_open_pulls(self, repo_owner: str, repo_name: str, *, head: str) -> list[dict]:
        params = {"state": "open", "head": f"{repo_owner}:{head}"}
        return self._request("GET", f"/repos/{repo_owner}/{repo_name}/pulls", params=params).json()

    def search_issues(self, query: str) -> dict:
        return self._request("GET", "/search/issues", params={"q": query}).json()

    def post_issue_comment(self, o: str, r: str, n: int, *, body: str) -> dict:
        return self._request("POST", f"/repos/{o}/{r}/issues/{n}/comments", json={"body": body}).json()

    def post_review_comment(
        self,
        o: str,
        r: str,
        n: int,
        *,
        body: str,
        path: str,
        line: int,
        side: str,
        commit_id: str | None = None,
        in_reply_to: int | None = None,
    ) -> dict:
        if in_reply_to is not None:
            payload: dict[str, Any] = {"body": body, "in_reply_to": in_reply_to}
        else:
            payload = {"body": body, "path": path, "line": line, "side": side, "commit_id": commit_id}
        return self._request("POST", f"/repos/{o}/{r}/pulls/{n}/comments", json=payload).json()

    def post_review(self, o: str, r: str, n: int, *, body: str, event: str, comments: list[dict]) -> dict:
        return self._request(
            "POST",
            f"/repos/{o}/{r}/pulls/{n}/reviews",
            json={"body": body, "event": event, "comments": comments},
        ).json()

    def patch_pr(self, o: str, r: str, n: int, **fields: Any) -> dict:
        return self._request("PATCH", f"/repos/{o}/{r}/pulls/{n}", json=fields).json()

    def merge_pr(self, o: str, r: str, n: int, *, method: str) -> dict:
        return self._request("PUT", f"/repos/{o}/{r}/pulls/{n}/merge", json={"merge_method": method}).json()

    def create_pull(
        self, o: str, r: str, *, title: str, body: str, base: str, head: str, draft: bool = False
    ) -> dict:
        return self._request(
            "POST",
            f"/repos/{o}/{r}/pulls",
            json={"title": title, "body": body, "base": base, "head": head, "draft": draft},
        ).json()

    def request_reviewers(self, o: str, r: str, n: int, *, reviewers: list[str]) -> dict:
        return self._request(
            "POST", f"/repos/{o}/{r}/pulls/{n}/requested_reviewers", json={"reviewers": reviewers}
        ).json()

    def add_labels(self, o: str, r: str, n: int, *, labels: list[str]) -> list[dict]:
        return self._request("POST", f"/repos/{o}/{r}/issues/{n}/labels", json={"labels": labels}).json()

    def edit_issue_comment(self, o: str, r: str, comment_id: int, body: str) -> dict:
        return self._request("PATCH", f"/repos/{o}/{r}/issues/comments/{comment_id}", json={"body": body}).json()

    def delete_issue_comment(self, o: str, r: str, comment_id: int) -> None:
        self._request("DELETE", f"/repos/{o}/{r}/issues/comments/{comment_id}")

    def edit_review_comment(self, o: str, r: str, comment_id: int, body: str) -> dict:
        return self._request("PATCH", f"/repos/{o}/{r}/pulls/comments/{comment_id}", json={"body": body}).json()

    def delete_review_comment(self, o: str, r: str, comment_id: int) -> None:
        self._request("DELETE", f"/repos/{o}/{r}/pulls/comments/{comment_id}")

    def react_to_comment(self, o: str, r: str, kind: str, comment_id: int, content: str) -> dict:
        return self._request(
            "POST", f"/repos/{o}/{r}/{kind}/comments/{comment_id}/reactions", json={"content": content}
        ).json()
