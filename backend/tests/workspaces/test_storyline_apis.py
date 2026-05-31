from typing import cast

import pytest
from rest_framework.test import APIClient

from apps.identity.factories import GitHubIdentityFactory
from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import StorylineFile, Workspace
from apps.workspaces.services import storyline_create


@pytest.fixture
def authed_ws(db) -> tuple[APIClient, User, Workspace]:
    user = cast(User, UserFactory())
    GitHubIdentityFactory(user=user)
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    ws = cast(Workspace, WorkspaceFactory(created_by=user))
    storyline_create(workspace=ws, author=user)
    return client, user, ws


@pytest.mark.django_db
def test_storyline_get_returns_etag(authed_ws) -> None:
    client, _, ws = authed_ws
    StorylineFile.objects.create(
        storyline=ws.storyline, diff_file_path="a.py", order_index=0, intro_text="hi"
    )
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
        {"files": [{"diff_file_path": "a.py", "order_index": 0, "intro_text": "intro"}]},
        format="json",
        HTTP_IF_MATCH=ws.storyline.etag,
    )
    assert resp.status_code == 200
    assert resp.json()["files"][0]["diff_file_path"] == "a.py"


@pytest.mark.django_db
def test_storyline_put_rejects_non_creator(authed_ws) -> None:
    _, _, ws = authed_ws
    bob = cast(User, UserFactory())
    GitHubIdentityFactory(user=bob)
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


@pytest.mark.django_db
def test_storyline_pre_publish_404_for_non_creator(authed_ws, db) -> None:
    from apps.identity.services import session_issue
    from apps.users.factories import UserFactory

    _, _, ws = authed_ws
    user_b = cast(User, UserFactory())
    raw_b, _ = session_issue(user=user_b)
    client_b = APIClient()
    client_b.credentials(HTTP_AUTHORIZATION=f"Bearer {raw_b}")

    # pre-publish: non-creator gets 404 (enumeration guard)
    resp = client_b.get(f"/api/v1/workspaces/{ws.id}/storyline/")
    assert resp.status_code == 404
    # post-publish happy path (any authed user 200) is covered by the
    # existing storyline-read tests; verifying it here would require
    # mocking the github gateway, which is out of scope for this gate.
