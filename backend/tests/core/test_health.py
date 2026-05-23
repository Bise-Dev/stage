import pytest
from rest_framework.test import APIClient


@pytest.mark.django_db
def test_health_returns_ok_when_db_is_reachable() -> None:
    client = APIClient()
    response = client.get("/health/")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}
