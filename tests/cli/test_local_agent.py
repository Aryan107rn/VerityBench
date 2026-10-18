from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from veritybench.agent_contract import AGENT_CONTRACT_VERSION
from veritybench.cli import app
from veritybench.local_worker import LocalWorkerError, run_local_agent
from veritybench_engine import FaultScenario, SimulationConfig

runner = CliRunner()


def _write_agent(tmp_path: Path, source: str, name: str = "agent.py") -> Path:
    path = tmp_path / name
    path.write_text(source, encoding="utf-8")
    return path


def _safe_agent_source() -> str:
    return f"""
from veritybench_engine import AgentAction, AgentContext, AgentDecision, OrderStatus, PaymentOutcome

AGENT_CONTRACT_VERSION = {AGENT_CONTRACT_VERSION}


class CustomAgent:
    name = "custom-safe-agent"

    def decide(self, context: AgentContext) -> AgentDecision:
        if context.order.status is OrderStatus.CREATED:
            return AgentDecision(AgentAction.START_PAYMENT, "start safely", context.order.idempotency_key)
        if context.order.status is OrderStatus.PAYMENT_PENDING:
            if context.last_outcome is PaymentOutcome.TIMEOUT:
                return AgentDecision(AgentAction.RECONCILE_PAYMENT, "reconcile", context.order.idempotency_key)
            return AgentDecision(AgentAction.CANCEL_ORDER, "cancel unknown state")
        if context.order.status is OrderStatus.PAID:
            return AgentDecision(AgentAction.FULFILL_ORDER, "fulfill settled payment")
        return AgentDecision(AgentAction.CANCEL_ORDER, "cancel failed or terminal state")


def create_agent() -> CustomAgent:
    return CustomAgent()
"""


def test_valid_contract_streams_structured_events_and_returns_report(tmp_path: Path) -> None:
    agent_path = _write_agent(tmp_path, _safe_agent_source())
    events: list[dict[str, object]] = []

    report = run_local_agent(
        agent_path,
        SimulationConfig(scenario=FaultScenario.TIMEOUT_AFTER_SUCCESS),
        timeout_seconds=2,
        on_event=events.append,
    )

    assert report["agent_name"] == "custom-safe-agent"
    assert report["evaluation"]["passed"] is True  # type: ignore[index]
    assert events
    assert events[0]["event_type"] == "order_created"
    assert events[-1]["event_type"] == "order_fulfilled"


def test_invalid_contract_is_refused_before_engine_execution(tmp_path: Path) -> None:
    agent_path = _write_agent(
        tmp_path,
        """
class NotAnAgent:
    name = "missing-version"

def create_agent():
    return NotAnAgent()
""",
    )

    with pytest.raises(LocalWorkerError, match="AGENT_CONTRACT_VERSION") as error:
        run_local_agent(agent_path, SimulationConfig(), timeout_seconds=2)

    assert error.value.code == "unsupported_contract"


def test_agent_exception_has_clear_diagnostic(tmp_path: Path) -> None:
    agent_path = _write_agent(
        tmp_path,
        f"""
from veritybench_engine import AgentContext, AgentDecision, AgentAction

AGENT_CONTRACT_VERSION = {AGENT_CONTRACT_VERSION}

class ExplodingAgent:
    name = "exploding-agent"
    def decide(self, context: AgentContext) -> AgentDecision:
        raise RuntimeError("intentional agent failure")

def create_agent():
    return ExplodingAgent()
""",
    )

    with pytest.raises(LocalWorkerError, match="intentional agent failure") as error:
        run_local_agent(agent_path, SimulationConfig(), timeout_seconds=2)

    assert error.value.code == "agent_exception"


def test_agent_timeout_kills_the_worker(tmp_path: Path) -> None:
    agent_path = _write_agent(
        tmp_path,
        f"""
import time
from veritybench_engine import AgentContext, AgentDecision, AgentAction

AGENT_CONTRACT_VERSION = {AGENT_CONTRACT_VERSION}

class SlowAgent:
    name = "slow-agent"
    def decide(self, context: AgentContext) -> AgentDecision:
        time.sleep(2)
        return AgentDecision(AgentAction.STOP, "never reached")

def create_agent():
    return SlowAgent()
""",
    )

    with pytest.raises(LocalWorkerError, match="exceeded") as error:
        run_local_agent(agent_path, SimulationConfig(), timeout_seconds=0.05)

    assert error.value.code == "agent_timeout"


def test_worker_does_not_forward_parent_environment_and_bounds_agent_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VERITYBENCH_TEST_SECRET", "must-not-cross-process-boundary")
    agent_path = _write_agent(
        tmp_path,
        f"""
import os
from veritybench_engine import AgentContext, AgentDecision, AgentAction, OrderStatus, PaymentOutcome

AGENT_CONTRACT_VERSION = {AGENT_CONTRACT_VERSION}

class QuietBoundaryAgent:
    name = "boundary-agent"
    def decide(self, context: AgentContext) -> AgentDecision:
        print("discarded-output" * 100000)
        assert os.environ.get("VERITYBENCH_TEST_SECRET") is None
        if context.order.status is OrderStatus.CREATED:
            return AgentDecision(AgentAction.START_PAYMENT, "start", context.order.idempotency_key)
        if context.order.status is OrderStatus.PAID:
            return AgentDecision(AgentAction.FULFILL_ORDER, "fulfill")
        if context.order.status is OrderStatus.PAYMENT_PENDING and context.last_outcome is PaymentOutcome.TIMEOUT:
            return AgentDecision(AgentAction.RECONCILE_PAYMENT, "reconcile", context.order.idempotency_key)
        return AgentDecision(AgentAction.CANCEL_ORDER, "secret was not provided")

def create_agent():
    return QuietBoundaryAgent()
""",
    )

    report = run_local_agent(agent_path, SimulationConfig(), timeout_seconds=2)

    assert report["agent_name"] == "boundary-agent"
    assert report["evaluation"]["passed"] is True  # type: ignore[index]


def test_cli_custom_agent_json_is_one_valid_report_document(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    agent_path = _write_agent(tmp_path, _safe_agent_source())
    assert runner.invoke(app, ["init"]).exit_code == 0

    result = runner.invoke(app, ["test", "--agent-path", str(agent_path), "--json"])

    assert result.exit_code == 0, result.stdout
    payload = json.loads(result.stdout)
    assert payload["agent_name"] == "custom-safe-agent"
    assert payload["evaluation"]["passed"] is True
    assert json.loads((tmp_path / "runs" / "latest.json").read_text()) == payload

    live = runner.invoke(app, ["test", "--agent-path", str(agent_path)])
    assert live.exit_code == 0, live.stdout
    assert "Event 0: order_created" in live.stdout


def test_cli_lists_agents_scenarios_and_runs_as_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["test", "--agent", "safe", "--json"]).exit_code == 0

    agents = runner.invoke(app, ["agents", "list", "--json"])
    scenarios = runner.invoke(app, ["scenarios", "list", "--json"])
    runs = runner.invoke(app, ["runs", "list", "--json"])
    shown = runner.invoke(app, ["runs", "show", "runs/latest.json", "--json"])

    assert agents.exit_code == scenarios.exit_code == runs.exit_code == shown.exit_code == 0
    assert any(item["id"] == "local-python" for item in json.loads(agents.stdout))
    assert {item["id"] for item in json.loads(scenarios.stdout)} >= {"normal", "timeout_after_success"}
    assert json.loads(runs.stdout)[0]["passed"] is True
    assert json.loads(shown.stdout)["agent_name"] == "safe-sample-agent"
