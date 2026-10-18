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


def test_cli_returns_failure_exit_code_for_defective_agent(cli_cwd) -> None:
    assert runner.invoke(app, ["init"]).exit_code == 0
    tested = runner.invoke(
        app,
        ["test", "--scenario", "timeout_after_success", "--agent", "defective"],
    )
    assert tested.exit_code == 1
    report = json.loads((cli_cwd / "runs" / "latest.json").read_text())
    assert report["metrics"]["duplicate_charges"] == 1
