# VerityBench execution threat model

## Trust boundaries

VerityBench has three execution boundaries:

1. **FastAPI API** — authenticates users, authorizes projects, stores agent
   artifacts, creates runs, and serves persisted events. It must never import or
   execute submitted Python source.
2. **Remote worker** — a separately operated process that claims project-agent
   jobs and launches the configured Docker sandbox. It needs access to the
   artifact directory and Docker runtime; do not expose that runtime to the API
   container.
3. **Agent sandbox** — an ephemeral, non-root Docker container with a pinned
   image, no network, read-only root filesystem, dropped capabilities, resource
   limits, and one read-only source-file mount.

The local CLI uses the same sandbox policy. It fails closed when Docker, the
configured image, or the required preflight is unavailable.

## Protected assets

- User sessions and bearer tokens.
- Project ownership and historical reports.
- Database files and event journals.
- Agent source artifacts and their SHA-256 identities.
- Host credentials, home directories, Docker socket, and unrelated files.
- Independent ledger and evaluator evidence.

## Current controls

- Project ownership is checked on agent registration, run creation, event
  history, streaming, cancellation, and report access.
- Submitted source is stored as data only by FastAPI and is never imported in
  the request process.
- Agent artifacts are digest-checked by the remote worker before execution.
- The sandbox uses `--network=none`, `--read-only`, `--cap-drop=ALL`,
  `no-new-privileges`, a numeric non-root user, CPU/memory/PID limits,
  `--pull=never`, and a single read-only file mount.
- Environment variables are allowlisted; parent API credentials and Docker
  client configuration are not forwarded.
- Timeouts terminate the Docker client and attempt forced container cleanup.
- Run reports are validated before API readback, and independent evaluation
  derives verdict evidence from the recorded order, ledger, and trace.

## Explicit limitations

- Ordinary Docker/runc is not a perfect hostile-code or container-escape
  boundary. Production deployments requiring a stronger guarantee should use a
  hardened rootless runtime, gVisor, Kata, Firecracker, or a managed isolated
  execution service.
- The decision-only wire protocol keeps the trusted engine, ledger, metrics, and
  evaluator outside the agent interpreter. A malicious agent can still attempt
  a Docker/container escape; it cannot replace the authoritative report merely
  by returning a claimed result.
- Remote execution is not enabled merely by registering metadata. A worker and
  pinned image must be explicitly configured; otherwise runs remain queued or
  become inconclusive rather than executing in FastAPI.
- Network access is disabled by default. Agents requiring external services are
  not supported by this contract.

## Verification expectations

The offline suite uses injected fake runtimes to verify command construction and
fail-closed behavior. A deployment must additionally run the real Docker
integration checks on a host with the selected hardened runtime. Image builds
alone do not prove filesystem, network, process, or privilege isolation.
