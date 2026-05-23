import uuid
from typing import cast

import pytest

from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Workspace


@pytest.mark.django_db
def test_workspace_has_uuid_id_from_base_model() -> None:
    ws = cast(Workspace, WorkspaceFactory())
    assert isinstance(ws.id, uuid.UUID)
    assert ws.pr_number is None


@pytest.mark.django_db
def test_workspace_unique_per_repo_head_ref() -> None:
    creator = cast(User, UserFactory())
    WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="feat/x", created_by=creator)
    with pytest.raises(Exception):
        WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="feat/x", created_by=creator)


@pytest.mark.django_db
def test_workspace_unique_per_repo_pr_when_pr_set() -> None:
    creator = cast(User, UserFactory())
    WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="a", pr_number=42, created_by=creator)
    with pytest.raises(Exception):
        WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="b", pr_number=42, created_by=creator)
