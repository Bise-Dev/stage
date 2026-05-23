import pytest
import respx
from httpx import Response

from apps.github_proxy.exceptions import GithubError, GithubNotFound
from apps.github_proxy.gateway import GithubGateway


@respx.mock
def test_get_pr() -> None:
    respx.get("https://api.github.com/repos/o/r/pulls/1").mock(
        return_value=Response(200, json={"number": 1, "user": {"login": "alice"}}),
    )
    g = GithubGateway(token="t")
    assert g.get_pr("o", "r", 1)["number"] == 1


@respx.mock
def test_get_pr_404_raises_github_not_found() -> None:
    respx.get("https://api.github.com/repos/o/r/pulls/99").mock(
        return_value=Response(404, json={"message": "Not Found"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubNotFound):
        g.get_pr("o", "r", 99)


@respx.mock
def test_list_pr_files() -> None:
    respx.get("https://api.github.com/repos/o/r/pulls/1/files").mock(
        return_value=Response(200, json=[{"filename": "a.py"}, {"filename": "b.py"}]),
    )
    g = GithubGateway(token="t")
    assert len(g.list_pr_files("o", "r", 1)) == 2


@respx.mock
def test_422_raises_generic_github_error() -> None:
    respx.get("https://api.github.com/repos/o/r/pulls/1").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.get_pr("o", "r", 1)
    assert exc.value.status_code == 422


@respx.mock
def test_list_check_runs() -> None:
    respx.get("https://api.github.com/repos/o/r/commits/abc/check-runs").mock(
        return_value=Response(200, json={"check_runs": []}),
    )
    g = GithubGateway(token="t")
    assert g.list_check_runs("o", "r", "abc") == {"check_runs": []}


@respx.mock
def test_search_issues() -> None:
    respx.get("https://api.github.com/search/issues").mock(
        return_value=Response(200, json={"items": []}),
    )
    g = GithubGateway(token="t")
    assert g.search_issues("q") == {"items": []}
