from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from rest_framework.test import APIClient

from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import StorylineFile, Workspace
from apps.workspaces.services import intro_comment_create, storyline_create


@pytest.fixture
def authed_ws(db) -> tuple[APIClient, User, Workspace, StorylineFile]:
    user = cast(User, UserFactory())
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    ws = cast(Workspace, WorkspaceFactory(created_by=user))
    storyline_create(workspace=ws, author=user)
    sf = StorylineFile.objects.create(
        storyline=ws.storyline,  # pyrefly: ignore[missing-attribute]
        diff_file_path="a.py",
        order_index=0,
    )
    return client, user, ws, sf


def _open_gw():
    gw = MagicMock()
    gw.__enter__ = lambda s: gw
    gw.__exit__ = MagicMock(return_value=False)
    gw.get_pr.return_value = {"state": "open"}
    return gw


@pytest.mark.django_db
def test_intro_comment_collection_get_empty(authed_ws) -> None:
    client, _, ws, sf = authed_ws
    resp = client.get(f"/api/v1/workspaces/{ws.id}/storyline/files/{sf.id}/intro-comments/")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.django_db
def test_intro_comment_collection_post_creates(authed_ws) -> None:
    client, user, ws, sf = authed_ws
    with patch("apps.workspaces.apis._gateway", return_value=_open_gw()):
        resp = client.post(
            f"/api/v1/workspaces/{ws.id}/storyline/files/{sf.id}/intro-comments/",
            {"body": "hello"},
            format="json",
        )
    assert resp.status_code == 201
    data = resp.json()
    assert data["body"] == "hello"
    assert data["parent_id"] is None


@pytest.mark.django_db
def test_intro_comment_collection_post_reply(authed_ws) -> None:
    client, user, ws, sf = authed_ws
    gw = _open_gw()
    root = intro_comment_create(storyline_file=sf, user=user, body="root", gateway=gw)
    with patch("apps.workspaces.apis._gateway", return_value=_open_gw()):
        resp = client.post(
            f"/api/v1/workspaces/{ws.id}/storyline/files/{sf.id}/intro-comments/",
            {"body": "reply", "parent_id": str(root.pk)},
            format="json",
        )
    assert resp.status_code == 201
    assert resp.json()["parent_id"] == str(root.pk)


@pytest.mark.django_db
def test_intro_comment_collection_post_depth_exceeded(authed_ws) -> None:
    client, user, ws, sf = authed_ws
    gw = _open_gw()
    root = intro_comment_create(storyline_file=sf, user=user, body="root", gateway=gw)
    reply = intro_comment_create(storyline_file=sf, user=user, body="reply", parent=root, gateway=gw)
    with patch("apps.workspaces.apis._gateway", return_value=_open_gw()):
        resp = client.post(
            f"/api/v1/workspaces/{ws.id}/storyline/files/{sf.id}/intro-comments/",
            {"body": "deep", "parent_id": str(reply.pk)},
            format="json",
        )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_intro_comment_detail_patch_owner(authed_ws) -> None:
    client, user, ws, sf = authed_ws
    gw = _open_gw()
    comment = intro_comment_create(storyline_file=sf, user=user, body="orig", gateway=gw)
    resp = client.patch(
        f"/api/v1/intro-comments/{comment.pk}/",
        {"body": "updated"},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.json()["body"] == "updated"


@pytest.mark.django_db
def test_intro_comment_detail_patch_not_owner(authed_ws) -> None:
    client, user, ws, sf = authed_ws
    gw = _open_gw()
    other = cast(User, UserFactory())
    comment = intro_comment_create(storyline_file=sf, user=other, body="orig", gateway=gw)
    resp = client.patch(
        f"/api/v1/intro-comments/{comment.pk}/",
        {"body": "updated"},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_intro_comment_delete_owner(authed_ws) -> None:
    client, user, ws, sf = authed_ws
    gw = _open_gw()
    comment = intro_comment_create(storyline_file=sf, user=user, body="bye", gateway=gw)
    resp = client.post(f"/api/v1/intro-comments/{comment.pk}/delete/")
    assert resp.status_code == 204


@pytest.mark.django_db
def test_intro_comment_delete_not_owner(authed_ws) -> None:
    client, user, ws, sf = authed_ws
    gw = _open_gw()
    other = cast(User, UserFactory())
    comment = intro_comment_create(storyline_file=sf, user=other, body="bye", gateway=gw)
    resp = client.post(f"/api/v1/intro-comments/{comment.pk}/delete/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_intro_comment_resolve_creator(authed_ws) -> None:
    client, user, ws, sf = authed_ws
    gw = _open_gw()
    comment = intro_comment_create(storyline_file=sf, user=user, body="root", gateway=gw)
    resp = client.post(f"/api/v1/intro-comments/{comment.pk}/resolve/")
    assert resp.status_code == 200
    assert resp.json()["resolved_at"] is not None


@pytest.mark.django_db
def test_intro_comment_resolve_not_creator(authed_ws) -> None:
    client, user, ws, sf = authed_ws
    gw = _open_gw()
    other = cast(User, UserFactory())
    other_raw, _ = session_issue(user=other)
    other_client = APIClient()
    other_client.credentials(HTTP_AUTHORIZATION=f"Bearer {other_raw}")
    comment = intro_comment_create(storyline_file=sf, user=user, body="root", gateway=gw)
    resp = other_client.post(f"/api/v1/intro-comments/{comment.pk}/resolve/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_intro_comment_unresolve_creator(authed_ws) -> None:
    client, user, ws, sf = authed_ws
    gw = _open_gw()
    comment = intro_comment_create(storyline_file=sf, user=user, body="root", gateway=gw)
    client.post(f"/api/v1/intro-comments/{comment.pk}/resolve/")
    resp = client.post(f"/api/v1/intro-comments/{comment.pk}/unresolve/")
    assert resp.status_code == 200
    assert resp.json()["resolved_at"] is None


@pytest.mark.django_db
def test_intro_comment_get_includes_resolved(authed_ws) -> None:
    client, user, ws, sf = authed_ws
    gw = _open_gw()
    comment = intro_comment_create(storyline_file=sf, user=user, body="root", gateway=gw)
    client.post(f"/api/v1/intro-comments/{comment.pk}/resolve/")

    resp_default = client.get(
        f"/api/v1/workspaces/{ws.id}/storyline/files/{sf.id}/intro-comments/"
    )
    assert resp_default.json() == []

    resp_with = client.get(
        f"/api/v1/workspaces/{ws.id}/storyline/files/{sf.id}/intro-comments/?include_resolved=true"
    )
    assert len(resp_with.json()) == 1
