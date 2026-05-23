from django.urls import path

from apps.items.apis import (
    ItemArchiveApi,
    ItemCreateApi,
    ItemDeleteApi,
    ItemDetailApi,
    ItemListApi,
    ItemUpdateApi,
)

app_name = "items"

urlpatterns = [
    path("", ItemListApi.as_view(), name="list"),
    path("create/", ItemCreateApi.as_view(), name="create"),
    path("<uuid:item_id>/", ItemDetailApi.as_view(), name="detail"),
    path("<uuid:item_id>/update/", ItemUpdateApi.as_view(), name="update"),
    path("<uuid:item_id>/archive/", ItemArchiveApi.as_view(), name="archive"),
    path("<uuid:item_id>/delete/", ItemDeleteApi.as_view(), name="delete"),
]
