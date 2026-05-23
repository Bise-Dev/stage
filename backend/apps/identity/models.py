from django.db import models

from apps.core.models import BaseModel
from apps.users.models import User


class Session(BaseModel):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="sessions")
    token_hash = models.CharField(max_length=64, db_index=True)
    last_used_at = models.DateTimeField(auto_now=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:  # pyrefly: ignore[bad-override]
        db_table = "identity_session"
