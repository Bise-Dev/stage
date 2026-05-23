from typing import Any


class ApplicationError(Exception):
    """Top-level domain exception. Mapped to a uniform DRF response by the
    custom exception handler in apps.core.exception_handlers."""

    def __init__(
        self,
        message: str,
        extra: dict[str, Any] | None = None,
        status: int = 400,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.extra: dict[str, Any] = extra or {}
        self.status = status
