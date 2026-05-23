from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from rest_framework.test import APIClient

from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import StorylineFile, Workspace
from apps.workspaces.services import storyline_create


@pytest.fixture
def authed_ws(db) -> tuple[APIClient, User, Workspace]:
    user = cast(User, UserFactory())
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    ws = cast(Workspace, WorkspaceFactory(created_by=user))
    storyline_create(workspace=ws, author=user)
    return client, user, ws


@pytest.mark.django_db
def test_storyline_get_returns_etag(authed_ws) -> None:
    client, _, ws = authed_ws
    StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="a.py", order_index=0, intro_text="hi")
    resp = client.get(f"/api/v1/workspaces/{ws.id}/storyline/")
    assert resp.status_code == 200
    assert resp["ETag"] == ws.storyline.etag


@pytest.mark.django_db
def test_storyline_put_requires_if_match(authed_ws) -> None:
    client, _, ws = authed_ws
    resp = client.put(f"/api/v1/workspaces/{ws.id}/storyline/", {"files": []}, format="json")
    assert resp.status_code == 412


@pytest.mark.django_db
def test_storyline_put_etag_mismatch_409(authed_ws) -> None:
    client, _, ws = authed_ws
    resp = client.put(
        f"/api/v1/workspaces/{ws.id}/storyline/",
        {"files": []},
        format="json",
        HTTP_IF_MATCH="wrong",
    )
    assert resp.status_code == 409
    assert resp.json()["message"] == "etag_mismatch"


@pytest.mark.django_db
def test_storyline_put_writes_files(authed_ws) -> None:
    client, _, ws = authed_ws
    resp = client.put(
        f"/api/v1/workspaces/{ws.id}/storyline/",
        {"files": [{"diff_file_path": "a.py", "order_index": 0, "title": "Hi", "intro_text": "intro"}]},
        format="json",
        HTTP_IF_MATCH=ws.storyline.etag,
    )
    assert resp.status_code == 200
    assert resp.json()["files"][0]["diff_file_path"] == "a.py"


@pytest.mark.django_db
def test_storyline_put_rejects_non_creator(authed_ws) -> None:
    client, _, ws = authed_ws
    bob = cast(User, UserFactory())
    raw, _ = session_issue(user=bob)
    bob_client = APIClient()
    bob_client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    resp = bob_client.put(
        f"/api/v1/workspaces/{ws.id}/storyline/",
        {"files": []},
        format="json",
        HTTP_IF_MATCH=ws.storyline.etag,
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_storyline_get_single_file(authed_ws) -> None:
    client, _, ws = authed_ws
    f = StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="a.py", order_index=0)
    resp = client.get(f"/api/v1/workspaces/{ws.id}/storyline/files/{f.pk}/")
    assert resp.status_code == 200
    assert resp.json()["diff_file_path"] == "a.py"
