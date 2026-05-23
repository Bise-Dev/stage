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

    def search_issues(self, query: str) -> dict:
        return self._request("GET", "/search/issues", params={"q": query}).json()
