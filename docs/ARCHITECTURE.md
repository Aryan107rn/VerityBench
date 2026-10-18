# VerityBench architecture

## MVP shape

VerityBench is a modular monolith. The browser, CLI, API, shared engine, and
storage are separate interfaces in one repository; they do not duplicate the
evaluation rules.

```text
React/Vite ──HTTP──> FastAPI /api/v1 ──> SQLAlchemy repositories
                         │
                         └────────────> shared deterministic engine

Typer CLI ─────────────────────────────> shared deterministic engine
                                         │
                                         ├─ trace events
                                         ├─ simulated ledger
                                         └─ independent evaluator/report
```

### Components

- `src/veritybench_engine`: framework-neutral scenario execution, sample agent
  adapters, immutable trace/ledger models, metrics, and evaluation.
- `src/veritybench`: CLI, API settings, database models, auth, and report
  persistence. It may call the engine but never reimplements evaluation rules.
- `frontend`: React client. It consumes versioned API shapes and keeps local
  fixtures visibly labelled as demo data when the API is unavailable.
- `alembic`: migration configuration and initial schema migration.
- `tests`: unit, API, auth, and CLI regression tests.

## Data flow

1. A local CLI command or authenticated API request chooses a permitted sample
   agent and a typed `FaultScenario`.
2. `DeterministicEngine` runs only in-process for trusted, repository-owned
   sample agents. It creates a new gateway and immutable snapshots per run.
3. The evaluator reads the resulting order, ledger, and trace independently of
   agent rationale. Missing evidence is a failure or inconclusive state, never
   an implicit pass.
4. The API stores a JSON report and normalized run summary. Raw trace payloads
   remain attached to the run record for this single-instance MVP.
5. The frontend displays actual persisted reports where available and labels
   offline fixtures as demo data.

## State and persistence

Runs have explicit states: `queued`, `running`, `passed`, `failed`,
`cancelled`, `timed_out`, and `inconclusive`. The MVP executes a bounded
scenario synchronously behind a short API request; the service boundary is
designed so a queue/worker can replace the executor without changing reports.

SQLite is the default local database. SQLAlchemy models use portable types and
queries so PostgreSQL can be selected with `DATABASE_URL`. Alembic is the
schema authority; `create_all` is used only as a local convenience when the
database has no tables.

## Execution safety boundary

The MVP does not execute user source, uploaded archives, package installers,
arbitrary shell commands, model-provided tools, or user-provided URLs. Any
future untrusted runner must be a separate unprivileged worker with no Docker
socket, no host credentials, read-only base filesystem, resource limits, and
network deny-by-default policy. See the threat model before enabling it.

## Scale boundary

The API is stateless apart from the relational database and in-memory login
rate limiter. A production deployment should add a shared rate-limit store,
durable queue, artifact storage, and worker isolation before horizontal scale.
No capacity or reliability claim is made without load testing.
