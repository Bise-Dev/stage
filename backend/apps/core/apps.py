from django.apps import AppConfig
from django.conf import settings


class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.core"
    label = "core"

    def ready(self) -> None:
        # In dev, make runserver's reloader watch the whole source tree so that
        # newly created files (e.g. a new app's admin.py) trigger a reload too.
        if settings.DEBUG:
            from django.utils.autoreload import autoreload_started

            from apps.core.autoreload import watch_source_tree

            autoreload_started.connect(watch_source_tree)
