from typing import ClassVar

from rest_framework import authentication, status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.identity.github_app import exchange_code, fetch_user
from apps.identity.models import Session
from apps.identity.selectors import _hash_token
from apps.identity.serializers.device_poll_ok_output import DevicePollOkOutputSerializer
from apps.identity.serializers.user_output import UserOutputSerializer
from apps.identity.serializers.web_exchange_input import WebExchangeInputSerializer
from apps.identity.services import (
    github_identity_upsert,
    session_issue,
    session_revoke,
    user_upsert_from_github,
)


class AuthWebExchangeApi(APIView):
    permission_classes = [AllowAny]  # noqa: RUF012
    authentication_classes: ClassVar[list[type[authentication.BaseAuthentication]]] = []  # pyrefly: ignore[bad-override]

    def post(self, request: Request) -> Response:
        serializer = WebExchangeInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = exchange_code(
            code=serializer.validated_data["code"],
            code_verifier=serializer.validated_data["code_verifier"],
            redirect_uri=serializer.validated_data["redirect_uri"],
        )
        gh_user = fetch_user(access_token=payload["access_token"])
        user = user_upsert_from_github(github_payload=gh_user)
        github_identity_upsert(user=user, payload=payload)
        raw, _ = session_issue(user=user)
        return Response(
            DevicePollOkOutputSerializer(
                {
                    "status": "ok",
                    "session_token": raw,
                    "user": user,
                }
            ).data,
        )


class AuthMeApi(APIView):
    def get(self, request: Request) -> Response:
        return Response(UserOutputSerializer(request.user).data)


class AuthLogoutApi(APIView):
    def post(self, request: Request) -> Response:
        raw = request.auth
        if raw:
            session = Session.objects.filter(
                token_hash=_hash_token(str(raw)),
                revoked_at__isnull=True,
            ).first()
            if session:
                session_revoke(session=session)
        return Response(status=status.HTTP_204_NO_CONTENT)
