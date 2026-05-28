from typing import Any

import httpx
import structlog

from apps.github_proxy.exceptions import (
    GithubConflict,
    GithubError,
    GithubForbidden,
    GithubNotFound,
)
from config.settings.env_schemas import env

logger = structlog.get_logger(__name__)

_STATUS_TO_EXC = {
    404: GithubNotFound,
    403: GithubForbidden,
    409: GithubConflict,
    412: GithubConflict,
}


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
        logger.warning(
            "github_error", method=method, path=path, status=resp.status_code, message=msg
        )
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
        return self._request(
            "GET", f"/repos/{o}/{r}/actions/runs", params={"head_sha": head_sha}
        ).json()

    def list_open_pulls(self, repo_owner: str, repo_name: str, *, head: str) -> list[dict]:
        params = {"state": "open", "head": f"{repo_owner}:{head}"}
        return self._request("GET", f"/repos/{repo_owner}/{repo_name}/pulls", params=params).json()

    def search_issues(self, query: str) -> dict:
        """Run `/search/issues` and return every matching item.

        GitHub paginates search at up to 100/page and caps total fetchable
        results at 1000 (10 pages). We iterate until exhausted; per the
        fail-loud convention (CLAUDE.md "Error handling") any sign of
        incompleteness is raised, not silently truncated:

        - ``incomplete_results: true`` from upstream → raise (search timed
          out partway through).
        - ``total_count`` exceeds what we could fetch → raise (caller's
          query is too broad to enumerate via search).
        """
        per_page = 100
        max_pages = 10  # GitHub's hard cap on /search/issues pagination.
        all_items: list[dict] = []
        total_count = 0
        for page in range(1, max_pages + 1):
            resp = self._request(
                "GET",
                "/search/issues",
                params={"q": query, "per_page": per_page, "page": page},
            ).json()
            if resp.get("incomplete_results"):
                raise GithubError(
                    502,
                    "github_search_incomplete",
                    {"query": query, "page": page},
                )
            page_items = resp.get("items", [])
            all_items.extend(page_items)
            total_count = resp.get("total_count", len(all_items))
            if len(page_items) < per_page:
                break
        else:
            # Loop finished without `break` — we filled all max_pages and the
            # last page was still full. If GitHub says there are more matches
            # beyond what we fetched, the caller is operating on truncated
            # data — refuse rather than render a partial list.
            if total_count > len(all_items):
                raise GithubError(
                    502,
                    "github_search_truncated",
                    {
                        "query": query,
                        "total_count": total_count,
                        "fetched": len(all_items),
                    },
                )
        return {
            "total_count": total_count,
            "incomplete_results": False,
            "items": all_items,
        }

    def post_issue_comment(self, o: str, r: str, n: int, *, body: str) -> dict:
        return self._request(
            "POST", f"/repos/{o}/{r}/issues/{n}/comments", json={"body": body}
        ).json()

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
            payload = {
                "body": body,
                "path": path,
                "line": line,
                "side": side,
                "commit_id": commit_id,
            }
        return self._request("POST", f"/repos/{o}/{r}/pulls/{n}/comments", json=payload).json()

    def post_review(
        self, o: str, r: str, n: int, *, body: str, event: str, comments: list[dict]
    ) -> dict:
        return self._request(
            "POST",
            f"/repos/{o}/{r}/pulls/{n}/reviews",
            json={"body": body, "event": event, "comments": comments},
        ).json()

    def patch_pr(self, o: str, r: str, n: int, **fields: Any) -> dict:
        return self._request("PATCH", f"/repos/{o}/{r}/pulls/{n}", json=fields).json()

    def merge_pr(self, o: str, r: str, n: int, *, method: str) -> dict:
        return self._request(
            "PUT", f"/repos/{o}/{r}/pulls/{n}/merge", json={"merge_method": method}
        ).json()

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
        return self._request(
            "POST", f"/repos/{o}/{r}/issues/{n}/labels", json={"labels": labels}
        ).json()

    def edit_issue_comment(self, o: str, r: str, comment_id: int, body: str) -> dict:
        return self._request(
            "PATCH", f"/repos/{o}/{r}/issues/comments/{comment_id}", json={"body": body}
        ).json()

    def delete_issue_comment(self, o: str, r: str, comment_id: int) -> None:
        self._request("DELETE", f"/repos/{o}/{r}/issues/comments/{comment_id}")

    def edit_review_comment(self, o: str, r: str, comment_id: int, body: str) -> dict:
        return self._request(
            "PATCH", f"/repos/{o}/{r}/pulls/comments/{comment_id}", json={"body": body}
        ).json()

    def delete_review_comment(self, o: str, r: str, comment_id: int) -> None:
        self._request("DELETE", f"/repos/{o}/{r}/pulls/comments/{comment_id}")

    def react_to_comment(self, o: str, r: str, kind: str, comment_id: int, content: str) -> dict:
        return self._request(
            "POST",
            f"/repos/{o}/{r}/{kind}/comments/{comment_id}/reactions",
            json={"content": content},
        ).json()


# Late imports: keep identity-layer deps out of module top so this module is
# importable without the identity app. The factory lives here (not at top) by
# design — see spec §3.6 (bot-mode seam). The aliases avoid public surface.
from apps.core.exceptions import ApplicationError as _ApplicationError  # noqa: E402
from apps.identity.services import github_identity_ensure_fresh as _ensure_fresh  # noqa: E402
from apps.users.models import User as _User  # noqa: E402


def make_user_gateway(user: "_User") -> "GithubGateway":
    """Build a GithubGateway for user. Transparently refreshes near-expired tokens."""
    try:
        # Django generates the reverse OneToOne accessor at runtime; pyrefly can't see it.
        identity = user.github_identity  # pyrefly: ignore[missing-attribute]
    except _User.github_identity.RelatedObjectDoesNotExist:  # pyrefly: ignore[missing-attribute] — same: runtime-generated descriptor
        raise _ApplicationError("github_reauth_required", status=401) from None
    identity = _ensure_fresh(identity=identity)
    return GithubGateway(token=identity.access_token)
