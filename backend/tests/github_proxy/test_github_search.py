from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from rest_framework.test import APIClient

from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory

SEARCH_ITEMS = [
    {
        "number": 10,
        "repository_url": "https://api.github.com/repos/acme/alpha",
        "title": "PR Alpha",
    },
    {
        "number": 20,
        "repository_url": "https://api.github.com/repos/acme/beta",
        "title": "PR Beta",
    },
]


@pytest.fixture
def authed_client(db) -> tuple[APIClient, User]:
    user = cast(User, UserFactory(github_login="ghuser"))
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client, user


def _mock_gateway(items=None):
    mock_gw = MagicMock()
    mock_gw.__enter__ = MagicMock(return_value=mock_gw)
    mock_gw.__exit__ = MagicMock(return_value=False)
    mock_gw.search_issues.return_value = {
        "items": items if items is not None else SEARCH_ITEMS,
        "total_count": len(items or SEARCH_ITEMS),
    }
    return mock_gw


@pytest.mark.django_db
def test_author_role_no_existing_workspaces(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        gw_factory.return_value = _mock_gateway()
        resp = client.get("/api/v1/github/prs/?role=author")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 2
    assert len(data["items"]) == 2


@pytest.mark.django_db
def test_reviewer_role_no_existing_workspaces(authed_client) -> None:
    client, _ = authed_client
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        gw_factory.return_value = _mock_gateway()
        resp = client.get("/api/v1/github/prs/?role=reviewer")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 2
    assert len(data["items"]) == 2


@pytest.mark.django_db
def test_cross_filter_existing_workspace(authed_client) -> None:
    client, user = authed_client
    WorkspaceFactory(repo_owner="acme", repo_name="alpha", pr_number=10, created_by=user)
    with patch("apps.github_proxy.apis._gateway") as gw_factory:
        gw_factory.return_value = _mock_gateway()
        resp = client.get("/api/v1/github/prs/?role=author")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 1
    assert data["items"][0]["number"] == 20


@pytest.mark.django_db
def test_invalid_role_returns_400(authed_client) -> None:
    client, _ = authed_client
    resp = client.get("/api/v1/github/prs/?role=unknown")
    assert resp.status_code == 400
    assert resp.json()["message"] == "invalid_role"


@pytest.mark.django_db
def test_missing_role_returns_400(authed_client) -> None:
    client, _ = authed_client
    resp = client.get("/api/v1/github/prs/")
    assert resp.status_code == 400
    assert resp.json()["message"] == "invalid_role"


@pytest.mark.django_db
def test_no_github_login_returns_400(db) -> None:
    user = cast(User, UserFactory(github_login=""))
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    resp = client.get("/api/v1/github/prs/?role=author")
    assert resp.status_code == 400
    assert resp.json()["message"] == "no_github_identity"
