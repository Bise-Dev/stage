from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from rest_framework.test import APIClient

from apps.identity.factories import GitHubIdentityFactory
from apps.identity.services import session_issue
from apps.users.factories import UserFactory
from apps.users.models import User
from apps.workspaces.factories import WorkspaceFactory
from apps.workspaces.models import Storyline, StorylineFile, Workspace

_PR_OPEN = {
    "additions": 10,
    "deletions": 2,
    "review_comments": 3,
    "state": "open",
    "merged": False,
    "head": {"ref": "feat/x"},
}


@pytest.fixture
def authed_client(db) -> tuple[APIClient, User]:
    user = cast(User, UserFactory(github_login="ghuser"))
    GitHubIdentityFactory(user=user)
    raw, _ = session_issue(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client, user


def _gw(
    *,
    owner: str,
    repo: str,
    search_items=None,
    pr=None,
    reviews=None,
    installed: bool = True,
    repo_selected: bool = True,
    installations_error: Exception | None = None,
) -> MagicMock:
    gw = MagicMock()
    gw.__enter__ = lambda s: s
    gw.__exit__ = MagicMock(return_value=False)
    # Repo-access gate (ADR-0017): by default the app is installed on `owner`
    # and `owner/repo` is selected, so the gate passes and the overview loads.
    if installations_error is not None:
        gw.list_user_installations.side_effect = installations_error
    else:
        gw.list_user_installations.return_value = (
            [{"account": {"login": owner}, "id": 1}] if installed else []
        )
    gw.list_installation_repos.return_value = (
        [{"full_name": f"{owner}/{repo}"}] if repo_selected else []
    )
    gw.search_issues.return_value = {"items": search_items or []}
    gw.get_pr.return_value = pr if pr is not None else dict(_PR_OPEN)
    gw.list_reviews.return_value = reviews or []
    return gw


def _overview(client, ws) -> list[dict]:
    resp = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
    assert resp.status_code == 200, resp.content
    return resp.json()


@pytest.mark.django_db
def test_pre_publish_workspace_is_draft(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    with patch(
        "apps.workspaces.apis.make_user_gateway",
        return_value=_gw(owner=ws.repo_owner, repo=ws.repo_name),
    ):
        rows = _overview(client, ws)
    assert len(rows) == 1
    row = rows[0]
    assert row["kind"] == "workspace"
    assert row["state"] == "draft"
    assert row["title"] == ws.title
    assert row["added"] is None and row["removed"] is None


@pytest.mark.django_db
def test_pre_publish_ready_to_publish_when_storyline_complete(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    s = Storyline.objects.create(workspace=ws, etag="e", updated_by=user)
    StorylineFile.objects.create(
        storyline=s, diff_file_path="a.py", order_index=0, intro_text="why this file"
    )
    with patch(
        "apps.workspaces.apis.make_user_gateway",
        return_value=_gw(owner=ws.repo_owner, repo=ws.repo_name),
    ):
        rows = _overview(client, ws)
    assert rows[0]["state"] == "ready_to_publish"
    assert rows[0]["storyline_count"] == 1


@pytest.mark.django_db
def test_published_workspace_enriched_from_github(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=482))
    gw = _gw(
        owner=ws.repo_owner,
        repo=ws.repo_name,
        reviews=[{"user": {"login": "rev"}, "state": "APPROVED"}],
    )
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        rows = _overview(client, ws)
    row = rows[0]
    assert row["state"] == "approved"
    assert row["added"] == 10 and row["removed"] == 2
    assert row["comment_count"] == 3


@pytest.mark.django_db
def test_published_changes_requested(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=479))
    gw = _gw(
        owner=ws.repo_owner,
        repo=ws.repo_name,
        reviews=[
            {"user": {"login": "a"}, "state": "APPROVED"},
            {"user": {"login": "b"}, "state": "CHANGES_REQUESTED"},
        ],
    )
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        rows = _overview(client, ws)
    assert rows[0]["state"] == "changes_requested"


@pytest.mark.django_db
def test_published_archived_when_pr_closed(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=478))
    gw = _gw(owner=ws.repo_owner, repo=ws.repo_name, pr={**_PR_OPEN, "state": "closed"})
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        rows = _overview(client, ws)
    assert rows[0]["state"] == "archived"


@pytest.mark.django_db
def test_open_pr_included_and_repo_scoped(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    # One open PR in this repo (no workspace) + one in a different repo (filtered out).
    search_items = [
        {
            "number": 99,
            "repository_url": f"https://api.github.com/repos/{ws.repo_owner}/{ws.repo_name}",
            "title": "Open PR here",
            "html_url": "https://github.com/x/pull/99",
            "updated_at": "2026-05-26T12:00:00Z",
            "user": {"login": "ghuser", "avatar_url": "https://a/x.png"},
        },
        {
            "number": 7,
            "repository_url": "https://api.github.com/repos/other/repo",
            "title": "Elsewhere",
            "html_url": "https://github.com/other/repo/pull/7",
            "updated_at": "2026-05-26T12:00:00Z",
            "user": {"login": "ghuser", "avatar_url": None},
        },
    ]
    gw = _gw(owner=ws.repo_owner, repo=ws.repo_name, search_items=search_items)
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        rows = _overview(client, ws)
    kinds = [r["kind"] for r in rows]
    assert kinds.count("workspace") == 1
    open_rows = [r for r in rows if r["kind"] == "open_pr"]
    assert len(open_rows) == 1
    assert open_rows[0]["number"] == 99
    assert open_rows[0]["head_ref"] == "feat/x"


@pytest.mark.django_db
def test_workspace_in_other_repo_excluded(authed_client) -> None:
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    WorkspaceFactory(created_by=user, pr_number=None)  # different repo (factory sequence)
    with patch(
        "apps.workspaces.apis.make_user_gateway",
        return_value=_gw(owner=ws.repo_owner, repo=ws.repo_name),
    ):
        rows = _overview(client, ws)
    assert len(rows) == 1
    assert rows[0]["repo_name"] == ws.repo_name


# ── Error path: fail loud, never silent (see CLAUDE.md "Error handling") ─────


@pytest.mark.django_db
def test_published_pr_detail_failure_returns_502(authed_client) -> None:
    """Published workspace + PR detail fetch fails → hard 502, message names
    the offending PR. A merged PR otherwise risks showing as "in review"."""
    import httpx

    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=482))
    gw = _gw(owner=ws.repo_owner, repo=ws.repo_name)
    gw.get_pr.side_effect = httpx.ReadTimeout("upstream timed out")
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        resp = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
    assert resp.status_code == 502, resp.content
    body = resp.json()
    assert "#482" in body["message"]
    assert body["extra"]["pr_number"] == 482


@pytest.mark.django_db
def test_published_reviews_failure_returns_502(authed_client) -> None:
    """Open PR whose reviews list fails → 502, since approved/changes-requested
    can't be told apart from "no decision yet"."""
    import httpx

    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=479))
    gw = _gw(
        owner=ws.repo_owner, repo=ws.repo_name
    )  # get_pr returns open PR; list_reviews errors out.
    gw.list_reviews.side_effect = httpx.ReadTimeout("upstream timed out")
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        resp = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
    assert resp.status_code == 502, resp.content
    body = resp.json()
    assert "#479" in body["message"]
    assert "review" in body["message"].lower()


@pytest.mark.django_db
def test_open_pr_detail_failure_returns_502(authed_client) -> None:
    """Open-PR enrichment is held to the same bar: if get_pr fails for an
    open PR row, fail the whole request — no half-rendered rows."""
    import httpx

    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    search_items = [
        {
            "number": 99,
            "repository_url": f"https://api.github.com/repos/{ws.repo_owner}/{ws.repo_name}",
            "title": "Open PR here",
            "html_url": "https://github.com/x/pull/99",
            "updated_at": "2026-05-26T12:00:00Z",
            "user": {"login": "ghuser", "avatar_url": None},
        },
    ]
    gw = _gw(owner=ws.repo_owner, repo=ws.repo_name, search_items=search_items)
    gw.get_pr.side_effect = httpx.ReadTimeout("upstream timed out")
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        resp = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
    assert resp.status_code == 502, resp.content
    body = resp.json()
    assert "#99" in body["message"]


@pytest.mark.django_db
def test_search_failure_returns_502(authed_client) -> None:
    """search_issues transport error → 502 with the failing role in extra."""
    import httpx

    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    gw = _gw(owner=ws.repo_owner, repo=ws.repo_name)
    gw.search_issues.side_effect = httpx.ConnectError("network down")
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        resp = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
    assert resp.status_code == 502, resp.content
    body = resp.json()
    # First failing role wins — `author` is queried before `reviewer`.
    assert body["extra"]["role"] == "author"
    assert "PR" in body["message"]


# ── Repo-access gate (ADR-0017): affirmative install check before fan-out ────


@pytest.mark.django_db
def test_gate_not_installed_returns_403(authed_client) -> None:
    """No installation matches the repo owner → 403 reason=not_installed,
    raised before any search/PR fan-out (so search_issues is never called)."""
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    gw = _gw(owner=ws.repo_owner, repo=ws.repo_name, installed=False)
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        resp = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
    assert resp.status_code == 403, resp.content
    body = resp.json()
    assert body["extra"]["code"] == "github_app_no_access"
    assert body["extra"]["reason"] == "not_installed"
    assert body["extra"]["owner"] == ws.repo_owner
    assert body["extra"]["repo"] == ws.repo_name
    # Gate fails fast — the GitHub fan-out never runs.
    gw.search_issues.assert_not_called()
    # Placeholder app slug (test settings) → no install_url surfaced.
    assert "install_url" not in body["extra"]


@pytest.mark.django_db
def test_gate_owner_match_is_case_insensitive(authed_client) -> None:
    """An installation whose account login differs only in case still matches
    the repo owner — the overview loads normally."""
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    gw = _gw(owner=ws.repo_owner, repo=ws.repo_name)
    gw.list_user_installations.return_value = [
        {"account": {"login": ws.repo_owner.upper()}, "id": 1}
    ]
    gw.list_installation_repos.return_value = [
        {"full_name": f"{ws.repo_owner.upper()}/{ws.repo_name.upper()}"}
    ]
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        # Gate passes despite the case difference → 200 with the draft workspace.
        rows = _overview(client, ws)
    assert len(rows) == 1
    assert rows[0]["kind"] == "workspace"


@pytest.mark.django_db
def test_gate_repo_not_selected_returns_403(authed_client) -> None:
    """App installed on the owner but the repo isn't selected → 403
    reason=repo_not_selected; the fan-out is still skipped."""
    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    gw = _gw(owner=ws.repo_owner, repo=ws.repo_name, repo_selected=False)
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        resp = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
    assert resp.status_code == 403, resp.content
    body = resp.json()
    assert body["extra"]["code"] == "github_app_no_access"
    assert body["extra"]["reason"] == "repo_not_selected"
    gw.search_issues.assert_not_called()


@pytest.mark.django_db
def test_gate_includes_install_url_when_slug_configured(authed_client) -> None:
    """When GITHUB_APP_SLUG is a real slug (not the placeholder), the 403 carries
    a buildable install_url for the client's CTA."""
    from apps.workspaces import selectors

    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    gw = _gw(owner=ws.repo_owner, repo=ws.repo_name, installed=False)
    with (
        patch.object(selectors.env, "GITHUB_APP_SLUG", "stage-app"),
        patch("apps.workspaces.apis.make_user_gateway", return_value=gw),
    ):
        resp = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
    assert resp.status_code == 403, resp.content
    body = resp.json()
    assert body["extra"]["install_url"] == "https://github.com/apps/stage-app/installations/new"


@pytest.mark.django_db
def test_gate_installations_call_failure_returns_502(authed_client) -> None:
    """A transport/5xx on the installations call is a distinct 502 (couldn't
    check), not a 403 (definitely no access)."""
    import httpx

    client, user = authed_client
    ws = cast(Workspace, WorkspaceFactory(created_by=user, pr_number=None))
    gw = _gw(
        owner=ws.repo_owner,
        repo=ws.repo_name,
        installations_error=httpx.ConnectError("network down"),
    )
    with patch("apps.workspaces.apis.make_user_gateway", return_value=gw):
        resp = client.get(f"/api/v1/repos/{ws.repo_owner}/{ws.repo_name}/overview/")
    assert resp.status_code == 502, resp.content
    body = resp.json()
    assert body["extra"]["code"] == "github_installations_unavailable"
