from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from rest_framework.test import APIClient

from apps.identity.factories import GitHubIdentityFactory
from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Workspace

_FAKE_PR = {"number": 7, "state": "open", "html_url": "https://github.com/o/r/pull/7"}
_EXISTING_PR = {
    "number": 42,
    "state": "open",
    "html_url": "https://github.com/o/r/pull/42",
    "created_at": "2026-05-23T14:26:24Z",
}


def _gw_mock() -> MagicMock:
    gw = MagicMock()
    gw.__enter__ = lambda s: s
    gw.__exit__ = MagicMock(return_value=False)
    gw.create_pull.return_value = _FAKE_PR
    gw.patch_pr.return_value = _FAKE_PR
    gw.list_open_pulls.return_value = []
    return gw


@pytest.fixture
def authed_client(db) -> tuple[APIClient, User]:
    user = cast(User, UserFactory())
    GitHubIdentityFactory(user=user)
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client, user


@pytest.mark.django_db
def test_open_pr_api_201(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    gw = _gw_mock()

    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        resp = client.post(
            f"/api/v1/workspaces/{ws.id}/open-pr/",
            {"title": "My PR", "body": "desc", "reviewers": [], "labels": [], "draft": False},
            format="json",
        )

    assert resp.status_code == 201
    data = resp.json()
    assert data["pr"]["number"] == 7
    assert "workspace" in data
    assert "warnings" in data


@pytest.mark.django_db
def test_open_pr_api_non_creator_403(authed_client) -> None:
    client, _ = authed_client
    ws = cast(Workspace, WorkspaceFactory(pr_number=None))
    gw = _gw_mock()

    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        resp = client.post(
            f"/api/v1/workspaces/{ws.id}/open-pr/",
            {"title": "t"},
            format="json",
        )

    assert resp.status_code == 403


@pytest.mark.django_db
def test_reopen_pr_api_200(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=7))
    gw = _gw_mock()

    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        resp = client.post(f"/api/v1/workspaces/{ws.id}/reopen-pr/")

    assert resp.status_code == 200
    assert resp.json()["number"] == 7


@pytest.mark.django_db
def test_pull_request_open_adopts_existing_pr(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    gw = _gw_mock()
    gw.list_open_pulls.return_value = [_EXISTING_PR]

    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        resp = client.post(
            f"/api/v1/workspaces/{ws.id}/open-pr/",
            {"title": "My PR", "body": "desc", "reviewers": [], "labels": [], "draft": False},
            format="json",
        )

    assert resp.status_code == 201
    data = resp.json()
    assert data["pr"]["number"] == 42
    ws.refresh_from_db()
    assert ws.pr_number == 42
    assert ws.pr_opened_at is not None
    gw.create_pull.assert_not_called()


@pytest.mark.django_db
def test_pull_request_open_creates_when_no_existing_pr(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    gw = _gw_mock()
    # list_open_pulls already returns [] from _gw_mock

    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        resp = client.post(
            f"/api/v1/workspaces/{ws.id}/open-pr/",
            {"title": "My PR", "body": "desc", "reviewers": [], "labels": [], "draft": False},
            format="json",
        )

    assert resp.status_code == 201
    data = resp.json()
    assert data["pr"]["number"] == 7
    gw.create_pull.assert_called_once()
    ws.refresh_from_db()
    assert ws.pr_number == 7


@pytest.mark.django_db
def test_pull_request_open_adopt_then_apply_reviewers(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    gw = _gw_mock()
    gw.list_open_pulls.return_value = [_EXISTING_PR]

    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        resp = client.post(
            f"/api/v1/workspaces/{ws.id}/open-pr/",
            {"title": "t", "body": "", "reviewers": ["alice", "bob"], "labels": [], "draft": False},
            format="json",
        )

    assert resp.status_code == 201
    gw.create_pull.assert_not_called()
    gw.request_reviewers.assert_called_once_with(
        ws.repo_owner, ws.repo_name, 42, reviewers=["alice", "bob"]
    )
