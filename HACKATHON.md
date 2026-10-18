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
5. Open the web workspace, sign in, create a project, choose the timeout
    scenario, and show the persisted report's trace, ledger, invariants,
    findings, and JSON export. Briefly show the Datasets, Evaluators, Settings,
    and CLI guide pages to demonstrate the complete developer workspace.

## Exact CLI demo

From a clean checkout:

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
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

API terminal, from the repository root:

```bash
. .venv/bin/activate
python -m uvicorn veritybench.api.main:app --reload --port 8000
```

Frontend terminal:

```bash
cd frontend
npm ci
npm run dev
```

Open <http://localhost:5173>, then:

1. On **Overview**, select **Sign in or register**.
2. Register with an email and a password of at least 12 characters.
3. Create a project named `Hackathon demo`.
4. Open **Agent runs**.
5. Select `defective-sample-agent` and **Timeout after success**.
6. Select **Run and persist report**, then open the resulting run detail.
7. Show the failed evaluation, duplicate-charge metric, ledger entries, trace,
   failed invariant, and recommendation.
8. Run `safe-sample-agent` with the same scenario and show the passing report.
9. On the persisted run detail page, select **Export JSON**.

The workspace has an **Overview** page at `/`, **Agent runs** at `/runs`, run
detail at `/runs/:id`, plus **Datasets** at `/datasets`, **Evaluators** at
`/evaluators`, **Settings** at `/settings`, and the **CLI guide** at `/cli`.
Datasets, evaluator visibility, and appearance preferences are intentionally
browser-local; API reports remain authoritative. When no API session and project
are selected, the app falls back to explicitly labelled read-only fixtures. A
live run is only persisted after authentication and project selection.

## Judging-safe scope statement

The demo intentionally executes only the two repository-owned deterministic
sample agents: `safe-sample-agent` and `defective-sample-agent`. Uploaded
repositories, ZIP files, arbitrary Python, arbitrary HTTP agents, external
URLs, and real payment systems are disabled. The CLI and API simulate payment
behavior locally; they do not provide a hostile-code sandbox. This is a
deliberate safety boundary until a dedicated sandbox is available.

## Submission checklist

- [ ] Push the latest `main` commit.
- [ ] Include the repository URL.
- [ ] Include a short demo video or live-demo URL.
- [ ] Explain the duplicate-payment defect and independent ledger evaluator.
- [ ] Show both the CLI output and the web report.
- [ ] Mention deterministic replay and no real money/customer data.
- [ ] Mention unsupported arbitrary-code imports as an intentional safety limit.
- [ ] Do not submit generated `runs/`, `.env`, databases, or credentials.
