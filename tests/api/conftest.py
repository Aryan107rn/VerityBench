from __future__ import annotations

import os
import tempfile

import pytest

_database_path = os.path.join(tempfile.mkdtemp(prefix="veritybench-api-"), "api.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_database_path}"
os.environ["VERITYBENCH_CORS_ORIGINS"] = "http://testserver"

from veritybench.api import main as api_main  # noqa: E402


@pytest.fixture(autouse=True)
def reset_auth_limiter(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep API tests isolated from the process-global development limiter."""

    monkeypatch.setattr(api_main, "auth_limiter", api_main.AuthRateLimiter())
