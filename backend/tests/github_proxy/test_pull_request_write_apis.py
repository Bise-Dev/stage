from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from rest_framework.test import APIClient

from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User


@pytest.fixture
def authed_client(db) -> tuple[APIClient, User]:
    user = cast(User, UserFactory())
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client, user


def _make_mock_gw() -> MagicMock:
    mock_gw = MagicMock()
    mock_gw.__enter__ = MagicMock(return_value=mock_gw)
    mock_gw.__exit__ = MagicMock(return_value=False)
    return mock_gw


# --- PullRequestCommentCreateApi ---


@pytest.mark.django_db
def test_pr_comment_create_issue(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.post_issue_comment.return_value = {"id": 1, "body": "hello"}
        resp = client.post(
            "/api/v1/repos/o/r/pulls/1/comments/create/",
            {"kind": "issue", "body": "hello"},
            format="json",
        )
    assert resp.status_code == 201
    mock_gw.post_issue_comment.assert_called_once_with("o", "r", 1, body="hello")


@pytest.mark.django_db
def test_pr_comment_create_review(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.post_review_comment.return_value = {"id": 2}
        resp = client.post(
            "/api/v1/repos/o/r/pulls/1/comments/create/",
            {"kind": "review", "body": "note", "path": "src/a.py", "line": 5, "side": "RIGHT"},
            format="json",
        )
    assert resp.status_code == 201
    mock_gw.post_review_comment.assert_called_once_with(
        "o",
        "r",
        1,
        body="note",
        path="src/a.py",
        line=5,
        side="RIGHT",
        commit_id=None,
        in_reply_to=None,
    )


@pytest.mark.django_db
def test_pr_comment_create_review_reply(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.post_review_comment.return_value = {"id": 3}
        resp = client.post(
            "/api/v1/repos/o/r/pulls/1/comments/create/",
            {"kind": "review", "body": "reply", "in_reply_to": 99},
            format="json",
        )
    assert resp.status_code == 201
    mock_gw.post_review_comment.assert_called_once_with(
        "o",
        "r",
        1,
        body="reply",
        path=None,
        line=None,
        side=None,
        commit_id=None,
        in_reply_to=99,
    )


@pytest.mark.django_db
def test_pr_comment_create_review_missing_fields(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway"):
        resp = client.post(
            "/api/v1/repos/o/r/pulls/1/comments/create/",
            {"kind": "review", "body": "note"},
            format="json",
        )
    assert resp.status_code == 400


# --- PullRequestReviewCreateApi ---


@pytest.mark.django_db
def test_pr_review_create(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.post_review.return_value = {"id": 10}
        resp = client.post(
            "/api/v1/repos/o/r/pulls/1/review/create/",
            {
                "body": "LGTM",
                "event": "APPROVE",
                "comments": [{"path": "a.py", "line": 1, "body": "nice"}],
            },
            format="json",
        )
    assert resp.status_code == 200
    mock_gw.post_review.assert_called_once_with(
        "o",
        "r",
        1,
        body="LGTM",
        event="APPROVE",
        comments=[{"path": "a.py", "line": 1, "body": "nice"}],
    )


# --- PullRequestActionApi ---


@pytest.mark.django_db
def test_pr_action_close(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.patch_pr.return_value = {"number": 1, "state": "closed"}
        resp = client.post("/api/v1/repos/o/r/pulls/1/actions/close/", format="json")
    assert resp.status_code == 200
    mock_gw.patch_pr.assert_called_once_with("o", "r", 1, state="closed")


@pytest.mark.django_db
def test_pr_action_reopen(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.patch_pr.return_value = {"number": 1, "state": "open"}
        resp = client.post("/api/v1/repos/o/r/pulls/1/actions/reopen/", format="json")
    assert resp.status_code == 200
    mock_gw.patch_pr.assert_called_once_with("o", "r", 1, state="open")


@pytest.mark.django_db
def test_pr_action_toggle_draft(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.get_pr.return_value = {"number": 1, "draft": False}
        mock_gw.patch_pr.return_value = {"number": 1, "draft": True}
        resp = client.post("/api/v1/repos/o/r/pulls/1/actions/toggle-draft/", format="json")
    assert resp.status_code == 200
    mock_gw.get_pr.assert_called_once_with("o", "r", 1)
    mock_gw.patch_pr.assert_called_once_with("o", "r", 1, draft=True)


@pytest.mark.django_db
def test_pr_action_merge(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.merge_pr.return_value = {"merged": True}
        resp = client.post("/api/v1/repos/o/r/pulls/1/actions/merge/", format="json")
    assert resp.status_code == 200
    mock_gw.merge_pr.assert_called_once_with("o", "r", 1, method="merge")


@pytest.mark.django_db
def test_pr_action_merge_squash(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.merge_pr.return_value = {"merged": True}
        resp = client.post(
            "/api/v1/repos/o/r/pulls/1/actions/merge/",
            {"method": "squash"},
            format="json",
        )
    assert resp.status_code == 200
    mock_gw.merge_pr.assert_called_once_with("o", "r", 1, method="squash")


@pytest.mark.django_db
def test_pr_action_unknown(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway"):
        resp = client.post("/api/v1/repos/o/r/pulls/1/actions/fly/", format="json")
    assert resp.status_code == 400
