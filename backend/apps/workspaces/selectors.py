import concurrent.futures
import uuid

import structlog
from django.core.exceptions import ObjectDoesNotExist
from django.db.models import Q, QuerySet

from apps.github_proxy.exceptions import GithubError
from apps.users.models import User
from apps.workspaces.models import IntroComment, StorylineFile, Workspace

logger = structlog.get_logger(__name__)


def intro_comment_thread(
    *,
    storyline_file: StorylineFile,
    include_resolved: bool = False,
) -> list[dict]:
    qs = IntroComment.objects.select_related("user", "resolved_by").filter(
        storyline_file=storyline_file,
        deleted_at__isnull=True,
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
        pr_files = gateway.list_pr_files(
            workspace.repo_owner, workspace.repo_name, workspace.pr_number
        )
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


def workspace_list(*, user: User) -> QuerySet[Workspace]:
    return (
        Workspace.objects.select_related("created_by")
        .filter(Q(created_by=user) | Q(pr_number__isnull=False))
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


# ── Repo overview aggregation (see docs/adr/0009) ─────────────────────────────
#
# Unifies Stage Workspaces (DB) with their GitHub PR state into one tagged-union
# row list, scoped to a single repo, plus the user's Open PRs (no Workspace).
# GitHub data is fanned out in parallel REST calls (no GraphQL yet — ROADMAP).


def _storyline_ready_and_count(workspace: Workspace) -> tuple[bool, int]:
    """(ready_to_publish, step_count) — ready ⇔ ≥1 step and every step has an intro."""
    try:
        storyline = workspace.storyline  # pyrefly: ignore[missing-attribute]
    except ObjectDoesNotExist:
        return False, 0
    files = list(storyline.files.all())
    ready = len(files) >= 1 and all(f.intro_text.strip() for f in files)
    return ready, len(files)


def _review_decision(reviews: list[dict]) -> str:
    """Collapse a PR's reviews into in_review | changes_requested | approved.

    Reviews come back chronologically, so the last decisive state per reviewer
    wins. CHANGES_REQUESTED outstanding dominates; else any APPROVED; else none.
    """
    latest: dict[str, str] = {}
    for rv in reviews:
        st = rv.get("state")
        if st in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            login = (rv.get("user") or {}).get("login") or ""
            latest[login] = st
    states = set(latest.values())
    if "CHANGES_REQUESTED" in states:
        return "changes_requested"
    if "APPROVED" in states:
        return "approved"
    return "in_review"


def _workspace_state(
    *, workspace: Workspace, pr: dict | None, reviews: list[dict] | None, ready: bool
) -> str:
    if workspace.pr_number is None:
        return "ready_to_publish" if ready else "draft"
    if pr is not None and (pr.get("merged") or pr.get("state") == "closed"):
        return "frozen"
    return _review_decision(reviews or [])


def _open_prs_for_repo(*, user: User, repo_owner: str, repo_name: str, gateway) -> list[dict]:
    """User's open PRs in this repo that have no Workspace, tagged author|reviewer."""
    login = getattr(user, "github_login", None)
    if not login:
        return []
    out: list[dict] = []
    seen: set[int] = set()
    for role, query in (
        ("author", f"is:pr is:open author:{login}"),
        ("reviewer", f"is:pr is:open review-requested:{login}"),
    ):
        for item in gateway.search_issues(query).get("items", []):
            parts = item["repository_url"].split("/repos/", 1)[1].split("/")
            if parts[0] != repo_owner or parts[1] != repo_name:
                continue
            number = item["number"]
            if number in seen:
                continue
            seen.add(number)
            out.append(
                {
                    "number": number,
                    "title": item.get("title", ""),
                    "html_url": item.get("html_url", ""),
                    "updated_at": item.get("updated_at"),
                    "user": item.get("user"),
                    "role": role,
                }
            )
    existing = workspaces_existing_for_prs(prs=[(repo_owner, repo_name, p["number"]) for p in out])
    return [p for p in out if (repo_owner, repo_name, p["number"]) not in existing]


def _fetch_pr_details(
    *, gateway, repo_owner: str, repo_name: str, with_reviews: set[int], detail_only: set[int]
) -> dict[int, dict]:
    """Fan out get_pr (+ list_reviews where needed) in parallel. Pure HTTP — no ORM."""
    needs_reviews = {n: (n in with_reviews) for n in (with_reviews | detail_only)}
    if not needs_reviews:
        return {}

    def fetch(number: int, need_reviews: bool) -> tuple[int, dict]:
        entry: dict = {"pr": None, "reviews": None}
        try:
            entry["pr"] = gateway.get_pr(repo_owner, repo_name, number)
        except GithubError:
            logger.warning("overview_pr_fetch_failed", number=number)
        if need_reviews:
            try:
                entry["reviews"] = gateway.list_reviews(repo_owner, repo_name, number)
            except GithubError:
                logger.warning("overview_pr_reviews_failed", number=number)
        return number, entry

    results: dict[int, dict] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        futures = [ex.submit(fetch, n, nr) for n, nr in needs_reviews.items()]
        for fut in concurrent.futures.as_completed(futures):
            number, entry = fut.result()
            results[number] = entry
    return results


def repo_overview(*, user: User, repo_owner: str, repo_name: str, gateway) -> list[dict]:
    """Unified Workspace + Open-PR rows for one repo (see docs/adr/0009)."""
    workspaces = list(
        workspace_list(user=user)
        .filter(repo_owner=repo_owner, repo_name=repo_name)
        .prefetch_related("storyline__files")
    )
    open_prs = _open_prs_for_repo(
        user=user, repo_owner=repo_owner, repo_name=repo_name, gateway=gateway
    )

    details = _fetch_pr_details(
        gateway=gateway,
        repo_owner=repo_owner,
        repo_name=repo_name,
        with_reviews={w.pr_number for w in workspaces if w.pr_number is not None},
        detail_only={p["number"] for p in open_prs},
    )

    rows: list[dict] = []
    for w in workspaces:
        ready, count = _storyline_ready_and_count(w)
        detail = details.get(w.pr_number) if w.pr_number is not None else None
        pr = detail["pr"] if detail else None
        reviews = detail["reviews"] if detail else None
        rows.append(
            {
                "kind": "workspace",
                "id": str(w.id),
                "title": w.title,
                "repo_owner": w.repo_owner,
                "repo_name": w.repo_name,
                "head_ref": w.head_ref,
                "base_ref": w.base_ref,
                "pr_number": w.pr_number,
                "created_by": {
                    "id": w.created_by_id,
                    "github_login": w.created_by.github_login,
                },
                "last_active_at": w.last_active_at,
                "storyline_count": count,
                "state": _workspace_state(workspace=w, pr=pr, reviews=reviews, ready=ready),
                "added": pr.get("additions") if pr else None,
                "removed": pr.get("deletions") if pr else None,
                "comment_count": pr.get("review_comments") if pr else None,
            }
        )

    for p in open_prs:
        detail = details.get(p["number"])
        pr = detail["pr"] if detail else None
        u = p.get("user") or {}
        rows.append(
            {
                "kind": "open_pr",
                "number": p["number"],
                "title": p["title"],
                "html_url": p["html_url"],
                "repo_owner": repo_owner,
                "repo_name": repo_name,
                "head_ref": (pr.get("head") or {}).get("ref") if pr else None,
                "author": {"login": u.get("login"), "avatar_url": u.get("avatar_url")},
                "role": p["role"],
                "updated_at": p.get("updated_at"),
                "added": pr.get("additions") if pr else None,
                "removed": pr.get("deletions") if pr else None,
            }
        )
    return rows
