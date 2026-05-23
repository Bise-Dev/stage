from typing import cast

import pytest
from rest_framework.test import APIClient

from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Workspace


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
    client, _ = authed_client
    WorkspaceFactory()
    resp = client.get("/api/v1/workspaces/")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1


@pytest.mark.django_db
def test_workspace_lookup_api_hit(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(repo_owner="o", repo_name="r", pr_number=42, created_by=user))
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
    client, _ = authed_client
    ws = cast(Workspace, WorkspaceFactory())
    resp = client.get(f"/api/v1/workspaces/{ws.id}/")
    assert resp.status_code == 200
    assert resp.json()["id"] == str(ws.id)


@pytest.mark.django_db
def test_workspace_update_api(authed_client) -> None:
    client, _ = authed_client
    ws = cast(Workspace, WorkspaceFactory(head_ref="feat/x"))
    resp = client.patch(f"/api/v1/workspaces/{ws.id}/", {"head_ref": "feat/y"}, format="json")
    assert resp.status_code == 200
    ws.refresh_from_db()
    assert ws.head_ref == "feat/y"
