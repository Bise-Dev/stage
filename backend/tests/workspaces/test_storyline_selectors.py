from typing import cast
from unittest.mock import MagicMock

import pytest

from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import StorylineFile, Workspace
from apps.workspaces.selectors import storyline_read
from apps.workspaces.services import storyline_create


@pytest.fixture
def author_ws(db) -> tuple[Workspace, User]:
    user = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(created_by=user))
    storyline_create(workspace=ws, author=user)
    return ws, user


def test_storyline_read_local_phase_no_stale(author_ws) -> None:
    ws, _ = author_ws
    StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="a.py", order_index=0, intro_text="hi")
    gateway = MagicMock()
    data, etag = storyline_read(workspace=ws, gateway=gateway)
    assert etag
    assert data["files"][0]["stale"] is False
    gateway.list_pr_files.assert_not_called()


def test_storyline_read_public_phase_marks_stale(author_ws) -> None:
    ws, _ = author_ws
    ws.pr_number = 5
    ws.save(update_fields=["pr_number"])
    StorylineFile.objects.create(storyline=ws.storyline, diff_file_path="gone.py", order_index=0, intro_text="x")
    gateway = MagicMock()
    gateway.list_pr_files.return_value = [{"filename": "still_here.py"}]
    gateway.get_pr.return_value = {"head": {"sha": "abc"}}
    data, _ = storyline_read(workspace=ws, gateway=gateway)
    assert data["files"][0]["stale"] is True
    assert data["files"][0]["stale_reason"] == "file_removed"
