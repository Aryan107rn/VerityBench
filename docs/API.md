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
- `GET /api/v1/projects/{project_id}/agents` — repository-owned agents that
  are safe to run through the web API.
- `GET /api/v1/runs/{run_id}`
- `GET /api/v1/runs/{run_id}/events?after_sequence=N` — ordered persisted event
  history.
- `GET /api/v1/runs/{run_id}/events/stream?after_sequence=N` — authenticated
  Server-Sent Events stream.
- `POST /api/v1/runs/{run_id}/cancel` — request cooperative cancellation.

The run request accepts only `agent: safe|defective` and the enumerated local
scenario values. Unsupported integrations are rejected with HTTP 422. A run is
queued and executed by a bounded background worker that only instantiates
repository-owned agents; it is not a custom-code sandbox. Run reports contain
`agent_name`, scenario, final order state, ledger entries, structured trace
events, derived metrics, independent invariants, and findings.

Custom Python modules are currently CLI-local-only. The CLI starts a separate
bounded subprocess for `--agent-path`; the FastAPI process never imports those
modules. See [AGENT_CONTRACT.md](AGENT_CONTRACT.md) for the versioned contract
and its trusted-local-code limitation.

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
