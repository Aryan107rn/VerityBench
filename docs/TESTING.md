# Testing and security verification

## Required local checks

```bash
make test
python -m pytest tests/engine tests/api tests/cli
python -m pytest tests/cli -q
```

The deterministic engine tests cover the safe timeout recovery, defective
duplicate charge, malformed response, temporary retry, unrecoverable failure,
independent evaluation, and repeatability requirements. CLI tests cover sample
regression, valid/invalid local-agent contracts, worker timeout and exception
diagnostics, bounded subprocess JSON output, live events, and JSON catalog/run
commands. API tests cover registration, protected project access, cross-user
denial, and persisted runs.

## Browser UI regressions

The frontend includes a pinned Playwright/Chromium suite. After installing
the frontend dependencies, install its matching browser once:

```bash
npm --prefix frontend ci
cd frontend
PLAYWRIGHT_BROWSERS_PATH=./node_modules/.cache/ms-playwright npx --no-install playwright install chromium
npm run test:e2e
```

The browser cache stays under `frontend/node_modules/`. A clean Linux host
also needs Chromium's system libraries; Playwright reports missing libraries
at launch. Browser provisioning is separate from the offline `make test`
command; after provisioning, the suite uses a local Vite server on port 4175.
It intercepts API traffic with synthetic fixtures and sessions, never the
developer's database, browser profile, or credentials.

Coverage includes dark/light theme persistence, navigation, command search,
experiment search/state filters/sorting/comparison, chart drill-down, mobile
overflow at 320/390px, and an authenticated mocked run's history/live-stream
transition, event selection, payload/report tabs, and JSON report download.
Screenshots of the overview, experiments, and inspector are written beneath
`frontend/test-results/`; `frontend/playwright-report/index.html` contains the
test report. These are generated and gitignored, not production assets. Mocked
API checks do not replace real Docker sandbox integration verification.

## Security scans

Run these only in the checked-out project and record their actual output in the
release notes or CI summary:

```bash
python -m bandit -r src
python -m pip_audit -r requirements.lock
gitleaks detect --no-banner --redact
cd frontend && npm audit --audit-level=high
```

Optional container checks:

```bash
trivy image veritybench:local
```

OWASP ZAP baseline applies only to a locally started test server. Do not scan
external systems. If a tool is unavailable, report it as not run; absence of
findings is not a claim of vulnerability-free software.

## Security regression cases

The API suite must continue to verify password hashing, invalid credentials,
session revocation, project ownership checks, invalid scenario/agent input,
request correlation headers, and that no arbitrary execution endpoint exists.
Archive and SSRF tests are tracked as disabled-feature guards because those
features are intentionally not enabled in this MVP.
