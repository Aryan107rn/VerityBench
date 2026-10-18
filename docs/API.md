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
- `GET /api/v1/runs/{run_id}`

The run request accepts only `agent: safe|defective` and the enumerated local
scenario values. Unsupported integrations are rejected with HTTP 422. Run
reports contain `agent_name`, scenario, final order state, ledger entries,
structured trace events, derived metrics, independent invariants, and findings.

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
