import uuid

from django.db.models import QuerySet

from apps.workspaces.models import IntroComment, StorylineFile, Workspace


def intro_comment_thread(
    *, storyline_file: StorylineFile, include_resolved: bool = False,
) -> list[dict]:
    qs = IntroComment.objects.select_related("user", "resolved_by").filter(
        storyline_file=storyline_file, deleted_at__isnull=True,
    )
    if not include_resolved:
        qs = qs.filter(resolved_at__isnull=True)
    qs = qs.order_by("created_at")
    by_id: dict = {}
    roots: list[dict] = []
    for c in qs:
        item = {
            "id": c.pk,
            "user": {"id": c.user_id, "github_login": c.user.github_login},
            "body": c.body,
            "parent_id": c.parent_id,
            "created_at": c.created_at,
            "resolved_at": c.resolved_at,
            "resolved_by": (
                {"id": c.resolved_by_id, "github_login": c.resolved_by.github_login}  # pyrefly: ignore[missing-attribute]
                if c.resolved_by_id
                else None
            ),
            "replies": [],
        }
        by_id[c.pk] = item
        if c.parent_id is None:
            roots.append(item)
        else:
            parent = by_id.get(c.parent_id)
            if parent:
                parent["replies"].append(item)
    return roots


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


def workspaces_existing_for_prs(*, prs: list[tuple[str, str, int]]) -> set[tuple[str, str, int]]:
    if not prs:
        return set()
    from django.db.models import Q
    q = Q()
    for owner, name, n in prs:
        q |= Q(repo_owner=owner, repo_name=name, pr_number=n)
    existing = Workspace.objects.filter(q).values_list("repo_owner", "repo_name", "pr_number")
    return {(row[0], row[1], row[2]) for row in existing}


def workspace_lookup(*, repo_owner: str, repo_name: str, pr_number: int) -> Workspace | None:
    return (
        Workspace.objects.select_related("created_by")
        .filter(repo_owner=repo_owner, repo_name=repo_name, pr_number=pr_number)
        .first()
    )
