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

## CLI guide

```bash
veritybench --help
```

All local CLI commands use the current directory. Run `veritybench init` before
`validate` or `test`; it creates the default `runs/` directory as part of the
local workflow. `demo`, `report`, `runs`, and `export` operate on report paths
and do not require a configuration file.

### Initialize and validate

```bash
veritybench init
veritybench init --force       # replace an existing veritybench.toml
veritybench validate
```

`init` creates `veritybench.toml` and `runs/`. The generated project defaults
to the `safe` agent and `normal` scenario. `validate` checks the project
configuration without executing an agent. It accepts only `safe` or `defective`
for `[project].agent`.

### Run evaluations

```bash
veritybench test --scenario normal --agent safe
veritybench test --scenario timeout_after_success --agent safe --json
veritybench test --scenario timeout_after_success --agent defective \
  --output runs/defective-timeout.json
```

`test` executes one bounded deterministic evaluation and writes
`runs/latest.json` by default. Use `--scenario`, `--agent`, `--output`, and
`--json` to select the behavior, sample agent, destination, and output format.
The supported scenarios are:

- `normal` — the payment succeeds normally.
- `timeout_after_success` — the charge succeeds but the response is lost.
- `malformed_response` — the provider response cannot be read.
- `temporary_failure` — the first payment attempt fails temporarily.
- `unrecoverable_failure` — every payment attempt remains unsuccessful.

The command exits 0 for a passing evaluation and 1 when the independent
evaluation finds a defect. The defective timeout run is expected to exit 1.

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
veritybench export runs/latest.json --output report.json
```

`report [PATH]` reads one saved JSON report and prints its pass/fail status,
metrics, findings, evidence, and recommendations; `--json` prints the report
instead of the summary. `runs` lists every `*.json` report under `runs/` with a
pass/fail label. `export [PATH] --output PATH` reads a report and copies it to a
named JSON path; the defaults are `runs/latest.json` and `report.json`.

### Run through the authenticated API from the CLI

```bash
veritybench login --base-url http://localhost:8000
veritybench sync --project-id PROJECT_ID \
  --scenario timeout_after_success --agent safe
```

`login` prompts for the email and hidden password, then stores the short-lived
session token at `~/.config/veritybench/session.json` with mode `0600`.
`sync` requires that login and a project ID, supplied with `--project-id` or
`[api].project_id` in `veritybench.toml`; it prints the persisted API response
and exits 1 when the API run is not passed. These commands still support only
the two sample agents and the five local scenarios.

## Safe sample limitation

The CLI and API instantiate only `safe-sample-agent` and
`defective-sample-agent`, both owned by this repository. They run against a
local deterministic payment model; there are no real payment integrations or
customer records. User Python, uploaded ZIPs, GitHub projects, arbitrary HTTP
agents, and external URLs are rejected and must not be described as supported
inputs. This boundary remains in place until an isolated sandbox exists.

## Adding an adapter

Implement the small typed `Agent` protocol in
`src/veritybench_engine/agents.py`, keep it deterministic for tests, and add
independent evaluator tests. Do not add a framework adapter that executes
arbitrary source in the API process. A future adapter must declare its runtime,
tools, limits, output schema, and isolation policy.
