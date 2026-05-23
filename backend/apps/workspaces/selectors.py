import uuid

from django.db.models import QuerySet

from apps.workspaces.models import Workspace


def workspace_is_frozen(*, workspace: Workspace, gateway) -> bool:
    if workspace.pr_number is None:
        return False
    pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
    return pr.get("state") == "closed"


def storyline_read(*, workspace: Workspace, gateway) -> tuple[dict, str]:
    s = workspace.storyline  # pyrefly: ignore[missing-attribute]
    files = list(s.files.all())

    head_sha = None
    stale_paths: set[str] = set()
    if workspace.pr_number:
        pr_files = gateway.list_pr_files(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
        valid = {f["filename"] for f in pr_files}
        for f in files:
            if f.diff_file_path not in valid:
                stale_paths.add(f.diff_file_path)
        pr = gateway.get_pr(workspace.repo_owner, workspace.repo_name, workspace.pr_number)
        head_sha = (pr.get("head") or {}).get("sha")

    payload = {
        "etag": s.etag,
        "head_sha": head_sha,
        "files": [
            {
                "id": f.pk,
                "diff_file_path": f.diff_file_path,
                "order_index": f.order_index,
                "title": f.title,
                "intro_text": f.intro_text,
                "stale": f.diff_file_path in stale_paths,
                "stale_reason": "file_removed" if f.diff_file_path in stale_paths else None,
            }
            for f in files
        ],
    }
    return payload, s.etag


def workspace_list() -> QuerySet[Workspace]:
    return (
        Workspace.objects.select_related("created_by")
        .all()
        .order_by("-last_active_at")
    )


def workspace_get(*, workspace_id: uuid.UUID) -> Workspace:
    return Workspace.objects.select_related("created_by").get(pk=workspace_id)


def workspace_lookup(*, repo_owner: str, repo_name: str, pr_number: int) -> Workspace | None:
    return (
        Workspace.objects.select_related("created_by")
        .filter(repo_owner=repo_owner, repo_name=repo_name, pr_number=pr_number)
        .first()
    )
