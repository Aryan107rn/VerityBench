# VerityBench hackathon demo

## One-sentence pitch

**VerityBench tests AI agents against controlled failures and verifies the
observable outcome instead of trusting the agent's success claim.**

## What to show

The strongest five-minute demo is the payment-timeout recovery story:

1. Run the deterministic CLI demo.
2. Show the defective agent receives a timeout after a successful charge and
   blindly retries, producing two ledger charges.
3. Show the evaluator marks the run as failed and recommends reusing the
   original idempotency key and reconciling provider state.
4. Show the safe agent reconciles the original payment and produces exactly one
   charge with a passing report.
5. Open the light-theme web workspace, sign in, create a project, choose the
   timeout scenario, and show the persisted report's trace, ledger, invariants,
   findings, and JSON export.

## Exact CLI demo

From a clean checkout:

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.lock
python -m pip install -e .
veritybench demo
```

Expected evidence includes:

```text
Defective timeout: FAIL (expected defect) | duplicate charges: 1
Safe recovery: PASS | duplicate charges: 0
```

The command writes two reproducible reports, which are ignored by Git:

- `runs/demo-defective-timeout.json`
- `runs/demo-safe-recovery.json`

## Exact web demo

Start the API and frontend in separate terminals:

```bash
uvicorn veritybench.api.main:app --reload --port 8000
cd frontend
npm ci
npm run dev
```

Open <http://localhost:5173>, then:

1. Select **Sign in or register**.
2. Create a project named `Hackathon demo`.
3. Open **Agent runs**.
4. Select `defective-sample-agent` and `Timeout after success`.
5. Run and persist the report.
6. Show the failed evaluation, duplicate-charge metric, ledger entries, trace,
   failed invariant, and recommendation.
7. Run `safe-sample-agent` with the same scenario and show the passing report.

The dashboard uses white surfaces, navy text, AWS-console-inspired orange
actions, blue technical links, and dense evidence panels. When no API session
exists, the UI falls back to explicitly labelled read-only fixtures.

## Judging-safe scope statement

The demo intentionally executes only repository-owned deterministic sample
agents. Uploaded repositories, ZIP files, arbitrary Python, external URLs, and
real payment systems are disabled. This avoids presenting ordinary Docker or a
web API process as a sufficient hostile-code sandbox. The architecture and
integration contract document the next safe extension point.

## Submission checklist

- [ ] Push the latest `main` commit.
- [ ] Include the repository URL.
- [ ] Include a short demo video or live-demo URL.
- [ ] Explain the duplicate-payment defect and independent ledger evaluator.
- [ ] Show both the CLI output and the web report.
- [ ] Mention deterministic replay and no real money/customer data.
- [ ] Mention unsupported arbitrary-code imports as an intentional safety limit.
- [ ] Do not submit generated `runs/`, `.env`, databases, or credentials.
