from django.db import OperationalError, connection
from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView


class HealthCheckApi(APIView):
    """Liveness + database probe. Returns 200 when the app can serve and the
    primary database is reachable; 503 otherwise.

    Inherits APIView defaults for permissions/authentication — with no
    DEFAULT_PERMISSION_CLASSES / DEFAULT_AUTHENTICATION_CLASSES configured,
    this endpoint is open by default. Revisit when auth is introduced.
    """

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
