from __future__ import annotations

import json
import re
from io import StringIO
from pathlib import Path
from typing import Any

import pytest
from rich.console import Console
from typer.testing import CliRunner

from veritybench.cli import app
from veritybench.terminal_report import render_report

runner = CliRunner(mix_stderr=False)
REPORT_COMMANDS = [
    pytest.param(["report"], id="report"),
    pytest.param(["runs", "show"], id="show"),
]
REPORT_LABELS = (
    "VerityBench",
    "Test agents. Trust the evidence.",
    "Metrics",
    "Checks",
    "Findings",
    "Report:",
)


@pytest.fixture(autouse=True)
def terminal_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("FORCE_COLOR", "CLICOLOR_FORCE", "NO_COLOR"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("COLUMNS", "120")
    monkeypatch.setenv("LINES", "40")
    monkeypatch.setenv("TERM", "xterm-256color")


def _payload(*, passed: bool = False) -> dict[str, Any]:
    """Keep check evidence distinct from finding evidence so neither can be omitted."""
    return {
        "agent_name": "safe-agent" if passed else "defective-agent",
        "scenario": "timeout_after_success",
        "trace": [],
        "metrics": {"payment_attempts": 1 if passed else 2, "duplicate_charges": 0 if passed else 1},
        "evaluation": {
            "passed": passed,
            "invariants": [
                {"name": "one charge per order", "passed": passed, "evidence": ["check-ledger-token"]}
            ],
            "findings": (
                []
                if passed
                else [
                    {
                        "code": "DUPLICATE_CHARGE",
                        "severity": "error",
                        "title": "Order was charged twice",
                        "evidence": ["finding-ledger-token"],
                        "recommendation": "Reuse the original idempotency key.",
                    }
                ]
            ),
        },
    }


def _render(payload: dict[str, Any], *, width: int = 120, path: Path = Path("report.json")) -> str:
    stream = StringIO()
    console = Console(file=stream, width=width, force_terminal=False, color_system=None)
    render_report(payload, path, console=console)
    return stream.getvalue()


def _assert_visible(output: str, *texts: str) -> None:
    """Ignore wrapping and box borders, but require the complete report text."""
    flattened = re.sub(r"[\s\u2500-\u257f]+", "", output)
    for text in texts:
        assert re.sub(r"\s+", "", text) in flattened, output


def _assert_no_controls(output: str) -> None:
    assert not any(
        (ord(char) < 32 and char not in "\n\t") or 127 <= ord(char) <= 159
        for char in output
    ), repr(output)


def _assert_metric(output: str, name: str, value: int) -> None:
    readable = output.lower().replace("_", " ")
    assert re.search(rf"\b{re.escape(name)}\b[^\n]*\b{value}\b", readable), output


def _assert_scenario_verdict(output: str, scenario: str, verdict: str) -> None:
    # A scenario row must associate its own verdict with its name, not just
    # repeat the suite's aggregate verdict or list scenario names alone.
    assert any(
        scenario in line and re.search(rf"\b{verdict}\b", line)
        for line in output.splitlines()
    ), output


@pytest.mark.parametrize(
    ("agent", "verdict", "exit_code"), [("safe", "PASS", 0), ("defective", "FAIL", 1)]
)
def test_default_test_renders_a_branded_report(
    cli_cwd: Path, agent: str, verdict: str, exit_code: int
) -> None:
    assert runner.invoke(app, ["init"]).exit_code == 0
    result = runner.invoke(
        app, ["test", "--scenario", "timeout_after_success", "--agent", agent], color=True
    )

    assert result.exit_code == exit_code, result.output
    _assert_visible(result.stdout, *REPORT_LABELS, verdict, f"{agent}-sample-agent", "runs/latest.json")
    _assert_metric(result.stdout, "duplicate charges", int(agent == "defective"))
    assert (cli_cwd / "runs/latest.json").is_file()
    if agent == "safe":
        assert "No findings." in result.stdout
    else:
        _assert_visible(
            result.stdout, "DUPLICATE_CHARGE", "Evidence:", "Recommendation:", "idempotency key"
        )


@pytest.mark.parametrize("command", REPORT_COMMANDS)
@pytest.mark.parametrize(("agent", "verdict"), [("safe", "PASS"), ("defective", "FAIL")])
def test_report_and_show_display_saved_evaluator_evidence(
    cli_cwd: Path, command: list[str], agent: str, verdict: str
) -> None:
    assert runner.invoke(app, ["init"]).exit_code == 0
    created = runner.invoke(
        app, ["test", "--scenario", "timeout_after_success", "--agent", agent, "--json"]
    )
    assert created.exit_code == (0 if agent == "safe" else 1), created.output
    path = cli_cwd / "runs/latest.json"
    saved = path.read_bytes()
    payload = json.loads(saved)

    shown = runner.invoke(app, [*command, "runs/latest.json"], color=True)

    # Reading a failed report still succeeds; its verdict is report content.
    assert shown.exit_code == 0, shown.output
    _assert_visible(
        shown.stdout, *REPORT_LABELS, verdict,
        payload["agent_name"], payload["scenario"], "runs/latest.json",
    )
    for check in payload["evaluation"]["invariants"]:
        _assert_visible(shown.stdout, check["name"], *check["evidence"])
    for finding in payload["evaluation"]["findings"]:
        _assert_visible(
            shown.stdout, finding["code"], finding["title"],
            *finding["evidence"], finding["recommendation"],
        )
    if agent == "safe":
        assert "No findings." in shown.stdout
    else:
        _assert_visible(shown.stdout, "Evidence:", "Recommendation:")
    _assert_no_controls(shown.stdout)
    assert path.read_bytes() == saved


def test_renderer_includes_check_evidence_and_complete_finding_details() -> None:
    output = _render(_payload())

    _assert_visible(
        output, *REPORT_LABELS, "FAIL", "one charge per order", "check-ledger-token",
        "DUPLICATE_CHARGE", "Order was charged twice", "Evidence:", "finding-ledger-token",
        "Recommendation:", "Reuse the original idempotency key.", "report.json",
    )
    assert re.search(r"\berror\b", output, re.IGNORECASE), output
    assert "No findings." not in output
    _assert_metric(output, "payment attempts", 2)
    _assert_metric(output, "duplicate charges", 1)


@pytest.mark.parametrize("agent", ["safe", "defective"])
def test_suite_commands_show_each_scenarios_own_verdict(cli_cwd: Path, agent: str) -> None:
    assert runner.invoke(app, ["init"]).exit_code == 0
    tested = runner.invoke(app, ["test", "--scenario", "all", "--agent", agent], color=True)
    assert tested.exit_code == (0 if agent == "safe" else 1), tested.output
    payload = json.loads((cli_cwd / "runs/latest.json").read_text(encoding="utf-8"))
    assert len(payload["results"]) >= 13

    outputs = [tested.stdout]
    for command in (["report"], ["runs", "show"]):
        shown = runner.invoke(app, [*command, "runs/latest.json"], color=True)
        assert shown.exit_code == 0, shown.output
        outputs.append(shown.stdout)
    for output in outputs:
        _assert_visible(output, *REPORT_LABELS)
        for scenario in payload["results"]:
            verdict = "PASS" if scenario["evaluation"]["passed"] else "FAIL"
            _assert_scenario_verdict(output, scenario["scenario"], verdict)


def test_suite_results_are_visible_even_without_scenario_prefixed_checks() -> None:
    passing = _payload(passed=True)
    failing = _payload()
    passing["scenario"] = "normal"
    for result in (passing, failing):
        result["evaluation"]["invariants"] = []
        result["evaluation"]["findings"] = []
    payload = {
        "suite": True,
        "agent_name": "suite-agent",
        "scenario": "all",
        "results": [passing, failing],
        "metrics": {},
        "evaluation": {"passed": False, "invariants": [], "findings": []},
    }

    output = _render(payload)

    _assert_scenario_verdict(output, "normal", "PASS")
    _assert_scenario_verdict(output, "timeout_after_success", "FAIL")


def test_demo_renders_both_branded_reports(cli_cwd: Path) -> None:
    result = runner.invoke(app, ["demo"], color=True)

    assert result.exit_code == 0, result.output
    _assert_visible(
        result.stdout, *REPORT_LABELS, "PASS", "FAIL", "safe-sample-agent", "defective-sample-agent",
        "DUPLICATE_CHARGE", "Evidence:", "Recommendation:", "idempotency key",
        "runs/demo-defective-timeout.json", "runs/demo-safe-recovery.json", "No findings.",
    )
    assert (cli_cwd / "runs/demo-defective-timeout.json").is_file()
    assert (cli_cwd / "runs/demo-safe-recovery.json").is_file()


@pytest.mark.parametrize(
    ("agent", "scenario"),
    [
        ("safe", "normal"),
        ("defective", "timeout_after_success"),
        ("safe", "all"),
        ("defective", "all"),
    ],
)
def test_json_commands_are_byte_equivalent_to_saved_reports(
    cli_cwd: Path, agent: str, scenario: str
) -> None:
    assert runner.invoke(app, ["init"]).exit_code == 0
    tested = runner.invoke(
        app,
        ["test", "--agent", agent, "--scenario", scenario, "--output", "runs/machine.json", "--json"],
        color=True,
        env={"FORCE_COLOR": "1"},
    )
    assert tested.exit_code == (0 if agent == "safe" else 1), tested.output
    path = cli_cwd / "runs/machine.json"
    saved = path.read_bytes()
    results = [tested]
    for command in (["report"], ["runs", "show"]):
        shown = runner.invoke(
            app, [*command, "runs/machine.json", "--json"], color=True, env={"FORCE_COLOR": "1"}
        )
        assert shown.exit_code == 0, shown.output
        results.append(shown)
    for result in results:
        assert result.stdout_bytes == saved
        assert result.stderr_bytes == b""
        assert json.loads(result.stdout) == json.loads(saved)
        assert "VerityBench" not in result.stdout
        assert "Test agents. Trust the evidence." not in result.stdout
        assert "Event " not in result.stdout
        _assert_no_controls(result.stdout)
    assert path.read_bytes() == saved


@pytest.mark.parametrize("state", ["timed_out", "cancelled", "inconclusive"])
@pytest.mark.parametrize("claimed_passed", [True, False])
def test_lifecycle_outcome_is_not_misrepresented_as_a_verdict(
    state: str, claimed_passed: bool
) -> None:
    payload = {
        "agent_name": "unfinished-agent",
        "scenario": "normal",
        "run_state": state,
        "evaluation": {"passed": claimed_passed, "invariants": [], "findings": []},
    }

    output = _render(payload)

    assert state.replace("_", " ") in output.lower().replace("_", " "), output
    assert not re.search(r"\b(?:PASS|FAIL)\b", output), output


@pytest.mark.parametrize("passed", [True, False])
@pytest.mark.parametrize("evidence", ["missing", None, []], ids=["absent", "null", "empty"])
def test_legacy_reports_tolerate_missing_evidence(cli_cwd: Path, passed: bool, evidence: Any) -> None:
    payload = _payload(passed=passed)
    payload.pop("metrics")
    payload.pop("trace")
    for item in [*payload["evaluation"]["invariants"], *payload["evaluation"]["findings"]]:
        if evidence == "missing":
            item.pop("evidence")
        else:
            item["evidence"] = evidence
    path = cli_cwd / "legacy.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    result = runner.invoke(app, ["report", "legacy.json"], color=True)

    assert result.exit_code == 0, result.output
    _assert_visible(
        result.stdout, *REPORT_LABELS, "PASS" if passed else "FAIL",
        "one charge per order", "legacy.json",
    )
    if passed:
        assert "No findings." in result.stdout
    else:
        _assert_visible(
            result.stdout, "DUPLICATE_CHARGE", "Order was charged twice",
            "Recommendation:", "Reuse the original idempotency key.",
        )


@pytest.mark.parametrize(
    "payload", [{}, {"evaluation": None}, {"evaluation": {}}, {"evaluation": {"passed": None}}]
)
def test_missing_evaluation_is_inconclusive(payload: dict[str, Any]) -> None:
    output = _render(payload)

    _assert_visible(output, "VerityBench", "Report:")
    assert "inconclusive" in output.lower(), output
    assert not re.search(r"\b(?:PASS|FAIL)\b", output), output


def test_report_strings_are_literal_rather_than_rich_markup() -> None:
    payload = _payload()
    payload["agent_name"] = "[bold]agent[/bold]"
    payload["scenario"] = "[green]scenario[/green]"
    check = payload["evaluation"]["invariants"][0]
    check["name"] = "[italic]check[/italic]"
    check["evidence"] = ["[red]check evidence[/red]"]
    finding = payload["evaluation"]["findings"][0]
    finding["code"] = "[bold]CODE[/bold]"
    finding["title"] = "[underline]finding[/underline]"
    finding["evidence"] = ["[link=https://example.test]ledger[/link]", "[/unmatched] literal evidence"]
    finding["recommendation"] = "[green]reuse key[/green]"
    path = Path("runs/[bold]literal.json")

    output = _render(payload, path=path, width=160)

    _assert_visible(
        output, payload["agent_name"], payload["scenario"], check["name"], *check["evidence"],
        finding["code"], finding["title"], *finding["evidence"], finding["recommendation"], str(path),
    )
    _assert_no_controls(output)


@pytest.mark.parametrize("width", [40, 60])
def test_narrow_redirected_console_preserves_details_without_controls(width: int) -> None:
    output = _render(_payload(), width=width)

    _assert_visible(
        output, *REPORT_LABELS, "FAIL", "one charge per order", "check-ledger-token",
        "DUPLICATE_CHARGE", "Order was charged twice", "Evidence:", "finding-ledger-token",
        "Recommendation:", "Reuse the original idempotency key.", "report.json",
    )
    _assert_no_controls(output)
    assert all(len(line) <= width for line in output.splitlines()), output


@pytest.mark.parametrize("command", REPORT_COMMANDS)
@pytest.mark.parametrize("no_color", [False, True], ids=["auto-color", "no-color"])
def test_redirected_cli_uses_auto_width_without_escape_controls(
    cli_cwd: Path, command: list[str], no_color: bool
) -> None:
    path = cli_cwd / "narrow.json"
    path.write_text(json.dumps(_payload()), encoding="utf-8")
    env = {"COLUMNS": "42"}
    if no_color:
        env["NO_COLOR"] = "1"

    result = runner.invoke(app, [*command, "narrow.json"], color=True, env=env)

    assert result.exit_code == 0, result.output
    _assert_visible(
        result.stdout, *REPORT_LABELS, "FAIL", "finding-ledger-token", "Recommendation:", "narrow.json"
    )
    _assert_no_controls(result.stdout)
    assert all(len(line) <= 42 for line in result.stdout.splitlines()), result.stdout


@pytest.mark.parametrize(
    "unsafe", ["\x1b[2J", "\x1b]8;;https://example.test\x07", "\x9b2J", "\rhidden", "\u202ereversed"]
)
def test_report_content_cannot_inject_terminal_controls(unsafe: str) -> None:
    payload = _payload()
    payload["agent_name"] = f"agent-{unsafe}"
    payload["evaluation"]["findings"][0]["recommendation"] = f"Fix {unsafe}"
    before = json.dumps(payload, sort_keys=True)

    output = _render(payload)

    _assert_no_controls(output)
    assert "\u202e" not in output
    assert "\\u" in output
    assert json.dumps(payload, sort_keys=True) == before


def test_interactive_report_is_colored_and_no_color_disables_palette(monkeypatch) -> None:
    stream = StringIO()
    render_report(_payload(), Path("report.json"), console=Console(file=stream, force_terminal=True))
    assert "\x1b[" in stream.getvalue()

    monkeypatch.setenv("NO_COLOR", "1")
    stream = StringIO()
    render_report(_payload(), Path("report.json"), console=Console(file=stream, force_terminal=True))
    # NO_COLOR removes foreground colors; Rich may retain bold/dim emphasis.
    assert not re.search(r"\x1b\[[\d;]*(?:3[0-9]|9[0-7])m", stream.getvalue())
