from typing import cast
from unittest.mock import MagicMock

import pytest

from apps.core.exceptions import ApplicationError
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import StorylineFile, Workspace
from apps.workspaces.services import (
    intro_comment_create,
    intro_comment_resolve,
    intro_comment_soft_delete,
    intro_comment_unresolve,
    intro_comment_update,
    storyline_create,
)


def _open_gateway():
    gw = MagicMock()
    gw.get_pr.return_value = {"state": "open"}
    return gw


def _closed_gateway():
    gw = MagicMock()
    gw.get_pr.return_value = {"state": "closed"}
    return gw


@pytest.fixture
def setup(db):
    creator = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(created_by=creator))
    storyline_create(workspace=ws, author=creator)
    sf = StorylineFile.objects.create(
        storyline=ws.storyline,  # pyrefly: ignore[missing-attribute]
        diff_file_path="a.py",
        order_index=0,
    )
    return ws, sf, creator


@pytest.mark.django_db
def test_intro_comment_create_root(setup) -> None:
    _ws, sf, creator = setup
    gw = _open_gateway()
    comment = intro_comment_create(storyline_file=sf, user=creator, body="hello", gateway=gw)
    assert comment.pk is not None
    assert comment.parent_id is None
    assert comment.body == "hello"


@pytest.mark.django_db
def test_intro_comment_create_reply(setup) -> None:
    _ws, sf, creator = setup
    gw = _open_gateway()
    root = intro_comment_create(storyline_file=sf, user=creator, body="root", gateway=gw)
    reply = intro_comment_create(
        storyline_file=sf, user=creator, body="reply", parent=root, gateway=gw
    )
    assert reply.parent_id == root.pk


@pytest.mark.django_db
def test_intro_comment_create_depth_exceeded(setup) -> None:
    _ws, sf, creator = setup
    gw = _open_gateway()
    root = intro_comment_create(storyline_file=sf, user=creator, body="root", gateway=gw)
    reply = intro_comment_create(
        storyline_file=sf, user=creator, body="reply", parent=root, gateway=gw
    )
    with pytest.raises(ApplicationError) as exc:
        intro_comment_create(
            storyline_file=sf, user=creator, body="nested", parent=reply, gateway=gw
        )
    assert exc.value.status == 400
    assert "depth_exceeded" in str(exc.value)


@pytest.mark.django_db
def test_intro_comment_create_frozen_workspace(setup) -> None:
    ws, sf, creator = setup
    ws.pr_number = 42
    ws.save(update_fields=["pr_number"])
    gw = _closed_gateway()
    with pytest.raises(ApplicationError) as exc:
        intro_comment_create(storyline_file=sf, user=creator, body="hi", gateway=gw)
    assert exc.value.status == 409
    assert "workspace_frozen" in str(exc.value)


@pytest.mark.django_db
def test_intro_comment_update_owner(setup) -> None:
    _ws, sf, creator = setup
    gw = _open_gateway()
    comment = intro_comment_create(storyline_file=sf, user=creator, body="orig", gateway=gw)
    updated = intro_comment_update(comment=comment, user=creator, body="new")
    assert updated.body == "new"


@pytest.mark.django_db
def test_intro_comment_update_not_owner(setup) -> None:
    _ws, sf, creator = setup
    gw = _open_gateway()
    comment = intro_comment_create(storyline_file=sf, user=creator, body="orig", gateway=gw)
    other = cast(User, UserFactory())
    with pytest.raises(ApplicationError) as exc:
        intro_comment_update(comment=comment, user=other, body="new")
    assert exc.value.status == 403


@pytest.mark.django_db
def test_intro_comment_update_deleted(setup) -> None:
    _ws, sf, creator = setup
    gw = _open_gateway()
    comment = intro_comment_create(storyline_file=sf, user=creator, body="orig", gateway=gw)
    intro_comment_soft_delete(comment=comment, user=creator)
    comment.refresh_from_db()
    with pytest.raises(ApplicationError) as exc:
        intro_comment_update(comment=comment, user=creator, body="new")
    assert exc.value.status == 409


@pytest.mark.django_db
def test_intro_comment_soft_delete_owner(setup) -> None:
    _ws, sf, creator = setup
    gw = _open_gateway()
    comment = intro_comment_create(storyline_file=sf, user=creator, body="bye", gateway=gw)
    intro_comment_soft_delete(comment=comment, user=creator)
    comment.refresh_from_db()
    assert comment.deleted_at is not None


@pytest.mark.django_db
def test_intro_comment_soft_delete_not_owner(setup) -> None:
    _ws, sf, creator = setup
    gw = _open_gateway()
    comment = intro_comment_create(storyline_file=sf, user=creator, body="bye", gateway=gw)
    other = cast(User, UserFactory())
    with pytest.raises(ApplicationError) as exc:
        intro_comment_soft_delete(comment=comment, user=other)
    assert exc.value.status == 403


@pytest.mark.django_db
def test_intro_comment_resolve_creator(setup) -> None:
    _ws, sf, creator = setup
    gw = _open_gateway()
    comment = intro_comment_create(storyline_file=sf, user=creator, body="root", gateway=gw)
    resolved = intro_comment_resolve(comment=comment, creator=creator)
    assert resolved.resolved_at is not None
    assert resolved.resolved_by_id == creator.pk


@pytest.mark.django_db
def test_intro_comment_resolve_not_creator(setup) -> None:
    _ws, sf, creator = setup
    gw = _open_gateway()
    comment = intro_comment_create(storyline_file=sf, user=creator, body="root", gateway=gw)
    other = cast(User, UserFactory())
    with pytest.raises(ApplicationError) as exc:
        intro_comment_resolve(comment=comment, creator=other)
    assert exc.value.status == 403


@pytest.mark.django_db
def test_intro_comment_resolve_reply_raises(setup) -> None:
    _ws, sf, creator = setup
    gw = _open_gateway()
    root = intro_comment_create(storyline_file=sf, user=creator, body="root", gateway=gw)
    reply = intro_comment_create(
        storyline_file=sf, user=creator, body="reply", parent=root, gateway=gw
    )
    with pytest.raises(ApplicationError) as exc:
        intro_comment_resolve(comment=reply, creator=creator)
    assert exc.value.status == 400


@pytest.mark.django_db
def test_intro_comment_unresolve_creator(setup) -> None:
    _ws, sf, creator = setup
    gw = _open_gateway()
    comment = intro_comment_create(storyline_file=sf, user=creator, body="root", gateway=gw)
    intro_comment_resolve(comment=comment, creator=creator)
    comment.refresh_from_db()
    unresolved = intro_comment_unresolve(comment=comment, creator=creator)
    assert unresolved.resolved_at is None
    assert unresolved.resolved_by_id is None


@pytest.mark.django_db
def test_intro_comment_unresolve_not_creator(setup) -> None:
    _ws, sf, creator = setup
    gw = _open_gateway()
    comment = intro_comment_create(storyline_file=sf, user=creator, body="root", gateway=gw)
    other = cast(User, UserFactory())
    with pytest.raises(ApplicationError) as exc:
        intro_comment_unresolve(comment=comment, creator=other)
    assert exc.value.status == 403
