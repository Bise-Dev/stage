from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from unfold.admin import ModelAdmin

from apps.users.models import User


@admin.register(User)
class UserAdmin(DjangoUserAdmin, ModelAdmin):
    pass
