# Development guide

## Local setup

Use Python 3.12.8 from `.python-version` and Node.js 22.14.0 from
`frontend/.nvmrc`. Install Python dependencies from `requirements.lock` and
frontend dependencies with `npm ci`; do not install project dependencies
globally.

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.lock
python -m pip install -e .
cd frontend && npm ci
```

## Run the API and frontend

Start the API from the repository root in one terminal with the virtual
environment active:

```bash
python -m uvicorn veritybench.api.main:app --reload --port 8000
```

Start the Vite frontend in a second terminal:

```bash
cd frontend
npm run dev
```

Open <http://localhost:5173>. The API exposes liveness at
<http://localhost:8000/health>, database readiness at
<http://localhost:8000/ready>, and FastAPI documentation at
<http://localhost:8000/docs>. The frontend uses `http://localhost:8000` by
default; set `VITE_API_URL` when the API runs at another base URL.

## Browser product flow

The browser has these user-facing pages:

- `/` — **Overview**, with the reliability summary and recent runs.
- `/runs` — **Agent runs**, with the run controls, metrics, trend, and run list.
- `/runs/:id` — **Run detail**, with the persisted report's evaluation, trace,
  ledger, metrics, invariants, findings, recommendations, and **Export JSON**.
- `/datasets` — a browser-local catalog for organizing fixture and local dataset
  context. It does not create API resources yet.
- `/evaluators` — browser-local visibility controls for the checks shown in the
  workspace. Server-backed report evaluation remains authoritative.
- `/settings` — light/dark theme, local workspace preferences, and read-only API
  health status.
- `/cli` — an in-app HTTP/API guide with copyable health, authentication, run,
  and report commands.

The connected flow is:

1. Open the frontend and choose **Sign in or register**.
2. Register or sign in, then create or select an authenticated project from the
   project bar.
3. Open **Agent runs**, choose a repository-owned sample agent and a
   deterministic payment scenario, and select **Run and persist report**.
4. The browser reads the persisted run back through the
   protected detail endpoint before showing its report.
5. Inspect report-derived metrics, evaluator invariants, ledger entries, trace
   attributes, findings, recommendations, and export the report JSON.

When the API is unavailable, or when no authenticated project is selected, the
UI falls back to explicitly labelled offline demo fixtures. Demo values are
read-only and are not presented as persisted tenant data.

## Install and use the CLI locally

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.lock
python -m pip install .
veritybench --help
veritybench --version
```

The `[project.scripts]` entry in `pyproject.toml` installs the real
`veritybench` executable. All local CLI commands use the current directory.
Run `veritybench init` before `validate` or `test`; it creates the default
`runs/` directory as part of the local workflow. `demo`, `report`, `runs`, and
`export` operate on report paths and do not require a configuration file.

`veritybench test` is the privacy-preserving path: it does not contact the API,
does not require login, and does not upload agent source. `sync`, API agent
registration, and GitHub import are separate remote workflows and must not be
used when source must remain local.

### Initialize and validate

```bash
veritybench init
veritybench init --force       # replace an existing veritybench.toml
veritybench validate
veritybench agents list --json
veritybench scenarios list --json
veritybench agent init ./my-agent.py
```

`init` creates `veritybench.toml` and `runs/`. The generated project defaults
to the `safe` agent and `normal` scenario. `validate` checks the project
configuration without executing an agent. It accepts only `safe` or `defective`
for `[project].agent`.

### Run evaluations

```bash
veritybench test --scenario normal --agent safe
veritybench test --scenario all --agent safe
veritybench test --scenario timeout_after_success --agent safe --json
veritybench test --scenario timeout_after_success --agent defective \
  --output runs/defective-timeout.json
veritybench test --scenario timeout_after_success \
  --agent-path examples/agents/template_agent.py
veritybench test --scenario timeout_after_success \
  --agent-path ./my-agent.py \
  --output runs/my-agent-timeout.json
veritybench test --agent-path ./my_agent.py --timeout 20 --json \
  --output runs/my-agent.json
```

`test` executes one bounded deterministic evaluation and writes
`runs/latest.json` by default. Use `--scenario all` to execute the complete
scenarios as a local suite. Use `--scenario`, `--agent`, `--output`, and
`--json` to select the behavior, sample agent, destination, and output format.
Use `--param NAME=VALUE` (repeatable), `--seed`, `--max-retries`, and
`--max-steps` to configure a validated deterministic scenario. Use
`--agent-path` instead of `--agent` to run a version-1 custom Python agent
in a Docker container. Docker is required, and `VERITYBENCH_AGENT_IMAGE` must
name a locally available `name@sha256:<64 lowercase hex characters>` image;
mutable tags and host execution are refused. The default worker timeout is 10
seconds; `--timeout` changes it. A normal custom-agent run shows live engine
events; `--json` prints only the final valid JSON report.
The supported scenarios are:

- `normal` — the payment succeeds normally.
- `timeout_after_success` — the charge succeeds but the response is lost.
- `malformed_response`, `malformed_tool_response` — a response/tool payload is not parseable.
- `temporary_failure`, `transient_failure` — transient provider failures before recovery.
- `rate_limited` — deterministic HTTP 429 responses before recovery.
- `unrecoverable_failure` — every payment attempt remains unsuccessful.
- `retry_exhaustion` — bounded retries end in cancellation without a charge.
- `tool_exception` — a tool exception is treated as untrusted failure.
- `duplicate_operation` — duplicate settlement behavior is evaluated independently.
- `conflicting_tool_output` — conflicting tool identity/amount is rejected.
- `malicious_tool_output` — instruction-like tool output is treated as untrusted data.

The command exits 0 for a passing evaluation and 1 when the independent
evaluation finds a defect. The defective timeout run is expected to exit 1.
Worker timeouts exit 124. Invalid contract modules, invalid paths, and other
worker refusals exit 2 with a clear diagnostic.

### Terminal report output and CI/CD

By default, `test`, `report`, `runs show`, and `demo` display a styled
**VerityBench** report with the tagline **Test agents. Trust the evidence.**
The report includes metrics, checks and their evidence, findings and
recommendations, and the saved report path. Suites show each scenario's result.
An unfinished or inconclusive run is labelled `timed_out`, `cancelled`, or
`inconclusive` rather than being presented as a completed PASS/FAIL evaluation.
Reports without findings display `No findings.`

Use `--json` with `test`, `report`, or `runs show` for machine-readable output
matching the saved JSON report, without branding, live events, or ANSI styling.
Set `NO_COLOR=1` to disable terminal colors. Report layouts automatically adapt
to the available terminal width; redirected output remains readable without
ANSI escape controls.

For CI/CD, save the machine-readable report and preserve the process exit code:

```bash
veritybench test \
  --agent-path ./my-agent.py \
  --scenario all \
  --json \
  --output runs/ci-report.json
```

The local command writes only to the checkout and its configured report path.

### Compare both sample agents

```bash
veritybench demo
```

`demo` always runs `timeout_after_success` with both sample agents, writes
`runs/demo-defective-timeout.json` and `runs/demo-safe-recovery.json`, and exits
0 even though the defective result is an expected failure. It prints the
duplicate-charge count and recommendation for each report.

### Read, list, and export reports

```bash
veritybench report
veritybench report runs/demo-defective-timeout.json
veritybench report runs/latest.json --json
veritybench runs
veritybench runs list --json
veritybench runs show runs/latest.json
veritybench runs show runs/latest.json --json
veritybench export runs/latest.json --output report.json
```

`report [PATH]` and `runs show [PATH]` read one saved JSON report and print its
pass/fail status, metrics, findings, evidence, and recommendations; `--json`
prints the report instead of the summary. `runs` remains a shorthand for
`runs list`, while `runs list --json` prints a JSON array of report summaries.
`export [PATH] --output PATH` reads a report and copies it to a named JSON path;
the defaults are `runs/latest.json` and `report.json`.

## HTTP API / Advanced Usage

The API-backed commands are optional. Use them only when a team has deliberately
chosen persisted remote runs, project authentication, or the isolated remote
worker. They are not part of the private local workflow.

### Run through the authenticated API from the CLI

```bash
veritybench login --base-url http://localhost:8000
veritybench sync --project-id PROJECT_ID \
  --scenario timeout_after_success --agent safe
```

`login` prompts for the email and hidden password, then stores the short-lived
session token at `~/.config/veritybench/session.json` with mode `0600`.
`sync` requires that login and a project ID, supplied with `--project-id` or
`[api].project_id` in `veritybench.toml`; it waits for the asynchronous API run
to reach a terminal state and exits 1 when the API run is not passed. Use
`--wait-timeout` to bound the client wait; a client timeout exits 124. Remote
registered agents are submitted by their `remote:<agent-id>` key after the
separate worker is configured. `--agent-path` is never forwarded to the API.

## Local Python agent boundary

The versioned Python contract, copyable example, Docker policy, structured
event protocol, and diagnostics are documented in
[AGENT_CONTRACT.md](AGENT_CONTRACT.md). Custom code runs in the CLI's or the
separate remote worker's Docker boundary. It is not loaded by FastAPI.

## Adding an adapter

Implement the documented local contract in a separate module, keep it
deterministic for tests, and add independent evaluator tests. Do not add a
framework adapter that executes arbitrary source in the API process. A future
runtime must declare its contract version, tools, limits, output schema, and
isolation policy.
