# VerityBench
**Test agents. Trust the evidence.**

VerityBench is an evidence-first evaluation workspace for AI agents. It runs a
deterministic order-processing scenario, records tool-like events, simulates
payment failures, and independently checks the payment ledger before declaring
a run successful.

The product has a local CLI and a browser workspace. Local reports are written
as JSON; authenticated browser runs are persisted by the API and can be opened
again from the selected project.

## Safe sample scope

This release executes only the two repository-owned deterministic sample agents:

- `safe-sample-agent` reconciles an uncertain payment using the original
  idempotency key before fulfillment.
- `defective-sample-agent` demonstrates the duplicate-payment defect by retrying
  a lost response with a new key.

User-supplied Python, ZIP uploads, GitHub imports, arbitrary HTTP agents,
external URLs, and real payment systems are not executed by this MVP. The API
rejects unsupported agent modes. This is an intentional boundary until a
dedicated sandbox is available.

## Quick start

Requirements: Python 3.12.8, Node.js 22.14.0, and npm. The pinned versions are
recorded in `.python-version` and `frontend/.nvmrc`.

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.lock
python -m pip install -e .
npm --prefix frontend ci

veritybench init
veritybench validate
veritybench demo
```

`veritybench demo` writes the reproducible timeout comparison to
`runs/demo-defective-timeout.json` and `runs/demo-safe-recovery.json`. For one
configurable run, use the CLI examples in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Run the web workspace

Run the API and frontend in two terminals from the repository root. Keep the
Python virtual environment active in the API terminal:

```bash
alembic upgrade head
python -m uvicorn veritybench.api.main:app --reload --port 8000
cd frontend && npm run dev
```

The initial migration safely baselines an existing complete local SQLite schema;
it does not delete data from databases created by earlier builds.

Open <http://localhost:5173>. The API health and readiness endpoints are
<http://localhost:8000/health> and <http://localhost:8000/ready>; interactive
API documentation is at <http://localhost:8000/docs>.

The browser opens the **Overview** page at `/`. Without an API session it
shows clearly labelled, read-only local fixtures. To create persisted data,
choose **Sign in or register**, create or select a project, and open
**Agent runs** at `/runs`. Choose a sample agent and scenario, select **Run and
persist report**, then open the run at `/runs/:id` to inspect its report and
download **Export JSON**.

The five supported scenarios are `normal`, `timeout_after_success`,
`malformed_response`, `temporary_failure`, and `unrecoverable_failure`.

For the exact hackathon pitch, demo sequence, expected evidence, and submission
checklist, see [HACKATHON.md](HACKATHON.md).

## CLI guide

The CLI operates locally and does not require login for local evaluation:

```bash
veritybench init                         # create veritybench.toml and runs/
veritybench validate                     # check the local configuration
veritybench test --scenario normal --agent safe
veritybench report runs/latest.json      # summarize a saved report
veritybench runs                          # list JSON reports in runs/
veritybench export runs/latest.json --output report.json
```

`veritybench test` returns exit code 1 when the independent evaluation fails;
that is expected for the defective timeout example. `veritybench demo` is the
exception: it writes both the expected failing defective report and the passing
safe report, then exits successfully. See the
[development guide](docs/DEVELOPMENT.md) for every option, including `--json`,
custom output paths, `login`, and `sync`.

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
