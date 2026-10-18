from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from typer.testing import CliRunner

import veritybench.cli as cli_module
import veritybench.sandbox as sandbox_module
from veritybench.agent_contract import AGENT_CONTRACT_VERSION
from veritybench.cli import app
from veritybench.local_worker import LocalWorkerError, run_local_agent, run_sandboxed_agent
from veritybench_engine import FaultScenario, SimulationConfig

runner = CliRunner()


@pytest.fixture(autouse=True)
def configured_agent_image(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VERITYBENCH_AGENT_IMAGE", f"veritybench-agent@sha256:{'a' * 64}")


@pytest.fixture
def fake_runtime(tmp_path: Path) -> tuple[tuple[str, ...], Path]:
    """Run the worker protocol locally while exercising the Docker command shape."""

    script = tmp_path / "fake-docker.py"
    log_path = tmp_path / "fake-docker.jsonl"
    source_root = Path(__file__).resolve().parents[2] / "src"
    script.write_text(
        f"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

args = sys.argv[1:]
Path({str(log_path)!r}).open("a", encoding="utf-8").write(json.dumps(args) + "\\n")
if args[:1] == ["info"] or args[:2] == ["image", "inspect"] or args[:1] == ["rm"]:
    raise SystemExit(0)
if args[:1] != ["run"]:
    raise SystemExit(2)
if any("hang-agent" in argument for argument in args):
    time.sleep(30)
mount = args[args.index("--mount") + 1]
source = next(part.split("=", 1)[1] for part in mount.split(",") if part.startswith("source="))
child_environment = os.environ.copy()
child_environment["PYTHONPATH"] = {str(source_root)!r}
decision_mode = "--decision-worker" in args
worker_mode = "--decision-worker" if decision_mode else "--worker"
if decision_mode:
    child = subprocess.Popen(
        [sys.executable, "-m", "veritybench.local_worker", worker_mode],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=child_environment,
    )
    first_message = True
    for line in sys.stdin.buffer:
        if first_message:
            init_request = json.loads(line)
            init_request["agent_path"] = source
            line = (json.dumps(init_request) + "\\n").encode("utf-8")
            first_message = False
        child.stdin.write(line)
        child.stdin.flush()
        response = child.stdout.readline()
        if not response:
            break
        sys.stdout.buffer.write(response)
        sys.stdout.buffer.flush()
    child.stdin.close()
    sys.stdout.buffer.write(child.stdout.read())
    sys.stderr.buffer.write(child.stderr.read())
    raise SystemExit(child.wait())
request = json.loads(sys.stdin.buffer.read())
request["agent_path"] = source
completed = subprocess.run(
    [sys.executable, "-m", "veritybench.local_worker", worker_mode],
    input=(json.dumps(request) + "\\n").encode("utf-8"),
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=child_environment,
    check=False,
)
sys.stdout.buffer.write(completed.stdout)
sys.stderr.buffer.write(completed.stderr)
raise SystemExit(completed.returncode)
""",
        encoding="utf-8",
    )
    return (sys.executable, str(script)), log_path


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


def test_valid_contract_streams_structured_events_and_returns_report(
    tmp_path: Path, fake_runtime: tuple[tuple[str, ...], Path]
) -> None:
    agent_path = _write_agent(tmp_path, _safe_agent_source())
    runtime_command, _ = fake_runtime
    events: list[dict[str, object]] = []

    report = run_local_agent(
        agent_path,
        SimulationConfig(scenario=FaultScenario.TIMEOUT_AFTER_SUCCESS),
        timeout_seconds=2,
        on_event=events.append,
        runtime_command=runtime_command,
    )

    assert report["agent_name"] == "custom-safe-agent"
    assert report["evaluation"]["passed"] is True  # type: ignore[index]
    assert events
    assert events[0]["event_type"] == "order_created"
    assert events[-1]["event_type"] == "order_fulfilled"


def test_invalid_contract_is_refused_before_engine_execution(
    tmp_path: Path, fake_runtime: tuple[tuple[str, ...], Path]
) -> None:
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
        run_local_agent(
            agent_path,
            SimulationConfig(),
            timeout_seconds=2,
            runtime_command=fake_runtime[0],
        )

    assert error.value.code == "unsupported_contract"


def test_agent_exception_has_clear_diagnostic(
    tmp_path: Path, fake_runtime: tuple[tuple[str, ...], Path]
) -> None:
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
        run_local_agent(
            agent_path,
            SimulationConfig(),
            timeout_seconds=2,
            runtime_command=fake_runtime[0],
        )

    assert error.value.code == "agent_exception"


def test_agent_timeout_kills_the_worker(
    tmp_path: Path, fake_runtime: tuple[tuple[str, ...], Path]
) -> None:
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
        run_local_agent(
            agent_path,
            SimulationConfig(),
            timeout_seconds=0.05,
            runtime_command=fake_runtime[0],
        )

    assert error.value.code == "agent_timeout"
    calls = [json.loads(line) for line in fake_runtime[1].read_text(encoding="utf-8").splitlines()]
    assert calls[-1][:2] == ["rm", "--force"]


def test_worker_does_not_forward_parent_environment_and_bounds_agent_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fake_runtime: tuple[tuple[str, ...], Path]
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

    report = run_local_agent(
        agent_path,
        SimulationConfig(),
        timeout_seconds=2,
        runtime_command=fake_runtime[0],
    )

    assert report["agent_name"] == "boundary-agent"
    assert report["evaluation"]["passed"] is True  # type: ignore[index]


def test_cli_custom_agent_json_is_one_valid_report_document(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_runtime: tuple[tuple[str, ...], Path],
) -> None:
    monkeypatch.chdir(tmp_path)
    agent_path = _write_agent(tmp_path, _safe_agent_source())
    runtime_command = fake_runtime[0]

    def run_with_fake_runtime(*args: object, **kwargs: object) -> dict[str, object]:
        return run_sandboxed_agent(*args, runtime_command=runtime_command, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(cli_module, "run_local_agent", run_with_fake_runtime)
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


def test_custom_agent_fails_closed_without_a_pinned_image(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fake_runtime: tuple[tuple[str, ...], Path]
) -> None:
    agent_path = _write_agent(tmp_path, _safe_agent_source())
    monkeypatch.delenv("VERITYBENCH_AGENT_IMAGE")

    with pytest.raises(LocalWorkerError, match="VERITYBENCH_AGENT_IMAGE") as error:
        run_local_agent(agent_path, SimulationConfig(), runtime_command=fake_runtime[0])

    assert error.value.code == "sandbox_image_unconfigured"
    assert not fake_runtime[1].exists()


def test_custom_agent_rejects_an_unpinned_image(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fake_runtime: tuple[tuple[str, ...], Path]
) -> None:
    agent_path = _write_agent(tmp_path, _safe_agent_source())
    monkeypatch.setenv("VERITYBENCH_AGENT_IMAGE", "veritybench-agent:latest")

    with pytest.raises(LocalWorkerError, match="sha256") as error:
        run_local_agent(agent_path, SimulationConfig(), runtime_command=fake_runtime[0])

    assert error.value.code == "sandbox_image_unpinned"
    assert not fake_runtime[1].exists()


def test_custom_agent_fails_closed_when_docker_is_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent_path = _write_agent(tmp_path, _safe_agent_source())
    monkeypatch.setattr(sandbox_module.shutil, "which", lambda _: None)

    with pytest.raises(LocalWorkerError, match="Docker is required") as error:
        run_local_agent(agent_path, SimulationConfig())

    assert error.value.code == "docker_unavailable"


def test_source_symlinks_and_parent_traversal_are_rejected(
    tmp_path: Path, fake_runtime: tuple[tuple[str, ...], Path]
) -> None:
    source = _write_agent(tmp_path, _safe_agent_source())
    symlink = tmp_path / "symlink.py"
    symlink.symlink_to(source)

    with pytest.raises(LocalWorkerError, match="symlink") as symlink_error:
        run_local_agent(symlink, SimulationConfig(), runtime_command=fake_runtime[0])
    assert symlink_error.value.code == "invalid_agent_path"

    traversed = tmp_path / "nested" / ".." / source.name
    with pytest.raises(LocalWorkerError, match="traversal") as traversal_error:
        run_local_agent(traversed, SimulationConfig(), runtime_command=fake_runtime[0])
    assert traversal_error.value.code == "invalid_agent_path"


def test_docker_invocation_is_hardened_and_mounts_only_the_staged_file(
    tmp_path: Path, fake_runtime: tuple[tuple[str, ...], Path]
) -> None:
    agent_path = _write_agent(tmp_path, _safe_agent_source())

    run_local_agent(agent_path, SimulationConfig(), runtime_command=fake_runtime[0])

    calls = [json.loads(line) for line in fake_runtime[1].read_text(encoding="utf-8").splitlines()]
    run_call = next(call for call in calls if call[0] == "run")
    assert "--pull=never" in run_call
    assert "--network=none" in run_call
    assert "--read-only" in run_call
    assert "--cap-drop=ALL" in run_call
    assert "--security-opt=no-new-privileges:true" in run_call
    assert "--user=65532:65532" in run_call
    assert "--pids-limit=128" in run_call
    assert "--memory=256m" in run_call
    assert "--cpus=1" in run_call
    assert sum(argument == "--mount" for argument in run_call) == 1
    assert not any("docker.sock" in argument for argument in run_call)
    mount = run_call[run_call.index("--mount") + 1]
    assert "destination=/veritybench-agent.py" in mount
    assert "readonly" in mount
    staged_source = next(part.split("=", 1)[1] for part in mount.split(",") if part.startswith("source="))
    assert not Path(staged_source).exists()


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
