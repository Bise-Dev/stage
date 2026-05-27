from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from rest_framework.test import APIClient

from apps.identity.factories import GitHubIdentityFactory
from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Storyline, StorylineFile, Workspace

_PR_OPEN = {
    "additions": 10,
    "deletions": 2,
    "review_comments": 3,
    "state": "open",
    "merged": False,
    "head": {"ref": "feat/x"},
}


@pytest.fixture
def authed_client(db) -> tuple[APIClient, User]:
    user = cast(User, UserFactory(github_login="ghuser"))
    GitHubIdentityFactory(user=user)
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client, user


def _gw(*, search_items=None, pr=None, reviews=None) -> MagicMock:
    gw = MagicMock()
    gw.__enter__ = lambda s: s
    gw.__exit__ = MagicMock(return_value=False)
    gw.search_issues.return_value = {"items": search_items or []}
    gw.get_pr.return_value = pr if pr is not None else dict(_PR_OPEN)
    gw.list_reviews.return_value = reviews or []
    return gw


def _overview(client, ws) -> list[dict]:
    resp = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
    assert resp.status_code == 200, resp.content
    return resp.json()


@pytest.mark.django_db
def test_pre_publish_workspace_is_draft(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    with patch("apps.workspaces.apis.make_user_gateway", return_value=_gw()):
        rows = _overview(client, ws)
    assert len(rows) == 1
    row = rows[0]
    assert row["kind"] == "workspace"
    assert row["state"] == "draft"
    assert row["title"] == ws.title
    assert row["added"] is None and row["removed"] is None


@pytest.mark.django_db
def test_pre_publish_ready_to_publish_when_storyline_complete(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    s = Storyline.objects.create(workspace=ws, etag="e", updated_by=user)
    StorylineFile.objects.create(
        storyline=s, diff_file_path="a.py", order_index=0, intro_text="why this file"
    )
    with patch("apps.workspaces.apis.make_user_gateway", return_value=_gw()):
        rows = _overview(client, ws)
    assert rows[0]["state"] == "ready_to_publish"
    assert rows[0]["storyline_count"] == 1


@pytest.mark.django_db
def test_published_workspace_enriched_from_github(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=482))
    gw = _gw(reviews=[{"user": {"login": "rev"}, "state": "APPROVED"}])
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        rows = _overview(client, ws)
    row = rows[0]
    assert row["state"] == "approved"
    assert row["added"] == 10 and row["removed"] == 2
    assert row["comment_count"] == 3


@pytest.mark.django_db
def test_published_changes_requested(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=479))
    gw = _gw(
        reviews=[
            {"user": {"login": "a"}, "state": "APPROVED"},
            {"user": {"login": "b"}, "state": "CHANGES_REQUESTED"},
        ]
    )
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        rows = _overview(client, ws)
    assert rows[0]["state"] == "changes_requested"


@pytest.mark.django_db
def test_published_frozen_when_pr_closed(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=478))
    gw = _gw(pr={**_PR_OPEN, "state": "closed"})
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        rows = _overview(client, ws)
    assert rows[0]["state"] == "frozen"


@pytest.mark.django_db
def test_open_pr_included_and_repo_scoped(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    # One open PR in this repo (no workspace) + one in a different repo (filtered out).
    search_items = [
        {
            "number": 99,
            "repository_url": f"https://api.github.com/repos/{ws.repo_owner}/{ws.repo_name}",
            "title": "Open PR here",
            "html_url": "https://github.com/x/pull/99",
            "updated_at": "2026-05-26T12:00:00Z",
            "user": {"login": "ghuser", "avatar_url": "https://a/x.png"},
        },
        {
            "number": 7,
            "repository_url": "https://api.github.com/repos/other/repo",
            "title": "Elsewhere",
            "html_url": "https://github.com/other/repo/pull/7",
            "updated_at": "2026-05-26T12:00:00Z",
            "user": {"login": "ghuser", "avatar_url": None},
        },
    ]
    gw = _gw(search_items=search_items)
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        rows = _overview(client, ws)
    kinds = [r["kind"] for r in rows]
    assert kinds.count("workspace") == 1
    open_rows = [r for r in rows if r["kind"] == "open_pr"]
    assert len(open_rows) == 1
    assert open_rows[0]["number"] == 99
    assert open_rows[0]["head_ref"] == "feat/x"


@pytest.mark.django_db
def test_workspace_in_other_repo_excluded(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    WorkspaceFactory(created_by=user, pr_number=None)  # different repo (factory sequence)
    with patch("apps.workspaces.apis.make_user_gateway", return_value=_gw()):
        rows = _overview(client, ws)
    assert len(rows) == 1
    assert rows[0]["repo_name"] == ws.repo_name
