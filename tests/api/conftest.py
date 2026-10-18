from __future__ import annotations

import os
import tempfile

_database_path = os.path.join(tempfile.mkdtemp(prefix="veritybench-api-"), "api.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_database_path}"
os.environ["VERITYBENCH_CORS_ORIGINS"] = "http://testserver"
