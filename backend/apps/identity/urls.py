from django.urls import path

from apps.identity import apis

app_name = "identity"

urlpatterns = [
    path("web/exchange/", apis.AuthWebExchangeApi.as_view(), name="auth_web_exchange"),
    path("me/", apis.AuthMeApi.as_view(), name="auth_me"),
    path("logout/", apis.AuthLogoutApi.as_view(), name="auth_logout"),
]
