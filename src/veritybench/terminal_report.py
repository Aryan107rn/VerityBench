"""Branded terminal views of recorded evidence, never a second evaluator.

All report-controlled strings are rendered as literal text. Rich handles width
and color; redirected output has no terminal controls and JSON bypasses this
module entirely.
"""

from __future__ import annotations

import sys
import unicodedata
from collections.abc import Mapping
from pathlib import Path
from typing import cast

from rich import box
from rich.console import Console, Group, RenderableType
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.theme import Theme

from . import __version__

THEME = Theme(
    {
        "brand": "#9a8bf0",
        "muted": "dim",
        "good": "green",
        "bad": "red",
        "attention": "yellow",
    }
)

# Text adaptation of the web workspace's double-V mark, not a separate logo.
LOGO = "●╲ ╲ ╱ ╱●\n  ╲ V ╱\n   ╲ ╱\n    V"


def _mapping(value: object) -> Mapping[str, object]:
    return cast(Mapping[str, object], value) if isinstance(value, dict) else {}


def _records(value: object) -> list[Mapping[str, object]]:
    return [_mapping(item) for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _literal(value: object, style: str = "") -> Text:
    """Prevent markup, hyperlinks, cursor escapes, and bidi control injection."""

    raw = "Not recorded" if value is None else str(value)
    safe = "".join(
        char if char == "\n" or unicodedata.category(char) not in {"Cc", "Cf", "Cs"}
        else f"\\u{ord(char):04x}"
        for char in raw
    )
    return Text(safe, style=style, overflow="fold")


def _evaluation(payload: Mapping[str, object]) -> Mapping[str, object]:
    return _mapping(payload.get("evaluation"))


def _verdict(payload: Mapping[str, object]) -> tuple[str, str, str]:
    state = payload.get("run_state")
    if isinstance(state, str) and state not in {"passed", "failed"}:
        return state.replace("_", " ").upper(), "attention", "Execution state; not a completed evaluation verdict."
    passed = _evaluation(payload).get("passed")
    if passed is True and state != "failed":
        return "PASS", "good", "Independent evaluation passed."
    if passed is False:
        return "FAIL", "bad", "Independent evaluation detected a failed check."
    return "INCONCLUSIVE", "attention", "No complete evaluation verdict was recorded."


def _badge(value: object) -> Text:
    if value is True:
        return Text("PASS", style="bold good")
    if value is False:
        return Text("FAIL", style="bold bad")
    return Text("UNKNOWN", style="attention")


def _brand(width: int) -> Panel:
    wordmark = Text.assemble(("Verity", "bold"), ("Bench", "bold brand"))
    copy = Group(
        wordmark,
        Text("Test agents. Trust the evidence.", style="muted"),
        Text(f"AGENT RELIABILITY REPORT  ·  v{__version__}", style="muted"),
    )
    if width < 64:
        content: RenderableType = Group(Text(LOGO, style="bold brand"), Text(""), copy)
    else:
        grid = Table.grid(padding=(0, 3))
        grid.add_column(width=10)
        grid.add_column()
        grid.add_row(Text(LOGO, style="bold brand"), copy)
        content = grid
    return Panel(content, border_style="brand", padding=(1, 2))


def _summary(payload: Mapping[str, object]) -> Panel:
    verdict, tone, explanation = _verdict(payload)
    info = Table.grid(padding=(0, 2), expand=True)
    info.add_column(style="muted", width=12)
    info.add_column(ratio=1, overflow="fold")
    info.add_row("Agent", _literal(payload.get("agent_name")))
    info.add_row("Scenario", _literal(payload.get("scenario")))
    order = _mapping(payload.get("order"))
    if order:
        info.add_row("Order", _literal(order.get("order_id")))
        info.add_row("Final state", _literal(order.get("status")))
    trace = payload.get("trace")
    if isinstance(trace, list):
        info.add_row("Trace", Text(f"{len(trace)} recorded events"))
    return Panel(
        Group(_literal(verdict, f"bold {tone}"), Text(explanation), Text(""), info),
        title="Evaluation",
        title_align="left",
        border_style=tone,
        padding=(1, 2),
    )


def _metric_value(name: str, value: object) -> Text:
    tone = "bad" if name == "duplicate_charges" and isinstance(value, int | float) and value > 0 else "bold"
    return _literal(value, tone)


def _metrics(payload: Mapping[str, object], width: int) -> Panel:
    metrics = _mapping(payload.get("metrics"))
    if not metrics:
        return Panel(Text("Metrics not recorded.", style="muted"), title="Metrics", title_align="left")
    table = Table(box=box.SIMPLE, expand=True, show_header=False, padding=(0, 1))
    pairs = 2 if width >= 72 else 1
    for _ in range(pairs):
        table.add_column(ratio=3, overflow="fold")
        table.add_column(ratio=1, justify="right", overflow="fold")
    entries = list(metrics.items())
    for index in range(0, len(entries), pairs):
        row: list[Text] = []
        for name, value in entries[index:index + pairs]:
            row.extend([_literal(name.replace("_", " ").capitalize()), _metric_value(name, value)])
        while len(row) < pairs * 2:
            row.append(Text(""))
        table.add_row(*row)
    return Panel(table, title="Metrics", title_align="left", border_style="brand")


def _evidence(value: object) -> list[RenderableType]:
    if not isinstance(value, list) or not value:
        return [Text("Evidence: Not recorded.", style="muted")]
    return [Text("Evidence:", style="muted"), *[_literal(item) for item in value]]


def _checks(payload: Mapping[str, object]) -> Panel:
    checks = _records(_evaluation(payload).get("invariants"))
    if not checks:
        return Panel(Text("Checks not recorded.", style="muted"), title="Checks", title_align="left")
    passed = sum(check.get("passed") is True for check in checks)
    failed = sum(check.get("passed") is False for check in checks)
    content: list[RenderableType] = [Text(f"{passed} passed  ·  {failed} failed  ·  {len(checks)} recorded")]
    # A suite's full evidence stays in JSON, avoiding a wall of repeated passing
    # checks. Individual reports always show every check and its evidence.
    suite = payload.get("suite") is True
    visible = [check for check in checks if check.get("passed") is not True] if suite else checks
    if suite and passed:
        content.append(Text("Passing check evidence is included in the saved report.", style="muted"))
    for check in visible:
        heading = _badge(check.get("passed"))
        heading.append("  ")
        heading.append(_literal(check.get("name")))
        content.extend([Text(""), heading, *_evidence(check.get("evidence"))])
    return Panel(Group(*content), title="Checks", title_align="left", padding=(1, 2))


def _scenarios(payload: Mapping[str, object]) -> Panel:
    table = Table(box=box.SIMPLE, expand=True, padding=(0, 1))
    table.add_column("Scenario", ratio=3, overflow="fold")
    table.add_column("Verdict", ratio=1, overflow="fold")
    for result in _records(payload.get("results")):
        verdict, tone, _ = _verdict(result)
        table.add_row(_literal(result.get("scenario")), _literal(verdict, f"bold {tone}"))
    return Panel(table, title="Scenario results", title_align="left", border_style="brand")


def _findings(payload: Mapping[str, object]) -> Panel:
    evaluation = _evaluation(payload)
    findings = _records(evaluation.get("findings"))
    if not findings:
        message = "No findings." if evaluation.get("findings") == [] else "Findings not recorded."
        return Panel(Text(message, style="muted"), title="Findings", title_align="left")

    # Keep suite findings associated with their originating scenario rather
    # than presenting identical codes from different runs without context.
    contextual = [
        (result.get("scenario"), finding)
        for result in _records(payload.get("results"))
        for finding in _records(_evaluation(result).get("findings"))
    ] if payload.get("suite") is True else []
    entries = contextual or [(None, finding) for finding in findings]
    content: list[RenderableType] = []
    for index, (scenario, finding) in enumerate(entries, 1):
        if index > 1:
            content.append(Text(""))
        severity = finding.get("severity", "unknown")
        tone = "bad" if severity == "error" else "attention"
        heading = Text(f"{index:02d}  ", style="muted")
        heading.append(_literal(finding.get("code"), f"bold {tone}"))
        heading.append("  ·  ")
        heading.append(_literal(severity, tone))
        content.extend([heading, _literal(finding.get("title"), "bold")])
        if scenario is not None:
            content.append(_literal(scenario, "muted"))
        content.extend([Text(""), *_evidence(finding.get("evidence")), Text("")])
        recommendation = Text("Recommendation: ", style="bold brand", overflow="fold")
        recommendation.append(_literal(finding.get("recommendation")))
        content.append(recommendation)
    return Panel(Group(*content), title="Findings", title_align="left", border_style="attention", padding=(1, 2))


def render_report(
    payload: Mapping[str, object],
    path: Path,
    *,
    console: Console | None = None,
) -> None:
    """Display recorded evidence at the current terminal width without mutation."""

    output = console or Console(
        highlight=False,
        markup=False,
        # Don't emit cursor/color sequences into pipes, even with FORCE_COLOR.
        force_terminal=sys.stdout.isatty(),
    )
    with output.use_theme(THEME):
        output.print()
        output.print(_brand(output.width))
        output.print(_summary(payload))
        if payload.get("suite") is True:
            output.print(_scenarios(payload))
        output.print(_metrics(payload, output.width))
        output.print(_checks(payload))
        output.print(_findings(payload))
        footer = Text("Report: ", style="bold brand", overflow="fold")
        footer.append(_literal(path))
        output.print(footer)
        output.print(Text("Saved JSON contains the full recorded evidence.", style="muted"))
