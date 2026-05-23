from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import (
    SpectacularAPIView,
    SpectacularRedocView,
    SpectacularSwaggerView,
)

from apps.core.apis import HealthCheckApi

api_v1_patterns = [
    path("schema/", SpectacularAPIView.as_view(), name="schema"),
    path("docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
    path("redoc/", SpectacularRedocView.as_view(url_name="schema"), name="redoc"),
    path("items/", include("apps.items.urls")),
]

urlpatterns = [
    path("admin/", admin.site.urls),
    path("health/", HealthCheckApi.as_view(), name="health"),
    path("api/v1/", include((api_v1_patterns, "api"), namespace="v1")),
]
