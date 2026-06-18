# Backend architecture and styleguide baseline

**Status:** superseded by [ADR-0022](0022-local-stage-folder-replaces-backend.md)

## Context

Django has no opinionated layout for applications larger than the tutorial. The defaults distribute business logic across views, serializers, model `save()` overrides, signals, and managers. As a project grows, this distribution becomes the source of the most expensive bugs: logic in `save()` fires from places nobody expected, signals create implicit graphs, fat views block reuse, and `ModelSerializer`s couple HTTP shape to storage shape.

A widely-adopted correction is to introduce an explicit **service layer** (writes) and **selector layer** (reads) per app, and to keep everything else — views, serializers, models — thin and free of business logic. The well-known reference for this pattern is the [HackSoft Django Styleguide](https://github.com/HackSoftware/Django-Styleguide), which the structural choices below borrow from heavily.

The Stage backend was originally bootstrapped from [`brunovollmer/Django-Starter`](https://github.com/brunovollmer/Django-Starter) and inherits its conventions wholesale; this ADR documents the baseline as it applies to Stage.

## Decision

The backend adopts an opinionated structural baseline. It largely follows the styleguide linked above, with a small set of deliberate deviations. The styleguide answers ~90% of the questions a Django project faces; we accept those answers wholesale and document only where we diverge.

### What we take from the styleguide, unmodified

- **Services and selectors** as the only locations for business logic. Functions in `apps/<app>/services.py` and `apps/<app>/selectors.py`, keyword-only arguments, fully type-annotated, named `<entity>_<action>`.
- **APIs over views.** `apps/<app>/apis.py` holds one `APIView` subclass per HTTP operation (`ItemCreateApi`, `ItemListApi`, ...), each delegating to services/selectors and containing no business logic. No `ViewSet`s, no generic views.
- **A project-level `BaseModel`** at `apps/core/models.py` with `id`, `created_at`, `updated_at`. All domain models inherit from it.
- **A uniform error contract.** A custom `ApplicationError(message, extra, status)` and a DRF exception handler that maps it (and Django/DRF `ValidationError`, `Http404`, `PermissionDenied`) to a consistent `{"message": ..., "extra": ...}` response body.
- **No business logic in `save()`, signals, custom managers, serializers, or views.** This is the rule the styleguide repeats most often and it carries.
- **Plural module names** (`services.py`, `selectors.py`, `apis.py`, `tasks.py`) — matching the Django convention of plural-for-collections.
- **A `core` (infra) app** for cross-cutting concerns: `BaseModel`, `ApplicationError`, exception handler, base permissions.

### Where we deviate

1. **`BaseModel.save()` calls `full_clean()`.** The styleguide says "no logic in `save()`," and we agree in spirit — but we treat `full_clean()` as a validation safety net, not domain logic. Services are still expected to call `full_clean()` explicitly when relevant; this is a backstop, not a contract. Cost: every non-bulk save runs validation twice in the common path. We accept that for the protection against the "service forgot to validate" class of bug.

2. **`User` does not inherit `BaseModel`.** Domain models all inherit `BaseModel`; `User` inherits `AbstractUser` directly and keeps Django's `BigAutoField` PK, `date_joined`, and `last_login`. Reversing this would mean rewriting `User` from `AbstractBaseUser` upward (manager, password reset flow, admin form path) — a worse default for a Django project.

3. **Serializers extracted to `apps/<app>/serializers/`, one class per file.** The styleguide says serializers should be nested inside the API class to discourage reuse-driven coupling. In practice, the inline rule produces real duplication when the same output shape is used across list/detail/create-response endpoints, and the resulting copy-paste drift is its own bug class. We extract by default, accept the reuse-coupling risk, and rely on code review to catch shared-serializer changes that affect multiple endpoints.

4. **Tests live at top-level `backend/tests/`, mirroring the app tree.** The styleguide puts tests beside the code at `apps/<app>/tests/`. We move them to a top-level `tests/` directory (with a global `conftest.py` and per-app subdirectories) because cross-app fixtures and integration tests benefit from a single root. The factory module stays under each app (`apps/<app>/factories.py`) so non-test code (management commands, dev-data seeders) can import factories without reaching into a `tests/` package.

5. **`apps/admin/` is a real app, not a namespace.** It contains no DRF endpoints — only `ModelAdmin` registrations, Unfold dashboards, custom admin views. It uses the directory name `admin/` with the explicit app `label = "custom_admin"` to avoid colliding with `django.contrib.admin`'s label.

6. **Settings layout: `config/settings/` + integration files at `config/` root.** Per-environment Django settings (`base.py`, `local.py`, `production.py`, `test.py`) live in `config/settings/`. Integration configuration (drf-spectacular, unfold, logging, future Celery/Sentry) lives in separate modules at `config/` root and is imported into `base.py`. The pydantic `Env` schema lives at `config/settings/env_schemas.py`.

## Consequences

- Anyone working in the backend inherits an opinionated structure on day one. The cost is the first hour of learning the conventions; the payoff is that the project's tenth API endpoint looks identical to its first.
- The deviations are localized. A team familiar with the underlying styleguide can read this codebase and identify each deviation quickly; nothing is hidden in the small print.
- The `full_clean()`-in-`save()` choice carries a measurable performance cost on write-heavy paths. Projects that hit that ceiling can override `save()` on specific hot models or use `update_fields=` / `bulk_update` to bypass it.
- The extracted-serializer choice means new reviewers must be vigilant about shared-serializer changes. A future ADR may revisit this if the reuse-coupling bugs the styleguide warns about start materialising.
