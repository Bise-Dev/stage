from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from rest_framework.test import APIClient

from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Workspace

_FAKE_PR = {"number": 7, "state": "open", "html_url": "https://github.com/o/r/pull/7"}


def _gw_mock() -> MagicMock:
    gw = MagicMock()
    gw.__enter__ = lambda s: s
    gw.__exit__ = MagicMock(return_value=False)
    gw.create_pull.return_value = _FAKE_PR
    gw.patch_pr.return_value = _FAKE_PR
    return gw


@pytest.fixture
def authed_client(db) -> tuple[APIClient, User]:
    user = cast(User, UserFactory())
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client, user


@pytest.mark.django_db
def test_open_pr_api_201(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    gw = _gw_mock()

    with patch("apps.workspaces.apis._gateway", return_value=gw):
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

    with patch("apps.workspaces.apis._gateway", return_value=gw):
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

    with patch("apps.workspaces.apis._gateway", return_value=gw):
        resp = client.post(f"/api/v1/workspaces/{ws.id}/reopen-pr/")

    assert resp.status_code == 200
    assert resp.json()["number"] == 7
