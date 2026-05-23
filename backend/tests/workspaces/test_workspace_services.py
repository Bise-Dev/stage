from typing import cast

import pytest

from apps.core.exceptions import ApplicationError
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Workspace
from apps.workspaces.services import workspace_create, workspace_update_local_phase


@pytest.mark.django_db
def test_workspace_create_persists_with_creator() -> None:
    creator = cast(User, UserFactory())
    ws = workspace_create(
        creator=creator, repo_owner="o", repo_name="r",
        head_ref="feat/x", base_ref="main",
    )
    assert ws.created_by_id == creator.pk
    assert ws.pr_number is None
    assert Workspace.objects.filter(pk=ws.pk).exists()


@pytest.mark.django_db
def test_workspace_create_rejects_duplicate() -> None:
    creator = cast(User, UserFactory())
    WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="feat/x", created_by=creator)
    with pytest.raises(ApplicationError) as exc:
        workspace_create(creator=creator, repo_owner="o", repo_name="r", head_ref="feat/x", base_ref="main")
    assert exc.value.status == 409


@pytest.mark.django_db
def test_workspace_update_local_phase_changes_head_ref() -> None:
    ws = cast(Workspace, WorkspaceFactory(head_ref="feat/x"))
    updated = workspace_update_local_phase(workspace=ws, head_ref="feat/y")
    assert updated.head_ref == "feat/y"


@pytest.mark.django_db
def test_workspace_update_local_phase_rejects_when_pr_open() -> None:
    ws = cast(Workspace, WorkspaceFactory(pr_number=42))
    with pytest.raises(ApplicationError) as exc:
        workspace_update_local_phase(workspace=ws, head_ref="other")
    assert exc.value.status == 409
