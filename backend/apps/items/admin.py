from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.items.models import Item


@admin.register(Item)
class ItemAdmin(ModelAdmin):
    list_display = ("name", "owner", "status", "quantity", "created_at")
    list_filter = ("status",)
    search_fields = ("name",)
