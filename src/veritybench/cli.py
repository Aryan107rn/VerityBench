"""The veritybench local CLI."""

from __future__ import annotations

import getpass
import json
import os
import shutil
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Annotated, Any, NoReturn

import typer

from veritybench_engine import (
    DefectiveSampleAgent,
    FaultScenario,
    SafeSampleAgent,
    SimulationConfig,
    SimulationResult,
    simulate,
)

app = typer.Typer(
    name="veritybench",
    help="Run deterministic, evidence-first AI-agent evaluations locally.",
    no_args_is_help=True,
    invoke_without_command=True,
)

CONFIG_FILE = Path("veritybench.toml")
RUNS_DIR = Path("runs")
SESSION_FILE = Path.home() / ".config" / "veritybench" / "session.json"
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


def _agent(value: str) -> SafeSampleAgent | DefectiveSampleAgent:
    if value == "safe":
        return SafeSampleAgent()
    if value == "defective":
        return DefectiveSampleAgent()
    _fail("agent must be `safe` or `defective`")


def _write_report(result: SimulationResult, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = result.to_dict()
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


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
    scenario: Annotated[str | None, typer.Option(help="Fault scenario to execute.")] = None,
    agent: Annotated[str | None, typer.Option(help="safe or defective sample agent.")] = None,
    output: Annotated[Path, typer.Option(help="Where to write the JSON report.")] = RUNS_DIR / "latest.json",
    as_json: Annotated[bool, typer.Option("--json", help="Print the complete JSON report.")] = False,
) -> None:
    """Execute one bounded local evaluation and save its evidence."""

    config = _load_config()
    project = _section(config, "project")
    selected_scenario = _scenario(scenario or str(project.get("scenario", "normal")))
    selected_agent = _agent(agent or str(project.get("agent", "safe")))
    result = simulate(
        selected_scenario,
        agent=selected_agent,
        config=SimulationConfig(scenario=selected_scenario),
    )
    _write_report(result, output)
    if as_json:
        typer.echo(json.dumps(result.to_dict(), indent=2, sort_keys=True))
    else:
        status = "PASS" if result.evaluation.passed else "FAIL"
        typer.echo(
            f"{status} {result.agent_name} / {result.scenario.value} · "
            f"{len(result.trace)} events · {len(result.evaluation.findings)} findings"
        )
        typer.echo(f"Report: {output}")
    if not result.evaluation.passed:
        raise typer.Exit(1)


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
    _write_report(defective, DEMO_DEFECTIVE_REPORT)
    _write_report(safe, DEMO_SAFE_REPORT)

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
def runs() -> None:
    """List saved local reports."""

    if not RUNS_DIR.exists():
        typer.echo("No local runs. Execute `veritybench test` first.")
        return
    reports = sorted(RUNS_DIR.glob("*.json"))
    if not reports:
        typer.echo("No local runs. Execute `veritybench test` first.")
        return
    for path in reports:
        payload = _read_report(path)
        evaluation = payload.get("evaluation", {})
        passed = isinstance(evaluation, dict) and evaluation.get("passed") is True
        typer.echo(f"{'PASS' if passed else 'FAIL'}\t{path}")


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
) -> None:
    """Run the same supported sample scenario through the authenticated API."""

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
    body = json.dumps({"scenario": selected_scenario, "agent": selected_agent}).encode("utf-8")
    base_url = _api_base_url(str(session["base_url"]))
    request = urllib.request.Request(
        f"{base_url}/api/v1/projects/{selected_project}/runs",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {session['access_token']}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # nosec B310
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError) as exc:
        _fail(f"sync request failed: {exc}", 1)
    typer.echo(json.dumps(payload, indent=2, sort_keys=True))
    if payload.get("state") != "passed":
        raise typer.Exit(1)


if __name__ == "__main__":
    app()
