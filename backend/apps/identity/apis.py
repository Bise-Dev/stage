from typing import ClassVar

from rest_framework import authentication, status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.identity.github_oauth import device_poll, device_start, fetch_user
from apps.identity.models import Session
from apps.identity.selectors import _hash_token
from apps.identity.serializers.device_poll_input import DevicePollInputSerializer
from apps.identity.serializers.device_poll_ok_output import DevicePollOkOutputSerializer
from apps.identity.serializers.device_poll_pending_output import DevicePollPendingOutputSerializer
from apps.identity.serializers.user_output import UserOutputSerializer
from apps.identity.services import session_issue, session_revoke, user_upsert_from_github


class DeviceStartApi(APIView):
    permission_classes: ClassVar[list] = [AllowAny]  # pyrefly: ignore[bad-override]
    authentication_classes: ClassVar[list[type[authentication.BaseAuthentication]]] = []  # pyrefly: ignore[bad-override]

    def post(self, request: Request) -> Response:
        return Response(device_start())


class DevicePollApi(APIView):
    permission_classes: ClassVar[list] = [AllowAny]  # pyrefly: ignore[bad-override]
    authentication_classes: ClassVar[list[type[authentication.BaseAuthentication]]] = []  # pyrefly: ignore[bad-override]

    def post(self, request: Request) -> Response:
        serializer = DevicePollInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = device_poll(device_code=serializer.validated_data["device_code"])
        if result is None:
            return Response(DevicePollPendingOutputSerializer({"status": "pending"}).data)
        gh_user = fetch_user(access_token=result["access_token"])
        user = user_upsert_from_github(github_payload=gh_user)
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
