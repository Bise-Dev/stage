from django.urls import path

from apps.identity.apis import AuthLogoutApi, AuthMeApi, DevicePollApi, DeviceStartApi

app_name = "identity"

urlpatterns = [
    path("device/start/", DeviceStartApi.as_view(), name="device-start"),
    path("device/poll/", DevicePollApi.as_view(), name="device-poll"),
    path("me/", AuthMeApi.as_view(), name="me"),
    path("logout/", AuthLogoutApi.as_view(), name="logout"),
]
