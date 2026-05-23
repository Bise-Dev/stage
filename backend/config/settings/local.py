from config.settings.base import *  # noqa: F403
from config.settings.base import INSTALLED_APPS

# django-extensions ships dev-only tools (shell_plus, graph_models, runserver_plus).
# Keep it out of production to minimise INSTALLED_APPS surface area.
INSTALLED_APPS = [*INSTALLED_APPS, "django_extensions"]

EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
