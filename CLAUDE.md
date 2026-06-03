# Claude conventions

Project-specific guidance for code generation in this monorepo. For domain language and architectural decisions, see [CONTEXT.md](./CONTEXT.md) and [docs/adr/](./docs/adr/).

**Implementation plans are local working notes** — keep them under `docs/plans/` (gitignored), not committed. They're scratch for the task at hand; durable decisions belong in an ADR (`docs/adr/`) or `CONTEXT.md`, never a committed plan file.

## After every change

Run the verify pipeline before declaring any task done:

```sh
just pre-commit       # ruff + format + pyrefly + biome + cargo fmt + tsc + cargo check
```

On bigger changes also run the full pipeline:

```sh
just verify           # pre-commit + clippy + cargo test + pytest
```

A change isn't complete until at least the relevant linters and typecheckers pass. If pre-commit modifies files (auto-fix), stage them and re-run. If pyrefly/tsc/clippy report errors, fix them — don't suppress unless you have a specific reason and document it inline.

## Error handling

**Fail loud. No silent fallbacks. No partial-success payloads.** When something goes wrong, two things must happen — both, every time:

1. **Log it** with the full traceback and structured context. In Python: `logger.exception("event_name", **kwargs)` (never bare `except: pass`, never `logger.warning` for an actual failure). In Rust: `tracing::error!(err = %e, …)`. In the webview: `console.warn(...)` is fine for visibility, but it does **not** count as user-facing.
2. **Surface it to the user** with a clear message. In the backend: `raise ApplicationError("Couldn't <do thing> — <why>.", extra={...}, status=...)` (see [backend Errors](#errors)) — the custom handler turns it into `{"message": ..., "extra": ...}`. In the client: catch the SDK rejection and render the API's message in a red banner; don't shorten or rewrite it.

**Explicitly banned:**

- Default-on-error (`return None`, `return []`, `return "unknown"`) that hides the failure.
- Best-effort warnings collected alongside data (`{"rows": [...], "warnings": [...]}`) — if one piece failed, the whole response fails. The user should never have to wonder whether a row is real or a fallback.
- Catching an exception only to log and continue. Logging is half the job; the other half is the raise.
- Wrapping a raise in a generic message that drops the cause. Pass the real cause through `extra={"cause": str(exc)}` and chain with `raise … from exc`.

**Why:** in a tool that brokers credentials and renders state copied from GitHub, "partial" data is a bug-magnet — the user trusts what they see. A loud failure is recoverable; a quietly wrong row isn't. See `backend/apps/workspaces/selectors.py::repo_overview` for the canonical shape: every GitHub call site logs + raises `ApplicationError(status=502)` on any exception.

The one exception (rare and must be documented inline): work that is genuinely fire-and-forget and cannot affect anything the user sees — e.g. emitting a metric, warming a cache after the response has been sent. Even then: `logger.exception(...)`; the silent part is the user-facing side, not the log.

## Backend (`backend/`)

The Django app follows an opinionated structural baseline derived from the [HackSoft Django Styleguide](https://github.com/HackSoftware/Django-Styleguide), with documented deviations. The full rationale is in [docs/adr/0005-backend-architecture-and-styleguide-baseline.md](./docs/adr/0005-backend-architecture-and-styleguide-baseline.md). All paths in this section are relative to `backend/`.

### Where logic lives

| Concern | Location | Notes |
|---|---|---|
| Domain reads | `apps/<app>/selectors.py` | Functions named `<entity>_<action>`, kw-only args, fully typed. Return querysets or computed values. Never write. |
| Domain writes / state changes | `apps/<app>/services.py` | Same conventions as selectors. All business logic lives here. Wrap with `@transaction.atomic` when multi-step. |
| HTTP endpoints | `apps/<app>/apis.py` | One `APIView` subclass per operation, named `<Entity><Action>Api`. Thin: validate input, call service/selector, serialize output. No business logic. |
| Input/output shapes | `apps/<app>/serializers/<name>.py` | One serializer per file, extracted (not nested inside the API class). |
| Model definitions | `apps/<app>/models.py` | Inherit `apps.core.models.BaseModel` (UUID + timestamps + `full_clean()` in `save()`). `User` is the documented exception — it inherits `AbstractUser` directly. |
| URLs | `apps/<app>/urls.py` | Per-app, included from `config/urls.py`. Each app sets `app_name = "<app>"`. |
| Test data | `apps/<app>/factories.py` | factory-boy `DjangoModelFactory` subclasses. Lives at the app root (not under `tests/`) so non-test code can import. |
| Tests | `tests/<app>/test_*.py` | Top-level `tests/` tree mirrors `apps/`. Global `conftest.py` at `tests/conftest.py`. |

### What does NOT belong in business logic locations

Per the styleguide, these are off-limits for domain logic:

- Model `save()` overrides (except `BaseModel.save()`'s `full_clean()` backstop)
- Django signals
- Custom model managers / querysets
- Serializer `validate_*` / `create()` / `update()` methods
- Views/APIs beyond input validation and orchestration

If logic appears in any of those, move it to a service or selector.

### Errors

Raise `apps.core.exceptions.ApplicationError(message, extra={}, status=400)` from services/selectors when domain rules are violated. The custom exception handler at `apps.core.exception_handlers.application_exception_handler` turns it into a uniform `{"message": ..., "extra": ...}` response.

```python
from apps.core.exceptions import ApplicationError

if item.status == ItemStatus.ARCHIVED:
    raise ApplicationError(
        "This item is already archived.",
        extra={"code": "item_archived", "item_id": str(item.id)},
    )
```

**`message` is human, `extra["code"]` is the machine handle.** `message` is a complete, user-facing sentence the client renders verbatim in its error banner (see the [Error handling](#error-handling) fail-loud rule). The stable programmatic identifier goes in `extra["code"]` (snake_case) — that's what client logic branches on, never the message text. Do **not** put a bare code token in `message` (e.g. `ApplicationError("workspace_frozen", ...)`): the user would see `workspace_frozen` in the banner.

Some pre-existing call sites still use the old code-as-message shape; migrate them to this convention whenever you touch them.

### Settings

- `config/settings/{base,local,production,test}.py` — per-environment Django settings; `local`/`production`/`test` all import `*` from `base`.
- `config/settings/env_schemas.py` — the pydantic `Env` class. All environment variables flow through this; never read `os.environ` directly in app code.
- `config/{spectacular,unfold,logging}.py` — integration-specific config blocks; imported into `base.py` so they become Django settings.

### File naming

Plural everywhere: `services.py`, `selectors.py`, `apis.py`, `tasks.py`, `factories.py`. Matches Django's own convention (`models.py`, `views.py`, `urls.py`).

### Logging

This project uses [`structlog`](https://www.structlog.org/) bridged to the stdlib `logging` framework. All loggers — Django's, third-party libs', ours — flow through the same processor pipeline configured in [backend/config/logging.py](./backend/config/logging.py).

#### Getting a logger

Always use `structlog.get_logger(__name__)`. Never use `logging.getLogger(...)` in app code.

```python
import structlog

logger = structlog.get_logger(__name__)
```

#### Emitting events

Log **events with key/value context**, never f-strings. The event name is a short, lowercase, snake_case verb phrase. Context goes in keyword arguments.

```python
# Good
logger.info("item_archived", item_id=str(item.id), owner_id=item.owner_id)

# Bad — opaque to log search, unstructured
logger.info(f"Archived item {item.id} for user {item.owner_id}")
```

#### Levels

- `debug` — verbose, off in prod.
- `info` — normal business events (`item_archived`, `user_created`).
- `warning` — recoverable anomalies (`stale_cache_hit`, `retry_scheduled`).
- `error` — failures the caller should be aware of, including handled exceptions where the context matters.
- `exception` — inside an `except:` block; auto-attaches the traceback.

```python
try:
    item_archive(item=item)
except ApplicationError:
    logger.exception("item_archive_failed", item_id=str(item.id))
    raise
```

#### Binding context

Use `structlog.contextvars.bind_contextvars` to attach context that should be carried through nested calls (request id, user id, task id). The configured `merge_contextvars` processor will include them in every subsequent log line on the same async context.

```python
from structlog.contextvars import bind_contextvars, clear_contextvars

bind_contextvars(request_id=request_id, user_id=user.pk)
try:
    ...
finally:
    clear_contextvars()
```

For local, function-scoped context, use `logger.bind(...)` to get a child logger with the keys baked in:

```python
log = logger.bind(item_id=str(item.id))
log.info("validation_started")
log.info("validation_passed")
```

#### Where logs go

- Dev (`DJANGO_DEBUG=True`): colorized console output via `structlog.dev.ConsoleRenderer`.
- Prod (`DJANGO_DEBUG=False`): one JSON object per line via `structlog.processors.JSONRenderer`, suitable for shipping to log aggregators.

The switch happens automatically in `backend/config/logging.py` based on `DJANGO_DEBUG`.

#### What not to do

- Don't log secrets, tokens, passwords, or full PII payloads. The processor pipeline does not redact.
- Don't construct messages with `%`-formatting or f-strings — pass the data as kwargs and let the renderer handle it.
- Don't `print()`. Use a logger.
- Don't reconfigure structlog. The one-and-only configuration lives in `backend/config/logging.py`.
