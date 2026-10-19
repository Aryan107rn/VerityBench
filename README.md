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
The web registry also supports importing one UTF-8 Python entrypoint from a
public `https://github.com/OWNER/REPO` URL plus an explicit ref/path. The import
is allowlisted, size-bounded, recorded with provenance, and still executes only
through the isolated worker. ZIP uploads, arbitrary HTTP agents, external URLs,
and real payment systems remain unsupported.

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

The deterministic scenario catalog is shared by the engine, API, CLI, and UI.
It currently includes `normal`, `timeout_after_success`, `malformed_response`,
`malformed_tool_response`, `temporary_failure`, `transient_failure`,
`rate_limited`, `unrecoverable_failure`, `retry_exhaustion`, `tool_exception`,
`duplicate_operation`, `conflicting_tool_output`, and
`malicious_tool_output`. Use the protected API catalog or `veritybench scenarios
list --json` for descriptions, categories, parameters, and execution limits.

### Observability workspace

The dark-first website uses a compact developer-tool layout with a collapsible
sidebar, summary counters, per-run bar charts, evaluator coverage, and a dense
experiment-results table. Search with **Ctrl/Cmd+K** across pages and loaded
runs, or press **/** to focus experiment search. Results support state filters,
name/score sorting, pagination within loaded history, and side-by-side comparison.

Open a persisted run for the three-pane trace workspace: ordered event history,
an Overview/Attributes/JSON inspector, and recorded metadata. Trace, Evaluation,
Ledger, and Findings tabs expose actual returned evidence. Fixture mode remains
explicitly labelled, and no unrecorded token/cost/latency metrics are fabricated.
Light mode and mobile layouts are also supported. Browser regression setup is
documented in [docs/TESTING.md](docs/TESTING.md).

For the exact hackathon pitch, demo sequence, expected evidence, and submission
checklist, see [HACKATHON.md](HACKATHON.md).

## Install the CLI and test locally

The `veritybench` command is a real installable Python package entrypoint. A
developer can keep an agent private by running `veritybench test` locally; this
workflow does not require login, contact the VerityBench API, or upload agent
source code. Reports are written to the local `runs/` directory.

From a clean checkout:

```bash
git clone https://github.com/Aryan107rn/VerityBench.git
cd VerityBench
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.lock
python -m pip install .
veritybench --version
```

Initialize a private local evaluation project and create a compatible agent:

```bash
mkdir private-agent-check && cd private-agent-check
veritybench init
veritybench agent init ./my-agent.py
veritybench validate
veritybench scenarios list
```

Run the local agent and save evidence without sending its source anywhere:

```bash
veritybench test \
  --agent-path ./my-agent.py \
  --scenario timeout_after_success \
  --output runs/my-agent-timeout.json
veritybench report runs/my-agent-timeout.json
```

Custom agents require Docker and a digest-pinned
`VERITYBENCH_AGENT_IMAGE`. The local sandbox disables networking, uses a
read-only filesystem, runs as non-root, and applies resource limits. For a
quick engine-only smoke test that does not need Docker, use the repository-owned
sample agent:

```bash
veritybench test --agent safe --scenario all --json --output runs/safe-suite.json
```

Use `--json` for CI/CD, and rely on the process exit code: `0` means the
independent evaluation passed, `1` means it found a defect, `2` means invalid
input or a worker refusal, and `124` means the bounded worker timed out.
`veritybench sync` and the web/API registration/import flows are separate
remote workflows; do not use them when source privacy is required.

### HTTP API / Advanced Usage

The commands below are for inspecting local reports; the authenticated HTTP/API
workflow is documented separately and is not required for private local testing:

```bash
veritybench report runs/latest.json      # summarize a saved report
veritybench agents list                  # show sample and local agent modes
veritybench scenarios list               # show deterministic scenarios
veritybench runs list                    # list JSON reports in runs/
veritybench runs show runs/latest.json   # inspect one saved report
veritybench export runs/latest.json --output report.json
```

Human-readable reports now use the VerityBench double-V logo and a responsive,
colored terminal layout: evaluation verdict, metric table, independent checks,
and actionable findings with evidence and recommendations. The report appears
automatically after `test`; use `report` or `runs show` to reopen it. Suites also
show a verdict for every scenario. `NO_COLOR=1` disables colors, and redirected
output contains no ANSI controls. Use `--json` for unchanged machine-readable
reports rather than terminal formatting.

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
