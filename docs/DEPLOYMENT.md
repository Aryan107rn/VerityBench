# Deployment guide

## Local container

```bash
docker compose up --build
```

The API listens on port 8000 and the frontend on port 5173. The compose file
uses a named SQLite volume for local persistence and does not publish a
database service.

The remote worker is opt-in because it needs access to the host Docker daemon.
Build or publish a digest-pinned agent image first, then start the worker with
the Docker socket mounted only into that service:

```bash
export VERITYBENCH_AGENT_IMAGE='registry.example/veritybench-agent@sha256:<64-lowercase-hex-digest>'
export DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
docker compose --profile remote up --build
```

The API container never receives the Docker socket. The worker and API share
the `veritybench-data` volume so the worker can read the registered source
artifacts and update the same database. If the image or Docker daemon is not
available, remote runs remain queued or become inconclusive; no host-execution
fallback is enabled.

## Production-style deployment

Set `DATABASE_URL` to a PostgreSQL URL, run migrations, serve the API behind a
TLS-terminating reverse proxy, and use a separately built static frontend. Do
not expose PostgreSQL publicly. Use a secret manager for session signing and
external credentials when those integrations are eventually enabled.

```bash
alembic upgrade head
uvicorn veritybench.api.main:app --host 0.0.0.0 --port 8000
```

If a pre-Alembic local SQLite database already contains the VerityBench tables,
the initial migration recognizes that complete schema and records its baseline
without deleting data. Do not delete the database to recover from this case.

The current session design stores a hash of an opaque bearer token in the
database. Rotate/revoke sessions by deleting the session record. For multiple
API instances, move rate limiting to a shared store and put long runs behind a
durable queue before claiming horizontal scalability.

## Backup and restore

For SQLite, stop the API and copy the database file atomically. For PostgreSQL,
use the provider's encrypted backup and restore process. Verify a restore in a
separate environment before relying on it. Trace retention and project
deletion are application-level responsibilities and should be scheduled before
production use.

## Deployment checklist

- [ ] Set a production PostgreSQL URL and apply migrations.
- [ ] Configure an explicit CORS allowlist.
- [ ] Put TLS and request-size limits at the reverse proxy.
- [ ] Run the full test and dependency scan suite.
- [ ] Confirm no sample/demo data is presented as tenant data.
- [ ] Configure backups, retention, alerting, and log redaction.
- [ ] Keep arbitrary code execution disabled unless the sandbox review is complete.
- [ ] For remote agents, pin the image by digest and mount the Docker socket
      only into the isolated worker service.
