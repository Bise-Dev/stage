from typing import cast

import pytest

from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import IntroComment, StorylineFile, Workspace
from apps.workspaces.services import storyline_create


@pytest.fixture
def storyline_file(db) -> StorylineFile:
    user = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(created_by=user))
    storyline_create(workspace=ws, author=user)
    return StorylineFile.objects.create(
        storyline=ws.storyline,  # pyrefly: ignore[missing-attribute]
        diff_file_path="a.py",
        order_index=0,
    )


@pytest.mark.django_db
def test_intro_comment_root(storyline_file) -> None:
    user = cast(User, UserFactory())
    c = IntroComment.objects.create(storyline_file=storyline_file, user=user, body="hi")
    assert c.parent_id is None
    assert c.resolved_at is None


@pytest.mark.django_db
def test_intro_comment_reply_depth1(storyline_file) -> None:
    user = cast(User, UserFactory())
    root = IntroComment.objects.create(storyline_file=storyline_file, user=user, body="root")
    reply = IntroComment.objects.create(
        storyline_file=storyline_file, user=user, body="reply", parent=root
    )
    assert reply.parent_id == root.pk
