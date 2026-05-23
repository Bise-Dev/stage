from typing import Any
from unittest.mock import Mock

import pytest
from django.core.exceptions import PermissionDenied
from django.core.exceptions import ValidationError as DjangoValidationError
from django.http import Http404
from rest_framework import exceptions as drf_exceptions

from apps.core.exception_handlers import application_exception_handler
from apps.core.exceptions import ApplicationError


def _ctx() -> dict[str, Any]:
    return {"view": Mock(), "request": Mock(), "args": (), "kwargs": {}}


def test_application_error_maps_to_message_extra_shape() -> None:
    exc = ApplicationError("nope", extra={"reason": "test"}, status=418)

    response = application_exception_handler(exc, _ctx())

    assert response is not None
    assert response.status_code == 418
    assert response.data == {"message": "nope", "extra": {"reason": "test"}}


def test_application_error_defaults_to_400_with_empty_extra() -> None:
    response = application_exception_handler(ApplicationError("bad"), _ctx())

    assert response is not None
    assert response.status_code == 400
    assert response.data == {"message": "bad", "extra": {}}


def test_http_404_maps_to_404_with_uniform_shape() -> None:
    response = application_exception_handler(Http404("missing"), _ctx())

    assert response is not None
    assert response.status_code == 404
    assert "message" in response.data
    assert "extra" in response.data


def test_django_permission_denied_maps_to_403() -> None:
    response = application_exception_handler(PermissionDenied("denied"), _ctx())

    assert response is not None
    assert response.status_code == 403


def test_django_validation_error_maps_to_400() -> None:
    exc = DjangoValidationError({"name": ["This field is required."]})

    response = application_exception_handler(exc, _ctx())

    assert response is not None
    assert response.status_code == 400


def test_drf_validation_error_passes_through_with_uniform_shape() -> None:
    exc = drf_exceptions.ValidationError({"field": ["required"]})

    response = application_exception_handler(exc, _ctx())

    assert response is not None
    assert response.status_code == 400
    assert "message" in response.data
    assert "extra" in response.data


def test_unhandled_exception_returns_none() -> None:
    # When DRF's default handler doesn't recognise an exception (e.g. a raw
    # Python exception), the handler returns None, letting Django fall through
    # to its 500 page.
    class WeirdError(Exception):
        pass

    response = application_exception_handler(WeirdError("kaboom"), _ctx())
    assert response is None


@pytest.mark.parametrize("status_arg", [400, 401, 403, 404, 409, 422, 500])
def test_application_error_honours_arbitrary_status(status_arg: int) -> None:
    response = application_exception_handler(ApplicationError("x", status=status_arg), _ctx())
    assert response is not None
    assert response.status_code == status_arg
