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
def test_search_issues_single_page() -> None:
    respx.get("https://api.github.com/search/issues").mock(
        return_value=Response(200, json={"total_count": 0, "items": []}),
    )
    g = GithubGateway(token="t")
    result = g.search_issues("q")
    assert result == {"total_count": 0, "incomplete_results": False, "items": []}


@respx.mock
def test_search_issues_paginates_until_short_page() -> None:
    """Two pages: 100 then 7 — gateway concatenates and stops on the short page."""
    page_one = [{"number": i} for i in range(100)]
    page_two = [{"number": 100 + i} for i in range(7)]
    respx.get(
        "https://api.github.com/search/issues",
        params={"q": "q", "per_page": "100", "page": "1"},
    ).mock(return_value=Response(200, json={"total_count": 107, "items": page_one}))
    respx.get(
        "https://api.github.com/search/issues",
        params={"q": "q", "per_page": "100", "page": "2"},
    ).mock(return_value=Response(200, json={"total_count": 107, "items": page_two}))
    g = GithubGateway(token="t")
    result = g.search_issues("q")
    assert result["total_count"] == 107
    assert len(result["items"]) == 107
    assert result["items"][0]["number"] == 0
    assert result["items"][-1]["number"] == 106


@respx.mock
def test_search_issues_raises_on_incomplete_results() -> None:
    """GitHub timed out partway through — fail loud rather than return partial."""
    respx.get("https://api.github.com/search/issues").mock(
        return_value=Response(
            200,
            json={"total_count": 50, "incomplete_results": True, "items": [{"number": 1}]},
        ),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.search_issues("q")
    assert exc.value.status_code == 502
    assert exc.value.message == "github_search_incomplete"


@respx.mock
def test_search_issues_raises_when_total_exceeds_cap() -> None:
    """total_count > 1000: GitHub literally won't paginate past the cap. We
    refuse rather than serve a silently-truncated list."""
    page = [{"number": i} for i in range(100)]
    respx.get("https://api.github.com/search/issues").mock(
        return_value=Response(200, json={"total_count": 5000, "items": page}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.search_issues("q")
    assert exc.value.status_code == 502
    assert exc.value.message == "github_search_truncated"
