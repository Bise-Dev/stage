import pytest
import respx
from httpx import Response

from apps.github_proxy.exceptions import GithubError
from apps.github_proxy.gateway import GithubGateway


@respx.mock
def test_post_issue_comment() -> None:
    respx.post("https://api.github.com/repos/o/r/issues/1/comments").mock(
        return_value=Response(201, json={"id": 10, "body": "hi"}),
    )
    g = GithubGateway(token="t")
    assert g.post_issue_comment("o", "r", 1, body="hi")["id"] == 10


@respx.mock
def test_post_issue_comment_422() -> None:
    respx.post("https://api.github.com/repos/o/r/issues/1/comments").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.post_issue_comment("o", "r", 1, body="hi")
    assert exc.value.status_code == 422


@respx.mock
def test_post_review_comment() -> None:
    respx.post("https://api.github.com/repos/o/r/pulls/1/comments").mock(
        return_value=Response(201, json={"id": 20}),
    )
    g = GithubGateway(token="t")
    result = g.post_review_comment(
        "o", "r", 1, body="note", path="f.py", line=5, side="RIGHT", commit_id="abc"
    )
    assert result["id"] == 20


@respx.mock
def test_post_review_comment_in_reply_to() -> None:
    respx.post("https://api.github.com/repos/o/r/pulls/1/comments").mock(
        return_value=Response(201, json={"id": 21}),
    )
    g = GithubGateway(token="t")
    result = g.post_review_comment(
        "o", "r", 1, body="reply", path="f.py", line=5, side="RIGHT", in_reply_to=99
    )
    assert result["id"] == 21


@respx.mock
def test_post_review_comment_422() -> None:
    respx.post("https://api.github.com/repos/o/r/pulls/1/comments").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.post_review_comment(
            "o", "r", 1, body="x", path="f.py", line=1, side="RIGHT", commit_id="abc"
        )
    assert exc.value.status_code == 422


@respx.mock
def test_post_review() -> None:
    respx.post("https://api.github.com/repos/o/r/pulls/1/reviews").mock(
        return_value=Response(200, json={"id": 30, "state": "APPROVED"}),
    )
    g = GithubGateway(token="t")
    result = g.post_review("o", "r", 1, body="lgtm", event="APPROVE", comments=[])
    assert result["state"] == "APPROVED"


@respx.mock
def test_post_review_422() -> None:
    respx.post("https://api.github.com/repos/o/r/pulls/1/reviews").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.post_review("o", "r", 1, body="x", event="APPROVE", comments=[])
    assert exc.value.status_code == 422


@respx.mock
def test_patch_pr() -> None:
    respx.patch("https://api.github.com/repos/o/r/pulls/1").mock(
        return_value=Response(200, json={"number": 1, "title": "new title"}),
    )
    g = GithubGateway(token="t")
    result = g.patch_pr("o", "r", 1, title="new title")
    assert result["title"] == "new title"


@respx.mock
def test_patch_pr_422() -> None:
    respx.patch("https://api.github.com/repos/o/r/pulls/1").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.patch_pr("o", "r", 1, title="x")
    assert exc.value.status_code == 422


@respx.mock
def test_merge_pr() -> None:
    respx.put("https://api.github.com/repos/o/r/pulls/1/merge").mock(
        return_value=Response(200, json={"merged": True}),
    )
    g = GithubGateway(token="t")
    assert g.merge_pr("o", "r", 1, method="squash")["merged"] is True


@respx.mock
def test_merge_pr_422() -> None:
    respx.put("https://api.github.com/repos/o/r/pulls/1/merge").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.merge_pr("o", "r", 1, method="squash")
    assert exc.value.status_code == 422


@respx.mock
def test_create_pull() -> None:
    respx.post("https://api.github.com/repos/o/r/pulls").mock(
        return_value=Response(201, json={"number": 5, "title": "feat"}),
    )
    g = GithubGateway(token="t")
    result = g.create_pull("o", "r", title="feat", body="", base="main", head="feature")
    assert result["number"] == 5


@respx.mock
def test_create_pull_422() -> None:
    respx.post("https://api.github.com/repos/o/r/pulls").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.create_pull("o", "r", title="x", body="", base="main", head="feature")
    assert exc.value.status_code == 422


@respx.mock
def test_request_reviewers() -> None:
    respx.post("https://api.github.com/repos/o/r/pulls/1/requested_reviewers").mock(
        return_value=Response(201, json={"requested_reviewers": [{"login": "alice"}]}),
    )
    g = GithubGateway(token="t")
    result = g.request_reviewers("o", "r", 1, reviewers=["alice"])
    assert result["requested_reviewers"][0]["login"] == "alice"


@respx.mock
def test_request_reviewers_422() -> None:
    respx.post("https://api.github.com/repos/o/r/pulls/1/requested_reviewers").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.request_reviewers("o", "r", 1, reviewers=["alice"])
    assert exc.value.status_code == 422


@respx.mock
def test_add_labels() -> None:
    respx.post("https://api.github.com/repos/o/r/issues/1/labels").mock(
        return_value=Response(200, json=[{"name": "bug"}]),
    )
    g = GithubGateway(token="t")
    result = g.add_labels("o", "r", 1, labels=["bug"])
    assert result[0]["name"] == "bug"


@respx.mock
def test_add_labels_422() -> None:
    respx.post("https://api.github.com/repos/o/r/issues/1/labels").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.add_labels("o", "r", 1, labels=["bug"])
    assert exc.value.status_code == 422


@respx.mock
def test_edit_issue_comment() -> None:
    respx.patch("https://api.github.com/repos/o/r/issues/comments/42").mock(
        return_value=Response(200, json={"id": 42, "body": "updated"}),
    )
    g = GithubGateway(token="t")
    assert g.edit_issue_comment("o", "r", 42, "updated")["body"] == "updated"


@respx.mock
def test_edit_issue_comment_422() -> None:
    respx.patch("https://api.github.com/repos/o/r/issues/comments/42").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.edit_issue_comment("o", "r", 42, "x")
    assert exc.value.status_code == 422


@respx.mock
def test_delete_issue_comment() -> None:
    respx.delete("https://api.github.com/repos/o/r/issues/comments/42").mock(
        return_value=Response(204),
    )
    g = GithubGateway(token="t")
    assert g.delete_issue_comment("o", "r", 42) is None


@respx.mock
def test_delete_issue_comment_422() -> None:
    respx.delete("https://api.github.com/repos/o/r/issues/comments/42").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.delete_issue_comment("o", "r", 42)
    assert exc.value.status_code == 422


@respx.mock
def test_edit_review_comment() -> None:
    respx.patch("https://api.github.com/repos/o/r/pulls/comments/55").mock(
        return_value=Response(200, json={"id": 55, "body": "fixed"}),
    )
    g = GithubGateway(token="t")
    assert g.edit_review_comment("o", "r", 55, "fixed")["body"] == "fixed"


@respx.mock
def test_edit_review_comment_422() -> None:
    respx.patch("https://api.github.com/repos/o/r/pulls/comments/55").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.edit_review_comment("o", "r", 55, "x")
    assert exc.value.status_code == 422


@respx.mock
def test_delete_review_comment() -> None:
    respx.delete("https://api.github.com/repos/o/r/pulls/comments/55").mock(
        return_value=Response(204),
    )
    g = GithubGateway(token="t")
    assert g.delete_review_comment("o", "r", 55) is None


@respx.mock
def test_delete_review_comment_422() -> None:
    respx.delete("https://api.github.com/repos/o/r/pulls/comments/55").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.delete_review_comment("o", "r", 55)
    assert exc.value.status_code == 422


@respx.mock
def test_react_to_comment() -> None:
    respx.post("https://api.github.com/repos/o/r/issues/comments/42/reactions").mock(
        return_value=Response(201, json={"id": 99, "content": "+1"}),
    )
    g = GithubGateway(token="t")
    result = g.react_to_comment("o", "r", "issues", 42, "+1")
    assert result["content"] == "+1"


@respx.mock
def test_react_to_comment_422() -> None:
    respx.post("https://api.github.com/repos/o/r/issues/comments/42/reactions").mock(
        return_value=Response(422, json={"message": "Unprocessable"}),
    )
    g = GithubGateway(token="t")
    with pytest.raises(GithubError) as exc:
        g.react_to_comment("o", "r", "issues", 42, "+1")
    assert exc.value.status_code == 422
