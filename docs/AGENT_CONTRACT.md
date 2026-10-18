# Local Python agent contract

VerityBench supports custom Python agents in two explicitly selected modes:

- CLI-local evaluation keeps source code on the developer's machine.
- Remote evaluation stores a project-owned source artifact and requires the
  separate `python -m veritybench.worker` process.

The API and FastAPI process do not import custom modules. Both execution modes
require a responsive Docker daemon and a locally available digest-pinned image
in `VERITYBENCH_AGENT_IMAGE`; neither falls back to importing the agent on the
host. The remote API only queues a run until the isolated worker claims it.

## Version 1

A Python module passed to `veritybench test --agent-path PATH` must export:

1. `AGENT_CONTRACT_VERSION = 1`
2. `create_agent()` returning an object with a non-empty `name` string
3. `decide(context)` returning `veritybench_engine.AgentDecision`

The context and decision types are the existing deterministic engine types:

```python
from veritybench.agent_contract import AGENT_CONTRACT_VERSION
from veritybench_engine import AgentAction, AgentContext, AgentDecision

AGENT_CONTRACT_VERSION = 1


class MyAgent:
    name = "my-local-agent"

    def decide(self, context: AgentContext) -> AgentDecision:
        return AgentDecision(
            action=AgentAction.STOP,
            rationale="stop while this template is being customized",
        )


def create_agent() -> MyAgent:
    return MyAgent()
```

The complete safe example is at
`examples/agents/template_agent.py`. Try it with:

```bash
veritybench init
export VERITYBENCH_AGENT_IMAGE='registry.example/veritybench-agent@sha256:<64-lowercase-hex-digest>'
veritybench test --agent-path examples/agents/template_agent.py
```

The image must already be present locally because the runner always uses
`--pull=never`. It must contain Python and the installed `veritybench` and
`veritybench_engine` packages. The repository `Dockerfile` is a compatible
starting point for building an image; configure the resulting immutable image
reference, rather than a mutable tag such as `:latest`.

## Engine compatibility

`context` is an immutable `AgentContext` containing:

- `order`: the current `Order`, including status, attempt count, amount,
  currency, payment ID, and stable order idempotency key;
- `scenario`: the selected `FaultScenario`;
- `last_outcome`: the previous `PaymentOutcome`, or `None` on the first turn;
- `max_retries`: the configured retry limit.

Return an `AgentDecision` with:

- one `AgentAction`: `START_PAYMENT`, `RETRY_PAYMENT`,
  `RECONCILE_PAYMENT`, `FULFILL_ORDER`, `CANCEL_ORDER`, or `STOP`;
- a non-empty rationale of at most 2,048 characters;
- an optional non-empty idempotency key of at most 256 characters.

The adapter validates the module version, factory, name, decision type, action,
and bounded text before the deterministic order/payment engine receives a
decision. Invalid modules are refused with a structured diagnostic instead of
being imported in the FastAPI process.

## Worker behavior and limits

- Docker is preflighted before staging or executing an agent: the Docker
  executable, daemon, and exact configured image must all be available. Missing
  Docker, an unavailable daemon, a missing image, or an unpinned image fails
  clearly with no host fallback.
- The requested source must be a regular, non-symlink `.py` file without
  parent-directory traversal. VerityBench copies only that file into a private
  temporary directory. No adjacent files, directories, host working directory,
  Docker socket, or other host mounts are made available to the container.
- The container runs with `--network=none`, `--read-only`,
  `--cap-drop=ALL`, `--security-opt=no-new-privileges:true`, a non-root UID,
  `--pids-limit=128`, `--memory=256m`, `--cpus=1`, and `--pull=never`.
  The runtime receives a fixed minimal environment rather than the parent
  process environment, API session, database URL, or API secrets.

- Agent stdout/stderr is captured and counted, not mixed into the worker JSON
  protocol. Worker protocol output is capped at 256 KiB; diagnostics are
  capped at 16 KiB.
- The default wall-clock timeout is 10 seconds. Change it with `--timeout`
  when testing a local agent. A timeout kills the Docker client process and
  attempts a forced container removal; the invocation also uses `--rm`.
- Engine events are streamed as structured JSON messages internally and shown
  live by the CLI. `--json` suppresses live display so stdout remains one
  valid report JSON document.
- A timeout exits with code 124. Invalid paths, unsupported contract versions,
  invalid decisions, import/factory failures, worker protocol refusals, and
  Docker/image preflight failures exit with code 2. An evaluation that
  completes but fails independent checks exits with code 1.

## Remote registration and worker

An authenticated project can register a single Python source module through
`POST /api/v1/projects/{project_id}/agents` with `name`, `version`, and
`source`. The API stores the bytes under the configured artifact directory and
records a SHA-256 digest. It never imports, compiles, installs, or executes the
submitted source. A run refers to that immutable registration using
`agent: remote:<registration-id>`.

Run `python -m veritybench.worker` separately on a host that can read the same
artifact directory and database and that has the pinned Docker image. The
worker marks the run queued/running/terminal and persists the same event journal
used by the web UI. If the worker or Docker image is unavailable, the run is
reported as unavailable or remains queued; it is never executed in FastAPI.

## Boundary and remaining limitation

The current CLI and remote worker use a decision-only protocol: the sandbox
returns validated `AgentDecision` messages, while the trusted parent process
owns `DeterministicEngine`, the ledger, metrics, and independent evaluator. A
sandbox cannot submit a replacement report as the authoritative result. This is
still not a formal defense against a Docker/container escape; use a trusted,
pinned runtime or a stronger isolation backend such as gVisor, Kata, or a
microVM for hostile code.
