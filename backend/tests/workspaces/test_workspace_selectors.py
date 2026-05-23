from typing import cast

import pytest

from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Workspace
from apps.workspaces.selectors import workspace_get, workspace_list, workspace_lookup


@pytest.mark.django_db
def test_workspace_list_returns_own_drafts_and_published() -> None:
    user = cast(User, UserFactory())
    WorkspaceFactory(created_by=user)
    WorkspaceFactory(created_by=user, pr_number=1)
    other = cast(User, UserFactory())
    WorkspaceFactory(created_by=other)
    # user sees own draft + own published; not other's draft
    assert workspace_list(user=user).count() == 2


@pytest.mark.django_db
def test_workspace_lookup_hit() -> None:
    ws = cast(Workspace, WorkspaceFactory(repo_owner="o", repo_name="r", pr_number=42))
    assert workspace_lookup(repo_owner="o", repo_name="r", pr_number=42) == ws


@pytest.mark.django_db
def test_workspace_lookup_miss() -> None:
    assert workspace_lookup(repo_owner="o", repo_name="r", pr_number=99) is None


@pytest.mark.django_db
def test_workspace_get_raises_when_missing() -> None:
    from apps.workspaces.models import Workspace as _W
    import uuid
    with pytest.raises(_W.DoesNotExist):
        workspace_get(workspace_id=uuid.uuid4())
