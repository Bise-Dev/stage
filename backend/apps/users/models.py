from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    github_login = models.CharField(max_length=39, unique=True, null=True, blank=True)
    github_user_id = models.BigIntegerField(unique=True, null=True, blank=True)
    display_name = models.CharField(max_length=255, blank=True, default="")
    avatar_url = models.URLField(blank=True, default="")
    last_login_at = models.DateTimeField(null=True, blank=True)
