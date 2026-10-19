from __future__ import annotations

import json

from typer.testing import CliRunner

from veritybench.cli import app

runner = CliRunner()


def test_cli_runs_safe_recovery_and_reads_report(cli_cwd) -> None:
    initialized = runner.invoke(app, ["init"])
    assert initialized.exit_code == 0, initialized.stdout
    tested = runner.invoke(
        app,
        ["test", "--scenario", "timeout_after_success", "--agent", "safe", "--json"],
    )
    assert tested.exit_code == 0, tested.stdout
    report = json.loads((cli_cwd / "runs" / "latest.json").read_text())
    assert report["evaluation"]["passed"] is True
    shown = runner.invoke(app, ["report"])
    assert shown.exit_code == 0
    assert "PASS" in shown.stdout


def test_cli_agent_init_writes_a_valid_starter(tmp_path) -> None:
    target = tmp_path / "my-agent.py"
    created = runner.invoke(app, ["agent", "init", str(target)])

    assert created.exit_code == 0, created.stdout
    source = target.read_text()
    assert "AGENT_CONTRACT_VERSION = 1" in source
    assert "def create_agent" in source


def test_cli_returns_failure_exit_code_for_defective_agent(cli_cwd) -> None:
    assert runner.invoke(app, ["init"]).exit_code == 0
    tested = runner.invoke(
        app,
        ["test", "--scenario", "timeout_after_success", "--agent", "defective"],
    )
    assert tested.exit_code == 1
    report = json.loads((cli_cwd / "runs" / "latest.json").read_text())
    assert report["metrics"]["duplicate_charges"] == 1


def test_cli_runs_all_scenarios_and_streams_sample_events(cli_cwd) -> None:
    assert runner.invoke(app, ["init"]).exit_code == 0
    tested = runner.invoke(app, ["test", "--scenario", "all", "--agent", "safe"])

    assert tested.exit_code == 0, tested.stdout
    assert "Event 0: order_created" in tested.stdout
    report = json.loads((cli_cwd / "runs" / "latest.json").read_text())
    assert report["scenario"] == "all"
    assert len(report["results"]) >= 13
    assert report["evaluation"]["passed"] is True


def test_cli_demo_writes_both_reports_and_prints_evidence(cli_cwd) -> None:
    demonstrated = runner.invoke(app, ["demo"])

    assert demonstrated.exit_code == 0, demonstrated.stdout
    assert "VerityBench demo evidence" in demonstrated.stdout
    assert "duplicate charges: 1" in demonstrated.stdout
    assert "duplicate charges: 0" in demonstrated.stdout
    assert "Recommendation:" in demonstrated.stdout
    assert "idempotency key" in demonstrated.stdout

    defective = json.loads((cli_cwd / "runs" / "demo-defective-timeout.json").read_text())
    safe = json.loads((cli_cwd / "runs" / "demo-safe-recovery.json").read_text())
    assert defective["agent_name"] == "defective-sample-agent"
    assert defective["scenario"] == "timeout_after_success"
    assert defective["metrics"]["duplicate_charges"] == 1
    assert any(item["code"] == "DUPLICATE_CHARGE" for item in defective["evaluation"]["findings"])
    assert safe["agent_name"] == "safe-sample-agent"
    assert safe["scenario"] == "timeout_after_success"
    assert safe["metrics"]["duplicate_charges"] == 0
    assert safe["evaluation"]["passed"] is True
