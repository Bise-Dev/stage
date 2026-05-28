from typing import cast

import pytest
from django.core.exceptions import ValidationError

from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Storyline, StorylineFile, Workspace

# BaseModel.save() runs full_clean() before hitting the DB (see CLAUDE.md
# "Backend > Where logic lives"), so unique-constraint violations surface as
# ValidationError — never the raw IntegrityError.


@pytest.mark.django_db
def test_storyline_is_one_to_one_with_workspace() -> None:
    ws = cast(Workspace, WorkspaceFactory())
    # storyline already created by workspace_create; using factory directly skips that path
    # so we create one here explicitly:
    user = cast(User, UserFactory())
    Storyline.objects.create(workspace=ws, etag="e", updated_by=user)
    with pytest.raises(ValidationError) as exc:
        Storyline.objects.create(workspace=ws, etag="e2", updated_by=user)
    assert "workspace" in str(exc.value).lower()


@pytest.mark.django_db
def test_storyline_file_unique_path_per_storyline() -> None:
    ws = cast(Workspace, WorkspaceFactory())
    user = cast(User, UserFactory())
    s = Storyline.objects.create(workspace=ws, etag="e", updated_by=user)
    StorylineFile.objects.create(storyline=s, diff_file_path="a.py", order_index=0)
    with pytest.raises(ValidationError) as exc:
        StorylineFile.objects.create(storyline=s, diff_file_path="a.py", order_index=1)
    msg = str(exc.value)
    assert "already exists" in msg and "Diff file path" in msg
