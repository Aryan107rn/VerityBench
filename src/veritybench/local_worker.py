"""Docker-worker boundary for CLI-local Python agents.

The legacy report worker remains available for compatibility tests, while
production CLI/remote execution uses ``run_sandboxed_agent`` and the
decision-only protocol. In that mode the child imports only the staged user
module and returns validated decisions; the trusted parent owns the engine,
ledger, evaluator, and final report. Agent stdout/stderr is redirected and
counted rather than mixed into the protocol.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import queue
import signal
import subprocess  # nosec B404 - starts only the fixed VerityBench worker module
import sys
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from veritybench_engine import (
    Agent,
    AgentContext,
    AgentDecision,
    DeterministicEngine,
    ExecutionEvent,
    FaultScenario,
    SimulationConfig,
)

from .agent_contract import (
    AGENT_CONTRACT_VERSION,
    AgentContractError,
    create_agent_from_module,
    validate_agent,
)
from .agent_protocol import context_from_dict, context_to_dict, decision_from_dict, decision_to_dict
from .sandbox import (
    AGENT_CONTAINER_PATH,
    DockerSandbox,
    SandboxError,
    stage_agent,
    validate_agent_source,
)

WORKER_PROTOCOL_VERSION = 1
DEFAULT_TIMEOUT_SECONDS = 10.0
MAX_WORKER_OUTPUT_BYTES = 256 * 1024
MAX_WORKER_DIAGNOSTIC_BYTES = 16 * 1024
MAX_PROTOCOL_LINE_BYTES = 64 * 1024


class LocalWorkerError(RuntimeError):
    """A clear, user-facing failure from the local worker boundary."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class _CapturedStream:
    limit: int
    data: bytearray
    total_bytes: int = 0
    truncated: bool = False
    malformed_line: bool = False

    @classmethod
    def create(cls, limit: int) -> _CapturedStream:
        return cls(limit=limit, data=bytearray())

    def add(self, chunk: bytes) -> None:
        self.total_bytes += len(chunk)
        remaining = self.limit - len(self.data)
        if remaining > 0:
            self.data.extend(chunk[:remaining])
        if len(chunk) > remaining:
            self.truncated = True


class _BoundedTextStream(io.StringIO):
    """Discard agent output while retaining only bounded byte counts."""

    def __init__(self, limit: int) -> None:
        super().__init__()
        self.limit = limit
        self.total_bytes = 0
        self.truncated = False

    def write(self, value: str) -> int:
        byte_count = len(value.encode("utf-8", errors="replace"))
        self.total_bytes += byte_count
        if self.total_bytes > self.limit:
            self.truncated = True
        return len(value)

    def flush(self) -> None:
        return None


def _simulation_config_to_dict(config: SimulationConfig) -> dict[str, object]:
    return {
        "scenario": config.scenario.value,
        "order_id": config.order_id,
        "amount": config.amount,
        "currency": config.currency,
        "max_retries": config.max_retries,
        "max_steps": config.max_steps,
        "seed": config.seed,
        "parameters": dict(config.parameters),
    }


def _simulation_config_from_dict(payload: object) -> SimulationConfig:
    if not isinstance(payload, dict):
        raise LocalWorkerError("invalid_request", "worker request simulation must be an object")
    try:
        scenario = FaultScenario(str(payload["scenario"]))
        return SimulationConfig(
            scenario=scenario,
            order_id=str(payload["order_id"]),
            amount=int(payload["amount"]),
            currency=str(payload["currency"]),
            max_retries=int(payload["max_retries"]),
            max_steps=int(payload["max_steps"]),
            seed=int(payload.get("seed", 0)),
            parameters=payload.get("parameters", {}),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise LocalWorkerError("invalid_request", f"invalid worker simulation: {exc}") from exc


def _load_agent(agent_path: Path) -> Agent:
    if not agent_path.is_file():
        raise AgentContractError("agent_not_found", f"agent path is not a file: {agent_path}")
    if agent_path.suffix.lower() != ".py":
        raise AgentContractError("invalid_agent_path", "agent path must point to a .py file")

    module_hash = hashlib.sha256(str(agent_path).encode("utf-8")).hexdigest()[:16]
    module_name = f"_veritybench_local_agent_{module_hash}"
    spec = importlib.util.spec_from_file_location(module_name, agent_path)
    if spec is None or spec.loader is None:
        raise AgentContractError("invalid_module", f"cannot load Python module from {agent_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except AgentContractError:
        raise
    except Exception as exc:
        raise AgentContractError(
            "module_import_error",
            f"agent module import raised {type(exc).__name__}: {exc}",
        ) from exc
    return create_agent_from_module(module)


def _protocol_message(kind: str, payload: dict[str, object]) -> dict[str, object]:
    return {"protocol_version": WORKER_PROTOCOL_VERSION, "type": kind, **payload}


def _emit_worker_message(kind: str, payload: dict[str, object]) -> None:
    output = sys.__stdout__
    if output is None:
        return
    output.write(json.dumps(_protocol_message(kind, payload), separators=(",", ":")) + "\n")
    output.flush()


def _diagnostics(stdout: _BoundedTextStream, stderr: _BoundedTextStream) -> dict[str, object]:
    return {
        "agent_stdout_bytes": stdout.total_bytes,
        "agent_stderr_bytes": stderr.total_bytes,
        "agent_output_truncated": stdout.truncated or stderr.truncated,
    }


def _worker_main() -> int:
    stdout = _BoundedTextStream(MAX_WORKER_DIAGNOSTIC_BYTES)
    stderr = _BoundedTextStream(MAX_WORKER_DIAGNOSTIC_BYTES)
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise LocalWorkerError("invalid_request", "worker request must be a JSON object")
        if request.get("protocol_version") != WORKER_PROTOCOL_VERSION:
            raise LocalWorkerError("unsupported_protocol", "unsupported worker protocol version")
        agent_path_value = request.get("agent_path")
        if not isinstance(agent_path_value, str) or not agent_path_value:
            raise LocalWorkerError("invalid_request", "worker request agent_path must be text")
        config = _simulation_config_from_dict(request.get("simulation"))

        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            agent = _load_agent(Path(agent_path_value))

            def on_event(event: object) -> None:
                to_dict = getattr(event, "to_dict", None)
                if not callable(to_dict):
                    raise LocalWorkerError("invalid_event", "engine event did not provide to_dict()")
                event_payload = to_dict()
                if not isinstance(event_payload, dict):
                    raise LocalWorkerError("invalid_event", "engine event must serialize to an object")
                _emit_worker_message("event", {"event": event_payload})

            result = DeterministicEngine(config).run(agent, on_event=on_event)
    except AgentContractError as exc:
        _emit_worker_message(
            "error",
            {
                "error": {"code": exc.code, "message": exc.message},
                "diagnostics": _diagnostics(stdout, stderr),
            },
        )
        return 1
    except LocalWorkerError as exc:
        _emit_worker_message(
            "error",
            {
                "error": {"code": exc.code, "message": exc.message},
                "diagnostics": _diagnostics(stdout, stderr),
            },
        )
        return 1
    except Exception as exc:
        _emit_worker_message(
            "error",
            {
                "error": {"code": "worker_exception", "message": f"{type(exc).__name__}: {exc}"},
                "diagnostics": _diagnostics(stdout, stderr),
            },
        )
        return 1

    _emit_worker_message("result", {"result": result.to_dict()})
    if stdout.total_bytes or stderr.total_bytes:
        _emit_worker_message("diagnostic", {"diagnostics": _diagnostics(stdout, stderr)})
    return 0


def _decision_worker_main() -> int:
    """Serve validated decisions without owning the engine or evaluator."""

    stdout = _BoundedTextStream(MAX_WORKER_DIAGNOSTIC_BYTES)
    stderr = _BoundedTextStream(MAX_WORKER_DIAGNOSTIC_BYTES)
    try:
        first_line = sys.stdin.readline()
        if not first_line:
            raise LocalWorkerError("invalid_request", "decision worker did not receive an init message")
        request = json.loads(first_line)
        if not isinstance(request, dict):
            raise LocalWorkerError("invalid_request", "decision worker init must be an object")
        if request.get("protocol_version") != WORKER_PROTOCOL_VERSION:
            raise LocalWorkerError("unsupported_protocol", "unsupported decision protocol version")
        if request.get("type") != "init":
            raise LocalWorkerError("invalid_request", "decision worker must start with init")
        if request.get("agent_contract_version") != AGENT_CONTRACT_VERSION:
            raise AgentContractError(
                "unsupported_contract",
                f"module must declare AGENT_CONTRACT_VERSION = {AGENT_CONTRACT_VERSION}",
            )
        agent_path_value = request.get("agent_path")
        if not isinstance(agent_path_value, str) or not agent_path_value:
            raise LocalWorkerError("invalid_request", "decision worker agent_path must be text")
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            agent = _load_agent(Path(agent_path_value))
        _emit_worker_message("ready", {"name": agent.name})

        expected_sequence = 0
        for line in sys.stdin:
            payload = _parse_protocol_line(line.rstrip("\r\n"))
            if payload.get("type") != "decide":
                raise LocalWorkerError("worker_protocol_error", "decision worker expected a decide message")
            sequence = payload.get("sequence")
            if sequence != expected_sequence:
                raise LocalWorkerError("worker_protocol_error", "decision sequence is out of order")
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                context = context_from_dict(payload.get("context"))
                decision = agent.decide(context)
            _emit_worker_message(
                "decision",
                {"sequence": expected_sequence, "decision": decision_to_dict(decision)},
            )
            expected_sequence += 1
    except AgentContractError as exc:
        _emit_worker_message(
            "error",
            {"error": {"code": exc.code, "message": exc.message}, "diagnostics": _diagnostics(stdout, stderr)},
        )
        return 1
    except LocalWorkerError as exc:
        _emit_worker_message(
            "error",
            {"error": {"code": exc.code, "message": exc.message}, "diagnostics": _diagnostics(stdout, stderr)},
        )
        return 1
    except Exception as exc:
        _emit_worker_message(
            "error",
            {
                "error": {"code": "worker_exception", "message": f"{type(exc).__name__}: {exc}"},
                "diagnostics": _diagnostics(stdout, stderr),
            },
        )
        return 1
    return 0


def _read_stream(
    stream: BinaryIO,
    capture: _CapturedStream,
    lines: queue.Queue[str] | None = None,
) -> None:
    pending = bytearray()
    read_chunk = getattr(stream, "read1", stream.read)
    while True:
        chunk = read_chunk(4096)
        if not chunk:
            break
        if not isinstance(chunk, bytes):
            chunk = str(chunk).encode("utf-8", errors="replace")
        capture.add(chunk)
        if lines is None:
            continue
        pending.extend(chunk)
        while True:
            separator = pending.find(b"\n")
            if separator < 0:
                break
            line = bytes(pending[:separator]).rstrip(b"\r")
            del pending[: separator + 1]
            if len(line) > MAX_PROTOCOL_LINE_BYTES:
                capture.malformed_line = True
                continue
            try:
                lines.put_nowait(line.decode("utf-8"))
            except queue.Full:
                capture.truncated = True
        if len(pending) > MAX_PROTOCOL_LINE_BYTES:
            pending.clear()
            capture.malformed_line = True
    if lines is not None and pending:
        if len(pending) <= MAX_PROTOCOL_LINE_BYTES:
            try:
                lines.put_nowait(pending.decode("utf-8"))
            except queue.Full:
                capture.truncated = True
        else:
            capture.malformed_line = True


def _stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "posix":
        os.killpg(process.pid, signal.SIGKILL)
    else:
        process.kill()


def _parse_protocol_line(line: str) -> dict[str, object]:
    try:
        payload = json.loads(line)
    except json.JSONDecodeError as exc:
        raise LocalWorkerError("worker_protocol_error", f"worker emitted invalid JSON: {exc.msg}") from exc
    if not isinstance(payload, dict) or payload.get("protocol_version") != WORKER_PROTOCOL_VERSION:
        raise LocalWorkerError("worker_protocol_error", "worker emitted an unsupported protocol message")
    if not isinstance(payload.get("type"), str):
        raise LocalWorkerError("worker_protocol_error", "worker message type is missing")
    return payload


def run_local_agent(
    agent_path: Path,
    config: SimulationConfig,
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    on_event: Callable[[dict[str, object]], None] | None = None,
    runtime_command: Sequence[str] | None = None,
) -> dict[str, object]:
    """Run one contract agent in the configured Docker sandbox and return its report."""

    if timeout_seconds <= 0:
        raise LocalWorkerError("invalid_timeout", "timeout must be greater than zero seconds")
    try:
        validate_agent_source(agent_path)
        sandbox = DockerSandbox.from_environment(runtime_command)
        sandbox.preflight()
    except AgentContractError as exc:
        raise LocalWorkerError(exc.code, exc.message) from exc
    except SandboxError as exc:
        raise LocalWorkerError(exc.code, exc.message) from exc

    container_name = sandbox.container_name()
    process: subprocess.Popen[bytes] | None = None
    try:
        with stage_agent(agent_path) as staged_agent:
            request = {
                "protocol_version": WORKER_PROTOCOL_VERSION,
                "agent_contract_version": AGENT_CONTRACT_VERSION,
                "agent_path": AGENT_CONTAINER_PATH,
                "simulation": _simulation_config_to_dict(config),
            }
            try:
                process = subprocess.Popen(  # nosec B603 - command is the fixed Docker sandbox invocation  # noqa: S603
                    [*sandbox.command, *sandbox.run_arguments(staged_agent, container_name)],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env={"PATH": os.defpath, "LC_ALL": "C", "LANG": "C"},
                    close_fds=True,
                    start_new_session=True,
                )
            except OSError as exc:
                raise LocalWorkerError("worker_launch_failed", f"could not start Docker sandbox: {exc}") from exc

            if process.stdin is None or process.stdout is None or process.stderr is None:
                _stop_process(process)
                raise LocalWorkerError("worker_launch_failed", "Docker sandbox pipes were not created")
            try:
                process.stdin.write((json.dumps(request) + "\n").encode("utf-8"))
                process.stdin.close()
            except OSError as exc:
                _stop_process(process)
                raise LocalWorkerError("worker_launch_failed", f"could not send worker request: {exc}") from exc

            stdout_capture = _CapturedStream.create(MAX_WORKER_OUTPUT_BYTES)
            stderr_capture = _CapturedStream.create(MAX_WORKER_DIAGNOSTIC_BYTES)
            messages: queue.Queue[str] = queue.Queue(maxsize=128)
            stdout_thread = threading.Thread(
                target=_read_stream,
                args=(process.stdout, stdout_capture, messages),
                daemon=True,
            )
            stderr_thread = threading.Thread(
                target=_read_stream,
                args=(process.stderr, stderr_capture),
                daemon=True,
            )
            stdout_thread.start()
            stderr_thread.start()

            result: dict[str, object] | None = None
            worker_error: LocalWorkerError | None = None
            deadline = time.monotonic() + timeout_seconds
            while True:
                try:
                    line = messages.get(timeout=0.02)
                except queue.Empty:
                    line = None
                if line is not None and worker_error is None:
                    try:
                        payload = _parse_protocol_line(line)
                        message_type = payload["type"]
                        if message_type == "event":
                            event = payload.get("event")
                            if not isinstance(event, dict):
                                raise LocalWorkerError("worker_protocol_error", "worker event must be an object")
                            if on_event is not None:
                                on_event(event)
                        elif message_type == "result":
                            candidate = payload.get("result")
                            if not isinstance(candidate, dict):
                                raise LocalWorkerError("worker_protocol_error", "worker result must be an object")
                            result = candidate
                        elif message_type == "error":
                            error = payload.get("error")
                            if not isinstance(error, dict):
                                raise LocalWorkerError("worker_protocol_error", "worker error must be an object")
                            code = error.get("code")
                            message = error.get("message")
                            if not isinstance(code, str) or not isinstance(message, str):
                                raise LocalWorkerError("worker_protocol_error", "worker error lacks code/message")
                            worker_error = LocalWorkerError(code, message)
                        elif message_type != "diagnostic":
                            raise LocalWorkerError(
                                "worker_protocol_error", f"unknown worker message type: {message_type}"
                            )
                    except LocalWorkerError as exc:
                        worker_error = exc

                process_finished = process.poll() is not None
                streams_finished = not stdout_thread.is_alive() and not stderr_thread.is_alive()
                if process_finished and streams_finished and messages.empty():
                    break
                if time.monotonic() >= deadline:
                    _stop_process(process)
                    stdout_thread.join(timeout=1)
                    stderr_thread.join(timeout=1)
                    raise LocalWorkerError(
                        "agent_timeout",
                        f"local agent exceeded the {timeout_seconds:g}-second timeout",
                    )

            stdout_thread.join(timeout=1)
            stderr_thread.join(timeout=1)
            if stdout_capture.truncated or stdout_capture.malformed_line:
                raise LocalWorkerError(
                    "worker_output_limit",
                    f"local worker output exceeded the {MAX_WORKER_OUTPUT_BYTES} byte limit",
                )
            if worker_error is not None:
                raise worker_error
            if process.returncode != 0:
                diagnostic = stderr_capture.data.decode("utf-8", errors="replace").strip()
                suffix = f": {diagnostic[:500]}" if diagnostic else ""
                raise LocalWorkerError(
                    "worker_failed", f"local worker exited with code {process.returncode}{suffix}"
                )
            if result is None:
                raise LocalWorkerError("worker_protocol_error", "local worker exited without a result")
            return result
    except SandboxError as exc:
        raise LocalWorkerError(exc.code, exc.message) from exc
    finally:
        if process is not None and process.poll() is None:
            _stop_process(process)
        sandbox.cleanup(container_name)


def run_sandboxed_agent(
    agent_path: Path,
    config: SimulationConfig,
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    on_event: Callable[[dict[str, object]], None] | None = None,
    runtime_command: Sequence[str] | None = None,
) -> dict[str, object]:
    """Run an agent in Docker while keeping the engine/evaluator in the parent."""

    if timeout_seconds <= 0:
        raise LocalWorkerError("invalid_timeout", "timeout must be greater than zero seconds")
    try:
        validate_agent_source(agent_path)
        sandbox = DockerSandbox.from_environment(runtime_command)
        sandbox.preflight()
    except SandboxError as exc:
        raise LocalWorkerError(exc.code, exc.message) from exc

    container_name = sandbox.container_name()
    process: subprocess.Popen[bytes] | None = None
    stdout_thread: threading.Thread | None = None
    stderr_thread: threading.Thread | None = None
    try:
        with stage_agent(agent_path) as staged_agent:
            try:
                process = subprocess.Popen(  # nosec B603 - command is the fixed Docker sandbox invocation  # noqa: S603
                    [*sandbox.command, *sandbox.run_arguments(staged_agent, container_name, "decision-worker")],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env={"PATH": os.defpath, "LC_ALL": "C", "LANG": "C"},
                    close_fds=True,
                    start_new_session=True,
                )
            except OSError as exc:
                raise LocalWorkerError("worker_launch_failed", f"could not start Docker sandbox: {exc}") from exc
            if process.stdin is None or process.stdout is None or process.stderr is None:
                _stop_process(process)
                raise LocalWorkerError("worker_launch_failed", "Docker sandbox pipes were not created")
            decision_stdin = process.stdin

            stdout_capture = _CapturedStream.create(MAX_WORKER_OUTPUT_BYTES)
            stderr_capture = _CapturedStream.create(MAX_WORKER_DIAGNOSTIC_BYTES)
            messages: queue.Queue[str] = queue.Queue(maxsize=128)
            stdout_thread = threading.Thread(
                target=_read_stream, args=(process.stdout, stdout_capture, messages), daemon=True
            )
            stderr_thread = threading.Thread(
                target=_read_stream, args=(process.stderr, stderr_capture), daemon=True
            )
            stdout_thread.start()
            stderr_thread.start()
            deadline = time.monotonic() + timeout_seconds

            def wait_message() -> dict[str, object]:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        diagnostic = stderr_capture.data.decode("utf-8", errors="replace").strip()
                        suffix = f": {diagnostic[:500]}" if diagnostic else ""
                        raise LocalWorkerError(
                            "agent_timeout",
                            f"local agent exceeded the {timeout_seconds:g}-second timeout{suffix}",
                        )
                    try:
                        line = messages.get(timeout=min(0.05, remaining))
                    except queue.Empty:
                        if process is not None and process.poll() is not None and not stdout_thread.is_alive():
                            raise LocalWorkerError(
                                "worker_failed",
                                f"decision worker exited with code {process.returncode}",
                            ) from None
                        continue
                    return _parse_protocol_line(line)

            def send(payload: dict[str, object]) -> None:
                try:
                    decision_stdin.write((json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))
                    decision_stdin.flush()
                except OSError as exc:
                    raise LocalWorkerError("worker_launch_failed", "decision worker pipe closed") from exc

            send(
                {
                    "protocol_version": WORKER_PROTOCOL_VERSION,
                    "type": "init",
                    "agent_contract_version": AGENT_CONTRACT_VERSION,
                    "agent_path": AGENT_CONTAINER_PATH,
                }
            )
            ready = wait_message()
            if ready.get("type") != "ready" or not isinstance(ready.get("name"), str):
                raise LocalWorkerError("worker_protocol_error", "decision worker did not become ready")

            class DecisionProxy:
                name = str(ready["name"])

                def decide(self, context: AgentContext) -> AgentDecision:
                    sequence = getattr(self, "_sequence", 0)
                    send(
                        {
                            "protocol_version": WORKER_PROTOCOL_VERSION,
                            "type": "decide",
                            "sequence": sequence,
                            "context": context_to_dict(context),
                        }
                    )
                    response = wait_message()
                    if response.get("type") != "decision" or response.get("sequence") != sequence:
                        raise LocalWorkerError("worker_protocol_error", "decision worker response was out of order")
                    decision = decision_from_dict(response.get("decision"))
                    self._sequence = sequence + 1
                    return decision

            trusted_agent = validate_agent(DecisionProxy())

            def engine_event(event: ExecutionEvent) -> None:
                if on_event is not None:
                    on_event(event.to_dict())

            result = DeterministicEngine(config).run(trusted_agent, on_event=engine_event)
            process.stdin.close()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired as exc:
                _stop_process(process)
                raise LocalWorkerError("worker_shutdown_timeout", "decision worker did not shut down") from exc
            if stdout_capture.truncated or stdout_capture.malformed_line:
                raise LocalWorkerError("worker_output_limit", "decision worker output exceeded its limit")
            return result.to_dict()
    except AgentContractError as exc:
        raise LocalWorkerError(exc.code, exc.message) from exc
    except SandboxError as exc:
        raise LocalWorkerError(exc.code, exc.message) from exc
    finally:
        if stdout_thread is not None:
            stdout_thread.join(timeout=1)
        if stderr_thread is not None:
            stderr_thread.join(timeout=1)
        if process is not None and process.poll() is None:
            _stop_process(process)
        sandbox.cleanup(container_name)


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in {"--worker", "--decision-worker"}:
        raise SystemExit("This module is started by `veritybench test --agent-path`; it is not an agent entrypoint.")
    raise SystemExit(_worker_main() if sys.argv[1] == "--worker" else _decision_worker_main())
