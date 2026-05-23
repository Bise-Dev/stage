from typing import ClassVar

from django.db import OperationalError, connection
from rest_framework import authentication, status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView


class HealthCheckApi(APIView):
    authentication_classes: ClassVar[list[type[authentication.BaseAuthentication]]] = []  # pyrefly: ignore[bad-override]
    permission_classes: ClassVar[list] = [AllowAny]  # pyrefly: ignore[bad-override]

    def get(self, request: Request) -> Response:
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
        except OperationalError as exc:
            return Response(
                {"status": "degraded", "database": "unreachable", "error": str(exc)},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response({"status": "ok", "database": "ok"})
