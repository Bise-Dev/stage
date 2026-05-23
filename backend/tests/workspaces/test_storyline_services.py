from typing import cast
from unittest.mock import MagicMock

import pytest

from apps.core.exceptions import ApplicationError
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Storyline, StorylineFile, Workspace
from apps.workspaces.services import storyline_create, storyline_replace


@pytest.fixture
def author_ws(db) -> tuple[Workspace, User]:
    user = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(created_by=user))
    storyline_create(workspace=ws, author=user)
    return ws, user


def test_storyline_replace_rejects_non_creator(author_ws) -> None:
    ws, _ = author_ws
    bob = cast(User, UserFactory())
    gateway = MagicMock()
    with pytest.raises(ApplicationError) as exc:
        storyline_replace(workspace=ws, user=bob, files=[], if_match=ws.storyline.etag, gateway=gateway)
    assert exc.value.status == 403


def test_storyline_replace_rejects_stale_etag(author_ws) -> None:
    ws, user = author_ws
    gateway = MagicMock()
    with pytest.raises(ApplicationError) as exc:
        storyline_replace(workspace=ws, user=user, files=[], if_match="wrong", gateway=gateway)
    assert exc.value.status == 409
    assert exc.value.message == "etag_mismatch"


def test_storyline_replace_rejects_frozen(author_ws) -> None:
    ws, user = author_ws
    ws.pr_number = 1
    ws.save(update_fields=["pr_number"])
    gateway = MagicMock()
    gateway.get_pr.return_value = {"state": "closed", "merged": False}
    with pytest.raises(ApplicationError) as exc:
        storyline_replace(workspace=ws, user=user, files=[], if_match=ws.storyline.etag, gateway=gateway)
    assert exc.value.status == 409
    assert exc.value.message == "workspace_frozen"


def test_storyline_replace_swaps_files_and_returns_new_etag(author_ws) -> None:
    ws, user = author_ws
    StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="old.py", order_index=0)
    gateway = MagicMock()
    old = ws.storyline.etag
    new = storyline_replace(
        workspace=ws, user=user,
        files=[{"diff_file_path": "new.py", "order_index": 0, "title": "T", "intro_text": "i"}],
        if_match=old, gateway=gateway,
    )
    assert new != old
    ws.refresh_from_db()
    assert ws.storyline.files.count() == 1
    assert ws.storyline.files.first().diff_file_path == "new.py"
