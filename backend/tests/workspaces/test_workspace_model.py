import uuid
from typing import cast

import pytest
from django.core.exceptions import ValidationError

from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Workspace

# BaseModel.save() runs full_clean() before hitting the DB (see CLAUDE.md
# "Backend > Where logic lives"), so unique-constraint violations surface as
# ValidationError from validate_constraints() — never the raw IntegrityError.


@pytest.mark.django_db
def test_workspace_has_uuid_id_from_base_model() -> None:
    ws = cast(Workspace, WorkspaceFactory())
    assert isinstance(ws.id, uuid.UUID)
    assert ws.pr_number is None


@pytest.mark.django_db
def test_workspace_unique_per_repo_head_ref() -> None:
    # Plain unique_together → validate_unique() emits Django's human message
    # ("…already exists.") without the constraint name. The conditional
    # (pr_number) constraint below goes through validate_constraints() which
    # does include the name — see that test for the difference.
    creator = cast(User, UserFactory())
    WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="feat/x", created_by=creator)
    with pytest.raises(ValidationError) as exc:
        WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="feat/x", created_by=creator)
    msg = str(exc.value)
    assert "already exists" in msg and "Head ref" in msg


@pytest.mark.django_db
def test_workspace_unique_per_repo_pr_when_pr_set() -> None:
    creator = cast(User, UserFactory())
    WorkspaceFactory(repo_owner="o", repo_name="r", head_ref="a", pr_number=42, created_by=creator)
    with pytest.raises(ValidationError) as exc:
        WorkspaceFactory(
            repo_owner="o", repo_name="r", head_ref="b", pr_number=42, created_by=creator
        )
    assert "uniq_workspace_repo_pr" in str(exc.value)
