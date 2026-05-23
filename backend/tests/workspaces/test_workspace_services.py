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
    creator = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(head_ref="feat/x", created_by=creator))
    updated = workspace_update_local_phase(workspace=ws, user=creator, head_ref="feat/y")
    assert updated.head_ref == "feat/y"


@pytest.mark.django_db
def test_workspace_update_local_phase_rejects_when_pr_open() -> None:
    creator = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(pr_number=42, created_by=creator))
    with pytest.raises(ApplicationError) as exc:
        workspace_update_local_phase(workspace=ws, user=creator, head_ref="other")
    assert exc.value.status == 409


@pytest.mark.django_db
def test_workspace_update_local_phase_rejects_non_creator() -> None:
    ws = cast(Workspace, WorkspaceFactory())
    other = cast(User, UserFactory())
    with pytest.raises(ApplicationError) as exc:
        workspace_update_local_phase(workspace=ws, user=other, head_ref="feat/y")
    assert exc.value.status == 403


@pytest.mark.django_db
def test_workspace_create_seeds_empty_storyline() -> None:
    from apps.workspaces.models import Storyline
    creator = cast(User, UserFactory())
    ws = workspace_create(
        creator=creator, repo_owner="o", repo_name="r",
        head_ref="feat/x", base_ref="main",
    )
    assert Storyline.objects.filter(workspace=ws).exists()
    assert ws.storyline.files.count() == 0  # pyrefly: ignore[missing-attribute]
