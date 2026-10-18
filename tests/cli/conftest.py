from __future__ import annotations

import pytest


@pytest.fixture
def cli_cwd(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    return tmp_path
