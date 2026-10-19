# VerityBench
**Test agents. Trust the evidence.**

VerityBench is an evidence-first evaluation workspace for AI agents. It runs a
deterministic order-processing scenario, records tool-like events, simulates
payment failures, and independently checks the payment ledger before declaring
a run successful.

The product has a local CLI and a browser workspace. Local reports are written
as JSON; authenticated browser runs are persisted by the API and can be opened
again from the selected project.

## Agent execution scope

The repository-owned deterministic sample agents are available locally and
through the API:

- `safe-sample-agent` reconciles an uncertain payment using the original
  idempotency key before fulfillment.
- `defective-sample-agent` demonstrates the duplicate-payment defect by retrying
  a lost response with a new key.

The CLI also supports a local Python agent module through `--agent-path`. The
module must implement the versioned contract in
[docs/AGENT_CONTRACT.md](docs/AGENT_CONTRACT.md), and it is loaded only in a
Docker container. Docker and a locally available digest-pinned image configured
as `VERITYBENCH_AGENT_IMAGE` are required; there is no host-execution fallback.
Custom Python can also be explicitly registered for a project through the web
API. Registration stores an immutable source artifact; the FastAPI process does
not import or execute it. A separately operated `python -m veritybench.worker`
claims those queued runs and invokes the Docker sandbox. If that worker is not
running, the run remains queued and never falls back to FastAPI execution. The
sandbox mounts only the agent file, disables networking, drops capabilities,
runs as a non-root UID, and applies read-only, CPU, memory, and process limits.
ZIP uploads, GitHub imports, arbitrary HTTP agents, external URLs, and real
payment systems remain unsupported.

## Quick start

Requirements: Python 3.12.8, Node.js 22.14.0, npm, and Docker for custom
`--agent-path` or remote-worker runs. The pinned versions are recorded in `.python-version` and
`frontend/.nvmrc`.

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

For explicitly registered remote agents, run the isolated worker separately on
a host with Docker access and the same database/artifact storage:

```bash
VERITYBENCH_AGENT_IMAGE='registry.example/veritybench-agent@sha256:<digest>' \
python -m veritybench.worker
```

The worker is intentionally not started by FastAPI and the API container must
not receive the Docker socket.

The local compose deployment also provides the worker as an opt-in `remote`
profile. Set `VERITYBENCH_AGENT_IMAGE` to a locally available digest-pinned
image and `DOCKER_GID` to the Docker socket's group before running
`docker compose --profile remote up --build`; see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

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
veritybench agent init ./my-agent.py      # create a compatible starter
veritybench test --scenario normal --agent safe
veritybench test --scenario all --agent safe
veritybench test --scenario timeout_after_success \
  --agent-path examples/agents/template_agent.py
veritybench report runs/latest.json      # summarize a saved report
veritybench agents list                  # show sample and local agent modes
veritybench scenarios list               # show deterministic scenarios
veritybench runs list                    # list JSON reports in runs/
veritybench runs show runs/latest.json   # inspect one saved report
veritybench export runs/latest.json --output report.json
```

`veritybench test` returns exit code 1 when the independent evaluation fails;
that is expected for the defective timeout example. A local worker timeout
returns 124, while an invalid contract or worker refusal returns 2. `--json`
prints only the report JSON on stdout; a normal local-agent run prints live
engine events before its summary. Custom agents require a responsive Docker
daemon and a local image referenced by `VERITYBENCH_AGENT_IMAGE` as
`name@sha256:<64 lowercase hex characters>`; Docker is never silently skipped.
`veritybench demo` is the exception: it
writes both the expected failing defective report and the passing safe report,
then exits successfully. See the [development guide](docs/DEVELOPMENT.md) and
[Python agent contract](docs/AGENT_CONTRACT.md) for every option.

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
