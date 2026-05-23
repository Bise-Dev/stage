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


@pytest.mark.django_db
def test_pr_detail(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.get_pr.return_value = {"number": 1}
        resp = client.get("/api/v1/repos/o/r/pulls/1/")
    assert resp.status_code == 200
    assert resp.json()["number"] == 1
    mock_gw.get_pr.assert_called_once_with("o", "r", 1)


@pytest.mark.django_db
def test_pr_files(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.list_pr_files.return_value = [{"filename": "a.py"}]
        resp = client.get("/api/v1/repos/o/r/pulls/1/files/")
    assert resp.status_code == 200
    assert resp.json()[0]["filename"] == "a.py"
    mock_gw.list_pr_files.assert_called_once_with("o", "r", 1)


@pytest.mark.django_db
def test_pr_file_diff(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.get_file_diff.return_value = "@@ -1 +1 @@"
        resp = client.get("/api/v1/repos/o/r/pulls/1/files/src/main.py/diff/")
    assert resp.status_code == 200
    assert resp.json() == "@@ -1 +1 @@"
    mock_gw.get_file_diff.assert_called_once_with("o", "r", 1, "src/main.py")


@pytest.mark.django_db
def test_pr_file_diff_404_when_none(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.get_file_diff.return_value = None
        resp = client.get("/api/v1/repos/o/r/pulls/1/files/src/main.py/diff/")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_pr_file_comments(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.list_review_comments.return_value = [
            {"path": "src/main.py", "id": 1},
            {"path": "other.py", "id": 2},
        ]
        resp = client.get("/api/v1/repos/o/r/pulls/1/files/src/main.py/comments/")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["id"] == 1
    mock_gw.list_review_comments.assert_called_once_with("o", "r", 1)


@pytest.mark.django_db
def test_pr_comments(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.list_issue_comments.return_value = [{"id": 10}]
        mock_gw.list_review_comments.return_value = [{"id": 20}]
        resp = client.get("/api/v1/repos/o/r/pulls/1/comments/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["issue"] == [{"id": 10}]
    assert body["review"] == [{"id": 20}]


@pytest.mark.django_db
def test_pr_reviews(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.list_reviews.return_value = [{"id": 5, "state": "APPROVED"}]
        resp = client.get("/api/v1/repos/o/r/pulls/1/reviews/")
    assert resp.status_code == 200
    assert resp.json()[0]["state"] == "APPROVED"
    mock_gw.list_reviews.assert_called_once_with("o", "r", 1)


@pytest.mark.django_db
def test_pr_checks(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        mock_gw = _make_mock_gw()
        gw_factory.return_value = mock_gw
        mock_gw.get_pr.return_value = {"number": 1, "head": {"sha": "abc123"}}
        mock_gw.list_check_runs.return_value = {"check_runs": [{"id": 1}]}
        mock_gw.list_workflow_runs.return_value = {"workflow_runs": [{"id": 2}]}
        resp = client.get("/api/v1/repos/o/r/pulls/1/checks/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["check_runs"] == {"check_runs": [{"id": 1}]}
    assert body["workflow_runs"] == {"workflow_runs": [{"id": 2}]}
    mock_gw.get_pr.assert_called_once_with("o", "r", 1)
    mock_gw.list_check_runs.assert_called_once_with("o", "r", "abc123")
    mock_gw.list_workflow_runs.assert_called_once_with("o", "r", "abc123")


@pytest.mark.django_db
def test_pr_detail_requires_auth() -> None:
    client = APIClient()
    resp = client.get("/api/v1/repos/o/r/pulls/1/")
    assert resp.status_code == 401
