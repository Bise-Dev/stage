import uuid
from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Storyline, Workspace


@pytest.fixture
def authed_client(db) -> tuple[APIClient, User]:
    user = cast(User, UserFactory())
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client, user


@pytest.mark.django_db
def test_workspace_create_api_201(authed_client) -> None:
    client, _ = authed_client
    resp = client.post(
        "/api/v1/workspaces/",
        {"repo_owner": "o", "repo_name": "r", "head_ref": "feat/x", "base_ref": "main"},
        format="json",
    )
    assert resp.status_code == 201
    assert resp.json()["head_ref"] == "feat/x"
    assert Workspace.objects.filter(repo_owner="o", head_ref="feat/x").exists()


@pytest.mark.django_db
def test_workspace_create_duplicate_returns_409(authed_client) -> None:
    client, user = authed_client
    WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="feat/x", created_by=user)
    resp = client.post(
        "/api/v1/workspaces/",
        {"repo_owner": "o", "repo_name": "r", "head_ref": "feat/x", "base_ref": "main"},
        format="json",
    )
    assert resp.status_code == 409


@pytest.mark.django_db
def test_workspace_list_api(authed_client) -> None:
    client, user = authed_client
    WorkspaceFactory(created_by=user)
    resp = client.get("/api/v1/workspaces/")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1


@pytest.mark.django_db
def test_workspace_lookup_api_hit(authed_client) -> None:
    client, user = authed_client
    ws = cast(
        Workspace, WorkspaceFactory(repo_owner="o", repo_name="r", pr_number=42, created_by=user)
    )
    resp = client.get("/api/v1/workspaces/lookup/?repo_owner=o&repo_name=r&pr_number=42")
    assert resp.status_code == 200
    assert resp.json()["workspace_id"] == str(ws.id)


@pytest.mark.django_db
def test_workspace_lookup_api_miss(authed_client) -> None:
    client, _ = authed_client
    resp = client.get("/api/v1/workspaces/lookup/?repo_owner=o&repo_name=r&pr_number=99")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_workspace_detail_api(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user))
    resp = client.get(f"/api/v1/workspaces/{ws.id}/")
    assert resp.status_code == 200
    assert resp.json()["id"] == str(ws.id)


@pytest.mark.django_db
def test_workspace_update_api(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(head_ref="feat/x", created_by=user))
    resp = client.patch(f"/api/v1/workspaces/{ws.id}/", {"head_ref": "feat/y"}, format="json")
    assert resp.status_code == 200
    ws.refresh_from_db()
    assert ws.head_ref == "feat/y"


def _make_authed_client(db) -> tuple[APIClient, User]:
    user = cast(User, UserFactory())
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client, user


@pytest.mark.django_db
def test_workspace_list_excludes_other_users_drafts(authed_client) -> None:
    client_b, _user_b = authed_client
    user_a = cast(User, UserFactory())
    draft_a = cast(Workspace, WorkspaceFactory(created_by=user_a))
    published_a = cast(Workspace, WorkspaceFactory(created_by=user_a, pr_number=10))

    resp = client_b.get("/api/v1/workspaces/")
    assert resp.status_code == 200
    ids = {w["id"] for w in resp.json()}
    assert str(draft_a.id) not in ids
    assert str(published_a.id) in ids


@pytest.mark.django_db
def test_workspace_detail_pre_publish_404_for_non_creator(authed_client) -> None:
    client_b, _user_b = authed_client
    user_a = cast(User, UserFactory())
    draft_a = cast(Workspace, WorkspaceFactory(created_by=user_a))
    published_a = cast(Workspace, WorkspaceFactory(created_by=user_a, pr_number=11))

    resp = client_b.get(f"/api/v1/workspaces/{draft_a.id}/")
    assert resp.status_code == 404

    resp = client_b.get(f"/api/v1/workspaces/{published_a.id}/")
    assert resp.status_code == 200


@pytest.mark.django_db
def test_workspace_patch_local_phase_creator_only(authed_client) -> None:
    client_b, _user_b = authed_client
    user_a = cast(User, UserFactory())
    ws_a = cast(Workspace, WorkspaceFactory(created_by=user_a, head_ref="feat/x"))

    resp = client_b.patch(f"/api/v1/workspaces/{ws_a.id}/", {"head_ref": "feat/z"}, format="json")
    assert resp.status_code == 403


def _gw_empty() -> MagicMock:
    """A gateway whose searches return nothing — enough for an overview that
    contains only pre-publish (draft) workspaces, which never fan out to GitHub."""
    gw = MagicMock()
    gw.__enter__ = lambda s: s
    gw.__exit__ = MagicMock(return_value=False)
    gw.search_issues.return_value = {"items": []}
    gw.get_pr.return_value = {"state": "open", "head": {"ref": "feat/x"}}
    gw.list_reviews.return_value = []
    return gw


@pytest.mark.django_db
def test_workspace_create_invalidates_overview_cache(authed_client) -> None:
    """Creating a workspace must bust the cached overview for that (user, repo)
    so the new row is visible immediately, not after the 30s TTL."""
    client, _ = authed_client
    cache.clear()  # LocMemCache persists across tests in-process; isolate this one.
    with patch("apps.workspaces.apis.make_user_gateway", return_value=_gw_empty()):
        # Prime the per-(user, repo) overview cache: no workspaces yet.
        primed = client.get("/api/v1/repos/o/r/overview/")
        assert primed.status_code == 200, primed.content
        assert primed.json() == []

        created = client.post(
            "/api/v1/workspaces/",
            {"repo_owner": "o", "repo_name": "r", "head_ref": "feat/x", "base_ref": "main"},
            format="json",
        )
        assert created.status_code == 201, created.content

        # Must reflect the new workspace right away (cache invalidated on create).
        after = client.get("/api/v1/repos/o/r/overview/")
    assert after.status_code == 200, after.content
    rows = after.json()
    assert any(r["kind"] == "workspace" and r["head_ref"] == "feat/x" for r in rows), rows


@pytest.mark.django_db
def test_workspace_delete_pre_publish_204(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    Storyline.objects.create(workspace=ws, etag="e", updated_by=user)
    resp = client.delete(f"/api/v1/workspaces/{ws.id}/")
    assert resp.status_code == 204, resp.content
    assert not Workspace.objects.filter(pk=ws.id).exists()
    assert not Storyline.objects.filter(workspace_id=ws.id).exists()


@pytest.mark.django_db
def test_workspace_delete_invalidates_overview_cache(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    cache.clear()
    with patch("apps.workspaces.apis.make_user_gateway", return_value=_gw_empty()):
        primed = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
        assert primed.status_code == 200, primed.content
        assert any(r["kind"] == "workspace" and r["id"] == str(ws.id) for r in primed.json())

        deleted = client.delete(f"/api/v1/workspaces/{ws.id}/")
        assert deleted.status_code == 204, deleted.content

        after = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
    assert after.status_code == 200, after.content
    assert all(r.get("id") != str(ws.id) for r in after.json())


@pytest.mark.django_db
def test_workspace_delete_published_409(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=42))
    resp = client.delete(f"/api/v1/workspaces/{ws.id}/")
    assert resp.status_code == 409, resp.content
    assert Workspace.objects.filter(pk=ws.id).exists()


@pytest.mark.django_db
def test_workspace_delete_non_creator_pre_publish_404(authed_client) -> None:
    client_b, _user_b = authed_client
    user_a = cast(User, UserFactory())
    ws_a = cast(Workspace, WorkspaceFactory(created_by=user_a, pr_number=None))
    resp = client_b.delete(f"/api/v1/workspaces/{ws_a.id}/")
    assert resp.status_code == 404, resp.content
    assert Workspace.objects.filter(pk=ws_a.id).exists()


@pytest.mark.django_db
def test_workspace_delete_non_creator_published_403(authed_client) -> None:
    client_b, _user_b = authed_client
    user_a = cast(User, UserFactory())
    ws_a = cast(Workspace, WorkspaceFactory(created_by=user_a, pr_number=11))
    resp = client_b.delete(f"/api/v1/workspaces/{ws_a.id}/")
    assert resp.status_code == 403, resp.content
    assert Workspace.objects.filter(pk=ws_a.id).exists()


@pytest.mark.django_db
def test_workspace_delete_unknown_404(authed_client) -> None:
    client, _ = authed_client
    resp = client.delete(f"/api/v1/workspaces/{uuid.uuid4()}/")
    assert resp.status_code == 404, resp.content
