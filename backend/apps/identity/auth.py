from rest_framework import authentication, exceptions
from rest_framework.request import Request

from apps.identity.selectors import session_find_user


class BearerSessionAuthentication(authentication.BaseAuthentication):
    keyword = "Bearer"

    def authenticate(self, request: Request):
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not header.startswith(self.keyword + " "):
            return None
        raw = header.split(" ", 1)[1].strip()
        user = session_find_user(raw_token=raw)
        if user is None:
            raise exceptions.AuthenticationFailed("invalid or revoked token")
        return (user, raw)
