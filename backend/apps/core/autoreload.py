"""Dev-only autoreload enhancement.

Django's default ``StatReloader`` only watches Python modules that were already
imported when ``runserver`` started. A *newly created* file — e.g. a fresh
``admin.py`` — is not in the watch set, so the server keeps running stale code
until it is manually restarted. Watching the source tree by glob makes the
reloader notice new files too.

Connected from :class:`apps.core.apps.CoreConfig.ready` under ``DEBUG`` only.
"""

from django.conf import settings

# Source directories worth watching for new files. Deliberately narrow so the
# reloader does not stat the entire ``.venv`` tree on every tick.
_WATCHED_SUBDIRS = ("apps", "config")


def watch_source_tree(sender, **kwargs):
    """Watch all ``*.py`` under the project's source dirs, recursively."""
    for subdir in _WATCHED_SUBDIRS:
        sender.watch_dir(settings.BASE_DIR / subdir, "**/*.py")
