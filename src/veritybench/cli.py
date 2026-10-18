"""The veritybench local CLI."""

from __future__ import annotations

import getpass
import json
import os
import shutil
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any, NoReturn

import typer

from veritybench_engine import (
    DefectiveSampleAgent,
    DeterministicEngine,
    ExecutionEvent,
    FaultScenario,
    SafeSampleAgent,
    SimulationConfig,
    simulate,
)

from .local_worker import LocalWorkerError
from .local_worker import run_sandboxed_agent as run_local_agent

app = typer.Typer(
    name="veritybench",
    help="Run deterministic, evidence-first AI-agent evaluations locally.",
    no_args_is_help=True,
    invoke_without_command=True,
)
agents_app = typer.Typer(help="Inspect supported local agent modes.")
agent_app = typer.Typer(help="Create a compatible Python agent.")
scenarios_app = typer.Typer(help="Inspect deterministic evaluation scenarios.")
runs_app = typer.Typer(help="List and inspect saved local reports.", invoke_without_command=True)
app.add_typer(agents_app, name="agents")
app.add_typer(agent_app, name="agent")
app.add_typer(scenarios_app, name="scenarios")
app.add_typer(runs_app, name="runs")

CONFIG_FILE = Path("veritybench.toml")
RUNS_DIR = Path("runs")
SESSION_FILE = Path.home() / ".config" / "veritybench" / "session.json"
AGENT_TEMPLATE = '''"""VerityBench Python agent starter."""

from veritybench_engine import AgentAction, AgentContext, AgentDecision, OrderStatus, PaymentOutcome

AGENT_CONTRACT_VERSION = 1


class MyAgent:
    name = "my-agent"

    def decide(self, context: AgentContext) -> AgentDecision:
        if context.order.status is OrderStatus.CREATED:
            return AgentDecision(
                action=AgentAction.START_PAYMENT,
                idempotency_key=context.order.idempotency_key,
                rationale="start payment with a stable idempotency key",
            )
        if context.order.status is OrderStatus.PAYMENT_PENDING and context.last_outcome is PaymentOutcome.TIMEOUT:
            return AgentDecision(
                action=AgentAction.RECONCILE_PAYMENT,
                idempotency_key=context.order.idempotency_key,
                rationale="reconcile an uncertain payment before retrying",
            )
        if context.order.status is OrderStatus.PAID:
            return AgentDecision(action=AgentAction.FULFILL_ORDER, rationale="fulfill a settled payment")
        return AgentDecision(action=AgentAction.CANCEL_ORDER, rationale="stop on an unsafe or failed state")


def create_agent() -> MyAgent:
    return MyAgent()
'''
DEMO_DEFECTIVE_REPORT = RUNS_DIR / "demo-defective-timeout.json"
DEMO_SAFE_REPORT = RUNS_DIR / "demo-safe-recovery.json"


def _fail(message: str, code: int = 2) -> NoReturn:
    typer.echo(f"Error: {message}", err=True)
    raise typer.Exit(code)


def _load_config() -> dict[str, Any]:
    if not CONFIG_FILE.exists():
        _fail("veritybench.toml is missing; run `veritybench init` first")
    try:
        with CONFIG_FILE.open("rb") as handle:
            return tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        _fail(f"cannot read {CONFIG_FILE}: {exc}")


def _section(config: dict[str, Any], name: str) -> dict[str, Any]:
    value = config.get(name)
    return value if isinstance(value, dict) else {}


def _scenario(value: str) -> FaultScenario:
    try:
        return FaultScenario(value)
    except ValueError:
        choices = ", ".join(item.value for item in FaultScenario)
        _fail(f"unsupported scenario {value!r}; choose one of: {choices}")


def _scenarios(value: str) -> list[FaultScenario]:
    if value == "all":
        return list(FaultScenario)
    return [_scenario(value)]


def _agent(value: str) -> SafeSampleAgent | DefectiveSampleAgent:
    if value == "safe":
        return SafeSampleAgent()
    if value == "defective":
        return DefectiveSampleAgent()
    _fail("agent must be `safe` or `defective`")


def _write_report(payload: dict[str, object], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _report_passed(payload: dict[str, object]) -> bool:
    evaluation = payload.get("evaluation")
    return isinstance(evaluation, dict) and evaluation.get("passed") is True


def _report_trace_length(payload: dict[str, object]) -> int:
    trace = payload.get("trace")
    return len(trace) if isinstance(trace, list) else 0


def _findings_count(payload: dict[str, object]) -> int:
    evaluation = payload.get("evaluation")
    findings = evaluation.get("findings") if isinstance(evaluation, dict) else None
    return len(findings) if isinstance(findings, list) else 0


def _suite_payload(results: list[dict[str, object]]) -> dict[str, object]:
    """Combine independent scenario reports without inventing a new verdict rule."""

    if not results:
        _fail("scenario suite produced no results", 1)
    first = results[0]
    metrics: dict[str, int] = {}
    for result in results:
        result_metrics = result.get("metrics")
        if not isinstance(result_metrics, dict):
            continue
        for key, value in result_metrics.items():
            if isinstance(key, str) and isinstance(value, int | float):
                metrics[key] = metrics.get(key, 0) + int(value)
    invariants: list[dict[str, object]] = []
    findings: list[object] = []
    for result in results:
        scenario = str(result.get("scenario", "unknown"))
        evaluation = result.get("evaluation")
        if not isinstance(evaluation, dict):
            continue
        invariant_values = evaluation.get("invariants")
        if isinstance(invariant_values, list):
            for invariant in invariant_values:
                if isinstance(invariant, dict):
                    invariants.append({**invariant, "name": f"{scenario}: {invariant.get('name', 'invariant')}"})
        finding_values = evaluation.get("findings")
        if isinstance(finding_values, list):
            findings.extend(finding_values)
    trace: list[dict[str, object]] = []
    for result in results:
        result_trace = result.get("trace")
        if isinstance(result_trace, list):
            trace.extend(event for event in result_trace if isinstance(event, dict))
    return {
        "schema_version": 1,
        "suite": True,
        "agent_name": first.get("agent_name"),
        "scenario": "all",
        "results": results,
        "trace": trace,
        "metrics": metrics,
        "evaluation": {
            "passed": all(_report_passed(result) for result in results),
            "invariants": invariants,
            "findings": findings,
        },
    }


def _display_live_event(event: dict[str, object]) -> None:
    event_type = event.get("event_type", "unknown")
    index = event.get("index", "?")
    typer.echo(f"Event {index}: {event_type}")


def _display_engine_event(event: ExecutionEvent) -> None:
    _display_live_event(event.to_dict())


def _api_base_url(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        _fail("API base URL must be an http(s) URL without embedded credentials")
    return value.rstrip("/")


@app.callback()
def root(
    version: Annotated[bool, typer.Option("--version", help="Show the CLI version and exit.")] = False,
) -> None:
    if version:
        typer.echo("veritybench 0.1.0")
        raise typer.Exit()


@app.command()
def init(
    force: Annotated[bool, typer.Option("--force", help="Replace the local configuration file.")] = False,
) -> None:
    """Create a safe local project configuration."""

    if CONFIG_FILE.exists() and not force:
        _fail(f"{CONFIG_FILE} already exists; pass --force only to replace it")
    CONFIG_FILE.write_text(
        """# VerityBench local configuration\n[project]\nname = \"sample-order-agent\"\nagent = \"safe\"\nscenario = \"normal\"\n\n[api]\nbase_url = \"http://localhost:8000\"\nproject_id = \"\"\n""",
        encoding="utf-8",
    )
    RUNS_DIR.mkdir(exist_ok=True)
    typer.echo(f"Initialized {CONFIG_FILE} and {RUNS_DIR}/")


@app.command()
def validate() -> None:
    """Validate local configuration without running an agent."""

    config = _load_config()
    project = config.get("project")
    if not isinstance(project, dict):
        _fail("[project] section is required")
    agent = project.get("agent", "safe")
    scenario = project.get("scenario", "normal")
    if agent not in {"safe", "defective"}:
        _fail("[project].agent must be safe or defective")
    _scenario(str(scenario))
    typer.echo(f"Configuration valid: agent={agent}, scenario={scenario}")


@app.command()
def test(
    scenario: Annotated[str | None, typer.Option(help="Fault scenario to execute, or all.")] = None,
    agent: Annotated[str | None, typer.Option(help="safe or defective sample agent.")] = None,
    agent_path: Annotated[
        Path | None,
        typer.Option(
            "--agent-path",
            help="Path to a version-1 Python agent; requires Docker and a pinned VERITYBENCH_AGENT_IMAGE.",
        ),
    ] = None,
    timeout: Annotated[float, typer.Option(help="Local-agent subprocess timeout in seconds.")] = 10.0,
    output: Annotated[Path, typer.Option(help="Where to write the JSON report.")] = RUNS_DIR / "latest.json",
    as_json: Annotated[bool, typer.Option("--json", help="Print the complete JSON report.")] = False,
) -> None:
    """Execute one bounded local evaluation and save its evidence.

    ``--agent-path`` runs a documented Python agent in a hardened Docker
    container. Docker is required; it is intentionally unavailable to API
    executions.
    """

    config = _load_config()
    project = _section(config, "project")
    selected_scenarios = _scenarios(scenario or str(project.get("scenario", "normal")))
    if agent_path is not None and agent is not None:
        _fail("--agent and --agent-path are mutually exclusive")

    payloads: list[dict[str, object]] = []
    for selected_scenario in selected_scenarios:
        simulation_config = SimulationConfig(scenario=selected_scenario)
        if agent_path is not None:
            local_callback = None if as_json else _display_live_event
            try:
                payload = run_local_agent(
                    agent_path,
                    simulation_config,
                    timeout_seconds=timeout,
                    on_event=local_callback,
                )
            except LocalWorkerError as exc:
                exit_code = 124 if exc.code == "agent_timeout" else 2
                _fail(f"{exc.code}: {exc.message}", exit_code)
        else:
            selected_agent = _agent(agent or str(project.get("agent", "safe")))
            engine_callback: Callable[[ExecutionEvent], None] | None = (
                None if as_json else _display_engine_event
            )
            result = DeterministicEngine(simulation_config).run(selected_agent, on_event=engine_callback)
            payload = result.to_dict()
        payloads.append(payload)

    payload = payloads[0] if len(payloads) == 1 else _suite_payload(payloads)

    _write_report(payload, output)
    if as_json:
        typer.echo(json.dumps(payload, indent=2, sort_keys=True))
    else:
        status = "PASS" if _report_passed(payload) else "FAIL"
        typer.echo(
            f"{status} {payload.get('agent_name')} / {payload.get('scenario')} · "
            f"{_report_trace_length(payload)} events · "
            f"{_findings_count(payload)} findings"
        )
        typer.echo(f"Report: {output}")
    if not _report_passed(payload):
        raise typer.Exit(1)


@agent_app.command("init")
def init_agent(
    path: Annotated[Path, typer.Argument(help="Python file or directory for the starter agent.")],
    force: Annotated[bool, typer.Option("--force", help="Replace an existing starter file.")] = False,
) -> None:
    """Create a valid version-1 Python agent starter module."""

    target = path / "agent.py" if path.suffix.lower() != ".py" else path
    if target.exists() and not force:
        _fail(f"agent file already exists: {target}; pass --force to replace it")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(AGENT_TEMPLATE, encoding="utf-8")
    typer.echo(f"Created {target}")


@agents_app.command("list")
def list_agents(
    as_json: Annotated[bool, typer.Option("--json", help="Print a JSON agent catalog.")] = False,
) -> None:
    """List sample agents and the CLI-local Python adapter."""

    agents = [
        {
            "id": "safe",
            "name": "safe-sample-agent",
            "kind": "sample",
            "scope": "cli-and-api",
            "description": "Reconciles uncertain payments with the original idempotency key.",
        },
        {
            "id": "defective",
            "name": "defective-sample-agent",
            "kind": "sample",
            "scope": "cli-and-api",
            "description": "Intentionally retries a lost response with a new key.",
        },
        {
            "id": "local-python",
            "name": "local Python contract agent",
            "kind": "python-module",
            "scope": "cli-local-only",
            "description": "Runs --agent-path in hardened Docker; never runs in FastAPI.",
        },
    ]
    if as_json:
        typer.echo(json.dumps(agents, indent=2, sort_keys=True))
        return
    for item in agents:
        typer.echo(f"{item['id']}: {item['name']} [{item['scope']}]")
        typer.echo(f"  {item['description']}")


@scenarios_app.command("list")
def list_scenarios(
    as_json: Annotated[bool, typer.Option("--json", help="Print a JSON scenario catalog.")] = False,
) -> None:
    """List the deterministic payment scenarios."""

    descriptions = {
        "normal": "The payment succeeds normally.",
        "timeout_after_success": "The charge succeeds but the response is lost.",
        "malformed_response": "The provider response cannot be read.",
        "temporary_failure": "The first payment attempt fails temporarily.",
        "unrecoverable_failure": "Every payment attempt remains unsuccessful.",
    }
    scenarios = [
        {"id": scenario.value, "description": descriptions[scenario.value]}
        for scenario in FaultScenario
    ]
    if as_json:
        typer.echo(json.dumps(scenarios, indent=2, sort_keys=True))
        return
    for item in scenarios:
        typer.echo(f"{item['id']}: {item['description']}")


@app.command()
def demo() -> None:
    """Run the timeout defect and safe recovery demo in one command.

    This expected-failure demonstration exits successfully after writing both
    reports, so it can be used as a concise hackathon evidence workflow.
    """

    scenario = FaultScenario.TIMEOUT_AFTER_SUCCESS
    defective = simulate(
        scenario,
        agent=DefectiveSampleAgent(),
        config=SimulationConfig(scenario=scenario),
    )
    safe = simulate(
        scenario,
        agent=SafeSampleAgent(),
        config=SimulationConfig(scenario=scenario),
    )
    _write_report(defective.to_dict(), DEMO_DEFECTIVE_REPORT)
    _write_report(safe.to_dict(), DEMO_SAFE_REPORT)

    typer.echo("VerityBench demo evidence")
    for label, result, output in (
        ("Defective timeout", defective, DEMO_DEFECTIVE_REPORT),
        ("Safe recovery", safe, DEMO_SAFE_REPORT),
    ):
        status = "PASS" if result.evaluation.passed else "FAIL (expected defect)"
        typer.echo(
            f"- {label}: {status} | duplicate charges: {result.metrics.duplicate_charges}"
        )
        recommendation = next(
            (
                finding.recommendation
                for finding in result.evaluation.findings
                if finding.code == "DUPLICATE_CHARGE"
            ),
            None,
        )
        if recommendation is None and result.evaluation.findings:
            recommendation = result.evaluation.findings[0].recommendation
        typer.echo(
            "  Recommendation: "
            + (recommendation or "preserve the original idempotency key during recovery.")
        )
        typer.echo(f"  Report: {output}")


def _read_report(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _fail(f"cannot read report {path}: {exc}")
    if not isinstance(payload, dict):
        _fail("report root must be a JSON object")
    return payload


def _report_summary(path: Path, payload: dict[str, Any]) -> dict[str, object]:
    return {
        "path": str(path),
        "agent_name": payload.get("agent_name"),
        "scenario": payload.get("scenario"),
        "passed": _report_passed(payload),
        "metrics": payload.get("metrics", {}),
    }


def _report_paths() -> list[Path]:
    if not RUNS_DIR.exists():
        return []
    return sorted(RUNS_DIR.glob("*.json"))


def _list_reports(as_json: bool = False) -> None:
    reports = _report_paths()
    if as_json:
        summaries = [_report_summary(path, _read_report(path)) for path in reports]
        typer.echo(json.dumps(summaries, indent=2, sort_keys=True))
        return
    if not reports:
        typer.echo("No local runs. Execute `veritybench test` first.")
        return
    for path in reports:
        report_payload = _read_report(path)
        typer.echo(f"{'PASS' if _report_passed(report_payload) else 'FAIL'}\t{path}")


@runs_app.callback()
def runs_group(
    context: typer.Context,
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON when listing runs.")] = False,
) -> None:
    """List saved local reports, or use ``runs show PATH`` for one report."""

    if context.invoked_subcommand is None:
        _list_reports(as_json=as_json)


@runs_app.command("list")
def list_runs(
    as_json: Annotated[bool, typer.Option("--json", help="Print a JSON run list.")] = False,
) -> None:
    """List saved local reports."""

    _list_reports(as_json=as_json)


@runs_app.command("show")
def show_run(
    path: Annotated[Path, typer.Argument(help="JSON report path.")] = RUNS_DIR / "latest.json",
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON instead of a summary.")] = False,
) -> None:
    """Show one saved local report."""

    payload = _read_report(path)
    if as_json:
        typer.echo(json.dumps(payload, indent=2, sort_keys=True))
        return
    evaluation = payload.get("evaluation", {})
    metrics = payload.get("metrics", {})
    passed = _report_passed(payload)
    typer.echo(f"{'PASS' if passed else 'FAIL'} {payload.get('agent_name')} / {payload.get('scenario')}")
    typer.echo(f"Metrics: {json.dumps(metrics, sort_keys=True)}")
    findings = evaluation.get("findings", []) if isinstance(evaluation, dict) else []
    for finding in findings:
        if isinstance(finding, dict):
            typer.echo(f"- {finding.get('code')}: {finding.get('title')}")
            typer.echo(f"  Evidence: {', '.join(map(str, finding.get('evidence', [])))}")
            typer.echo(f"  Recommendation: {finding.get('recommendation')}")


@app.command()
def report(
    path: Annotated[Path, typer.Argument(help="JSON report path.")] = RUNS_DIR / "latest.json",
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON instead of a summary.")] = False,
) -> None:
    """Read a saved report and show its evidence-based findings."""

    payload = _read_report(path)
    if as_json:
        typer.echo(json.dumps(payload, indent=2, sort_keys=True))
        return
    evaluation = payload.get("evaluation", {})
    metrics = payload.get("metrics", {})
    passed = bool(evaluation.get("passed")) if isinstance(evaluation, dict) else False
    typer.echo(f"{'PASS' if passed else 'FAIL'} {payload.get('agent_name')} / {payload.get('scenario')}")
    typer.echo(f"Metrics: {json.dumps(metrics, sort_keys=True)}")
    findings = evaluation.get("findings", []) if isinstance(evaluation, dict) else []
    for finding in findings:
        if isinstance(finding, dict):
            typer.echo(f"- {finding.get('code')}: {finding.get('title')}")
            typer.echo(f"  Evidence: {', '.join(map(str, finding.get('evidence', [])))}")
            typer.echo(f"  Recommendation: {finding.get('recommendation')}")


@app.command()
def export(
    path: Annotated[Path, typer.Argument(help="Saved JSON report path.")] = RUNS_DIR / "latest.json",
    output: Annotated[Path, typer.Option(help="Destination JSON path.")] = Path("report.json"),
) -> None:
    """Copy a validated report to a named export path."""

    _read_report(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, output)
    typer.echo(f"Exported {path} to {output}")


def _session_path() -> Path:
    SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
    return SESSION_FILE


@app.command()
def login(
    base_url: Annotated[str, typer.Option(help="VerityBench API base URL.")] = "http://localhost:8000",
) -> None:
    """Log in to an API without placing the password in shell history."""

    email = typer.prompt("Email")
    password = getpass.getpass("Password: ")
    base_url = _api_base_url(base_url)
    body = json.dumps({"email": email, "password": password}).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/api/v1/auth/login",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:  # nosec B310
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError) as exc:
        _fail(f"login request failed: {exc}", 1)
    session_file = _session_path()
    session_file.write_text(
        json.dumps({"base_url": base_url.rstrip("/"), "access_token": payload["access_token"]}) + "\n",
        encoding="utf-8",
    )
    os.chmod(session_file, 0o600)
    typer.echo(f"Logged in; credentials stored with mode 0600 at {session_file}")


@app.command()
def sync(
    project_id: Annotated[str | None, typer.Option(help="API project ID; defaults to local config.")] = None,
    scenario: Annotated[str | None, typer.Option(help="Scenario to execute on the API.")] = None,
    agent: Annotated[str | None, typer.Option(help="safe or defective sample agent.")] = None,
    wait_timeout: Annotated[float, typer.Option(help="Maximum seconds to wait for the remote run.")] = 60.0,
) -> None:
    """Run a supported sample scenario and wait for its terminal API result."""

    config = _load_config()
    project = _section(config, "project")
    api_config = _section(config, "api")
    selected_project = project_id or str(api_config.get("project_id", ""))
    if not selected_project:
        _fail("project ID is required; set [api].project_id or pass --project-id")
    if not SESSION_FILE.exists():
        _fail("not logged in; run `veritybench login` first")
    session = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
    selected_scenario = scenario or str(project.get("scenario", "normal"))
    selected_agent = agent or str(project.get("agent", "safe"))
    if wait_timeout <= 0:
        _fail("wait timeout must be greater than zero seconds")
    body = json.dumps({"scenario": selected_scenario, "agent": selected_agent}).encode("utf-8")
    base_url = _api_base_url(str(session["base_url"]))
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {session['access_token']}"}
    request = urllib.request.Request(
        f"{base_url}/api/v1/projects/{selected_project}/runs",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # nosec B310
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError) as exc:
        _fail(f"sync request failed: {exc}", 1)
    run_id = payload.get("id")
    if not isinstance(run_id, str) or not run_id:
        _fail("sync response did not include a run id", 1)

    terminal_states = {"passed", "failed", "cancelled", "timed_out", "inconclusive"}
    deadline = time.monotonic() + wait_timeout
    while payload.get("state") not in terminal_states and time.monotonic() < deadline:
        time.sleep(0.25)
        status_request = urllib.request.Request(
            f"{base_url}/api/v1/runs/{urllib.parse.quote(run_id, safe='')}",
            headers={"Authorization": f"Bearer {session['access_token']}"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(status_request, timeout=10) as response:  # nosec B310
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, json.JSONDecodeError) as exc:
            _fail(f"sync status request failed: {exc}", 1)

    if payload.get("state") not in terminal_states:
        _fail(f"remote run {run_id} did not finish within {wait_timeout:g} seconds", 124)
    typer.echo(json.dumps(payload, indent=2, sort_keys=True))
    if payload.get("state") != "passed":
        raise typer.Exit(1)


if __name__ == "__main__":
    app()
