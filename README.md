# VerityBench
**Test agents. Trust the evidence.**

VerityBench is an evidence-first evaluation workspace for AI agents. The MVP
ships a deterministic order-processing scenario that records tool-like events,
simulates payment failures, and independently checks the payment ledger before
declaring a run successful.

It simulates real-world failures, evaluates agent reliability, identifies
failure points, and provides actionable insights to improve performance.

## Current scope

The first release intentionally supports the in-repository sample agents only:

- `safe-sample-agent` reconciles an uncertain payment using the original
  idempotency key before fulfillment.
- `defective-sample-agent` demonstrates the duplicate-payment defect by retrying
  a lost response with a new key.

User-supplied Python, ZIP uploads, GitHub imports, arbitrary HTTP agents, and
external URLs are **not executed** by this MVP. The API rejects those modes.
This is a deliberate security boundary until a dedicated sandbox is available.

## Quick start

Requirements: Python 3.12, Node.js 22.14, npm, and (for the container path)
Docker.

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.lock
python -m pip install -e .

veritybench init
veritybench validate
veritybench test --scenario timeout_after_success --agent safe --json
veritybench test --scenario timeout_after_success --agent defective --json
veritybench report runs/latest.json
veritybench export runs/latest.json --output report.json
```

Run the API and frontend in two terminals:

```bash
uvicorn veritybench.api.main:app --reload --port 8000
cd frontend && npm ci && npm run dev
```

Open <http://localhost:5173>. The frontend is usable offline with clearly
labelled local demo fixtures and switches to the API when the endpoint is
available. API health is at <http://localhost:8000/health>.

## Test and quality checks

The single offline test command is:

```bash
make test
```

It runs Python tests, Ruff, mypy, and the frontend typecheck/build when the
frontend dependencies are installed. Individual checks:

```bash
python -m pytest
python -m ruff check src tests
python -m mypy src
cd frontend && npm run typecheck && npm run build
```

Security and dependency scans are documented in [docs/TESTING.md](docs/TESTING.md).
They are not represented as passing unless the named tool actually ran.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the modular-monolith
boundaries and [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for the current
execution and tenant-isolation assumptions.

## Operations

- [Development and CLI guide](docs/DEVELOPMENT.md)
- [API and integration contract](docs/API.md)
- [Testing and security verification](docs/TESTING.md)
- [Deployment and backups](docs/DEPLOYMENT.md)
- [Security policy](SECURITY.md)

## License

The repository is distributed under the MIT License; see [LICENSE](LICENSE).
