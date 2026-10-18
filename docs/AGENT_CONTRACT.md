# Local Python agent contract

VerityBench supports custom Python agents for **CLI-local evaluation only**.
The API and FastAPI process do not import custom modules. The CLI starts a
separate worker process, passes it a deterministic simulation configuration,
and receives versioned JSON events and one report. This process boundary keeps
arbitrary agent code out of the API process, but it is not a hostile-code
sandbox: use only trusted local code.

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
veritybench test --agent-path examples/agents/template_agent.py
```

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

- The worker runs with a sanitized environment and does not receive the
  parent process environment, API session, database URL, or API secrets.
- Agent stdout/stderr is captured and counted, not mixed into the worker JSON
  protocol. Worker protocol output is capped at 256 KiB; diagnostics are
  capped at 16 KiB.
- The default wall-clock timeout is 10 seconds. Change it with `--timeout`
  when testing a trusted local agent.
- Engine events are streamed as structured JSON messages internally and shown
  live by the CLI. `--json` suppresses live display so stdout remains one
  valid report JSON document.
- A timeout exits with code 124. Invalid paths, unsupported contract versions,
  invalid decisions, import/factory failures, and worker protocol refusals exit
  with code 2. An evaluation that completes but fails independent checks exits
  with code 1.

The worker does not grant network access or filesystem isolation. Treat the
agent module and files beside it as trusted local code, and keep credentials
out of that directory.
