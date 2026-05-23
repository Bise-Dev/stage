from typing import cast
from unittest.mock import MagicMock

import pytest

from apps.core.exceptions import ApplicationError
from apps.github_proxy.exceptions import GithubError
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Workspace
from apps.workspaces.services import pull_request_open, pull_request_reopen


def _make_gateway(pr_state: str = "open", pr_number: int = 99) -> MagicMock:
    gw = MagicMock()
    gw.get_pr.return_value = {"number": pr_number, "state": pr_state}
    gw.create_pull.return_value = {"number": pr_number, "state": "open", "html_url": "https://github.com/o/r/pull/99"}
    gw.patch_pr.return_value = {"number": pr_number, "state": "open"}
    gw.list_open_pulls.return_value = []
    return gw


@pytest.mark.django_db
def test_pull_request_open_happy_path() -> None:
    creator = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(created_by=creator, pr_number=None))
    gw = _make_gateway()

    result = pull_request_open(
        workspace=ws, creator=creator, title="My PR", body="desc",
        reviewers=[], labels=[], draft=False, gateway=gw,
    )

    gw.create_pull.assert_called_once_with(
        ws.repo_owner, ws.repo_name,
        title="My PR", body="desc", base=ws.base_ref, head=ws.head_ref, draft=False,
    )
    ws.refresh_from_db()
    assert ws.pr_number == 99
    assert ws.pr_opened_at is not None
    assert result["warnings"] == []
    assert result["pr"]["number"] == 99


@pytest.mark.django_db
def test_pull_request_open_creator_only() -> None:
    other = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory())
    gw = _make_gateway()

    with pytest.raises(ApplicationError) as exc:
        pull_request_open(
            workspace=ws, creator=other, title="t", body="", reviewers=[], labels=[], draft=False, gateway=gw,
        )
    assert exc.value.status == 403


@pytest.mark.django_db
def test_pull_request_open_pr_already_open() -> None:
    creator = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(created_by=creator, pr_number=42))
    gw = _make_gateway(pr_state="open", pr_number=42)
    gw.get_pr.return_value = {"number": 42, "state": "open"}

    with pytest.raises(ApplicationError) as exc:
        pull_request_open(
            workspace=ws, creator=creator, title="t", body="", reviewers=[], labels=[], draft=False, gateway=gw,
        )
    assert exc.value.status == 409
    assert "pr_already_open" in exc.value.message


@pytest.mark.django_db
def test_pull_request_open_reviewer_fails_warning_recorded() -> None:
    creator = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(created_by=creator, pr_number=None))
    gw = _make_gateway()
    gw.request_reviewers.side_effect = GithubError(422, "review request failed")

    result = pull_request_open(
        workspace=ws, creator=creator, title="t", body="", reviewers=["alice"], labels=[], draft=False, gateway=gw,
    )

    ws.refresh_from_db()
    assert ws.pr_number == 99
    assert len(result["warnings"]) == 1
    assert "reviewers_failed" in result["warnings"][0]


@pytest.mark.django_db
def test_pull_request_reopen_happy_path() -> None:
    creator = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(created_by=creator, pr_number=55))
    gw = _make_gateway(pr_number=55)

    pr = pull_request_reopen(workspace=ws, creator=creator, gateway=gw)

    gw.patch_pr.assert_called_once_with(ws.repo_owner, ws.repo_name, 55, state="open")
    assert pr["number"] == 55


@pytest.mark.django_db
def test_pull_request_reopen_creator_only() -> None:
    other = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(pr_number=55))
    gw = _make_gateway()

    with pytest.raises(ApplicationError) as exc:
        pull_request_reopen(workspace=ws, creator=other, gateway=gw)
    assert exc.value.status == 403


@pytest.mark.django_db
def test_pull_request_reopen_no_pr() -> None:
    creator = cast(User, UserFactory())
    ws = cast(Workspace, WorkspaceFactory(created_by=creator, pr_number=None))
    gw = _make_gateway()

    with pytest.raises(ApplicationError) as exc:
        pull_request_reopen(workspace=ws, creator=creator, gateway=gw)
    assert exc.value.status == 409
    assert "no_pr_to_reopen" in exc.value.message
