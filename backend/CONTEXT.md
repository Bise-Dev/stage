# Stage

A personal Django + DRF starter template, consumed by **fork-and-rename**: clone the repo, find-and-replace the project name, start hacking. The repo itself is a runnable Django project, not a Jinja/Cookiecutter template.

For architecture and styleguide rationale, see [docs/adr/0001-architecture-and-styleguide-baseline.md](./docs/adr/0001-architecture-and-styleguide-baseline.md).

## Language

### Template

**Starter**:
The repo itself — a literal, runnable Django project that downstream projects clone and rename.
_Avoid_: template, scaffold, boilerplate.

**Fork-and-rename**:
The consumption model. New projects are created by cloning this repo and doing a global find-replace on the project module name. Contrast with cookiecutter/copier templating, which this repo deliberately does not use.

### Apps

**`apps/core/`**:
Cross-cutting infrastructure: `BaseModel`, `ApplicationError`, the DRF exception handler, the `/health/` endpoint. Not a domain app — no domain models of its own beyond `BaseModel`.
_Avoid_: `common`, `shared`, `lib`.

**`apps/users/`**:
The Django auth model app. Houses the project's `User` class, which inherits `AbstractUser` directly (not `BaseModel`). Asymmetric on purpose: `User` keeps Django's `BigAutoField` PK, `date_joined`, `last_login`. No API surface in this template.

**`apps/admin/`**:
Django-admin customization app — `ModelAdmin` classes for other apps' models, Unfold dashboards, custom admin views. App label is `custom_admin` (the bare `admin` label is owned by `django.contrib.admin`). No API surface.
_Avoid_: confusing with `django.contrib.admin` (the framework's admin app).

**`apps/items/`**:
Reference implementation. A deliberately-generic domain (`Item`) that exercises the full pattern stack: `BaseModel` inheritance, `selectors.py`, `services.py`, `apis.py`, extracted serializers, factories, top-level tests. Deletable on fork.

### Patterns

**`BaseModel`**:
Abstract Django model providing UUID `id`, `created_at`, `updated_at`, and a `save()` override that invokes `full_clean()` on every non-bulk save. All domain models inherit it. `User` does not (see above).

**Service**:
A function in `apps/<app>/services.py` that performs a write or state change. Keyword-only arguments, fully type-annotated, named `<entity>_<action>` (e.g., `item_create`, `item_archive`). All business logic lives here.
_Avoid_: putting business logic in views, serializers, signals, model `save()`, or custom managers.

**Selector**:
A function in `apps/<app>/selectors.py` that performs a read. Same naming/signature conventions as services. Returns querysets or computed values; never writes.

**API class**:
A `rest_framework.views.APIView` subclass in `apps/<app>/apis.py`, one class per HTTP operation, named `<Entity><Action>Api` (e.g., `ItemCreateApi`). Delegates to services/selectors; contains no business logic.
_Avoid_: ViewSets, generic views, mixing operations into one class.

**`ApplicationError`**:
The project's top-level domain exception, defined in `apps/core/exceptions.py`. Carries `message`, `extra`, and `status` (default 400). The custom DRF exception handler maps it (and Django/DRF `ValidationError`, `Http404`, `PermissionDenied`) to a uniform response body: `{"message": "...", "extra": {...}}`.

## Example dialogue

> **Dev:** I'm adding a new endpoint that archives an `Item` — where does the logic live?
> **Me:** `apps/items/services.py` gets an `item_archive` function (keyword-only args, typed). `apps/items/apis.py` gets an `ItemArchiveApi` that calls it. Input/output serializers go under `apps/items/serializers/` as separate files. If `item_archive` rejects a non-archivable state, raise `ApplicationError` — the handler turns it into a clean 400.
> **Dev:** Can I add the field validation in the model's `clean()` instead?
> **Me:** `BaseModel.save()` already calls `full_clean()`, so `clean()` is fine for multi-field model-level rules. But anything domain-flavoured ("only the owner can archive") belongs in the service, not the model.
