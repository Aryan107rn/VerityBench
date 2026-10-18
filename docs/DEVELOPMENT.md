# Development guide

## Local setup

Use the pinned Python version in `.python-version` and Node version in
`frontend/.nvmrc`. Install Python dependencies from `requirements.lock` and
frontend dependencies with `npm ci`; do not install project dependencies
globally.

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.lock
python -m pip install -e .
cd frontend && npm ci
```

## Useful commands

```bash
veritybench --help
veritybench init
veritybench validate
veritybench test --scenario normal
veritybench test --scenario timeout_after_success --agent defective
veritybench report runs/latest.json
veritybench runs
```

The CLI never needs login for local evaluation. API login stores only a
short-lived token in the user's local config file; the token is not printed by
the server and is not written to project files.

## Supported scenarios

`normal`, `timeout_after_success`, `malformed_response`, `temporary_failure`,
and `unrecoverable_failure` are deterministic simulated payment behaviors.
There are no real payment integrations or customer records.

## Adding an adapter

Implement the small typed `Agent` protocol in
`src/veritybench_engine/agents.py`, keep it deterministic for tests, and add
independent evaluator tests. Do not add a framework adapter that executes
arbitrary source in the API process. A future adapter must declare its runtime,
tools, limits, output schema, and isolation policy.
