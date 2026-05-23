from typing import Any

from django.core.exceptions import PermissionDenied
from django.core.exceptions import ValidationError as DjangoValidationError
from django.http import Http404
from rest_framework import exceptions as drf_exceptions
from rest_framework.response import Response
from rest_framework.serializers import as_serializer_error
from rest_framework.views import exception_handler as drf_default_exception_handler

from apps.core.exceptions import ApplicationError


def application_exception_handler(exc: Exception, ctx: dict[str, Any]) -> Response | None:
    if isinstance(exc, ApplicationError):
        return Response(
            {"message": exc.message, "extra": exc.extra},
            status=exc.status,
        )

    if isinstance(exc, DjangoValidationError):
        exc = drf_exceptions.ValidationError(as_serializer_error(exc))
    elif isinstance(exc, Http404):
        exc = drf_exceptions.NotFound()
    elif isinstance(exc, PermissionDenied):
        exc = drf_exceptions.PermissionDenied()

    response = drf_default_exception_handler(exc, ctx)
    if response is None:
        return None

    return Response(
        {"message": str(exc), "extra": {"errors": response.data}},
        status=response.status_code,
    )
