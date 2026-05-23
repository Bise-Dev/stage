import factory
from factory.django import DjangoModelFactory

from apps.users.factories import UserFactory
from apps.workspaces.models import Workspace


class WorkspaceFactory(DjangoModelFactory):
    class Meta:
        model = Workspace

    repo_owner = factory.Sequence(lambda n: f"owner{n}")
    repo_name = factory.Sequence(lambda n: f"repo{n}")
    head_ref = factory.Sequence(lambda n: f"feat/x{n}")
    base_ref = "main"
    created_by = factory.SubFactory(UserFactory)
