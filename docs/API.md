# API and integration contract

The API is versioned under `/api/v1`. All protected resources require a bearer
session returned by login. Errors use a stable shape:

```json
{"detail": "human readable message", "request_id": "..."}
```

## Public endpoints

- `GET /health` — liveness and database-independent process health.
- `GET /ready` — database readiness.
- `POST /api/v1/auth/register` — create a user and return a session.
- `POST /api/v1/auth/login` — create a session.

## Protected endpoints

- `GET /api/v1/auth/me`
- `POST /api/v1/auth/logout`
- `GET /api/v1/projects`
- `POST /api/v1/projects`
- `GET /api/v1/projects/{project_id}`
- `POST /api/v1/projects/{project_id}/runs`
- `GET /api/v1/projects/{project_id}/runs`
- `GET /api/v1/projects/{project_id}/agents` — repository agents plus explicitly
  registered remote agent metadata.
- `POST /api/v1/projects/{project_id}/agents` — store a versioned Python source
  artifact. The API stores bytes and metadata only; it never imports or executes
  the submitted source.
- `DELETE /api/v1/projects/{project_id}/agents/{agent_id}` — disable a remote
  registration without deleting historical runs.
- `GET /api/v1/runs/{run_id}`
- `GET /api/v1/runs/{run_id}/events?after_sequence=N` — ordered persisted event
  history.
- `GET /api/v1/runs/{run_id}/events/stream?after_sequence=N` — authenticated
  Server-Sent Events stream.
- `POST /api/v1/runs/{run_id}/cancel` — request cooperative cancellation.

The run request accepts a repository key (`safe` or `defective`) or a project
agent key (`remote:<agent-id>`) plus the enumerated scenario values. Remote
agent runs are queued for the separately operated `python -m veritybench.worker`
process and are never imported by FastAPI. The worker requires the same
digest-pinned Docker image policy as the local CLI. If that worker is not
running, a remote run remains visibly queued rather than falling back to API
execution. Run reports contain `agent_name`, scenario, final order state, ledger
entries, structured trace events, derived metrics, independent invariants, and
findings.

Custom Python modules can be run locally through the CLI or explicitly
registered for remote execution. The CLI and remote worker require Docker and a
digest-pinned image. The FastAPI process never imports those modules. See
[AGENT_CONTRACT.md](AGENT_CONTRACT.md) for the versioned contract, artifact
workflow, and remaining decision-protocol limitation.

## Agent contract

The first supported contract is a Python object implementing:

```python
class Agent(Protocol):
    @property
    def name(self) -> str: ...
    def decide(self, context: AgentContext) -> AgentDecision: ...
```

This is intentionally narrower than claiming compatibility with arbitrary
agent frameworks. HTTP adapters and imported projects are future interfaces and
must add authentication, request limits, SSRF protection, timeouts, and an
isolated worker before they are enabled.
