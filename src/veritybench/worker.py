"""Separate worker process for project-registered remote agents.

The FastAPI process only stores metadata and queues runs.  This worker claims
remote-agent runs and invokes the Docker-only local worker boundary.  It must
run on a host explicitly configured with the pinned agent image and Docker
runtime; the API container should never receive the Docker socket.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from veritybench_engine import FaultScenario, SimulationConfig

from .config import get_settings
from .db import SessionLocal
from .db_types import RunState
from .execution import append_run_event, run_event_lock
from .local_worker import LocalWorkerError
from .local_worker import run_sandboxed_agent as run_local_agent
from .models import AgentRegistration, Run
from .schemas import RunReport

logger = logging.getLogger("veritybench.worker")
settings = get_settings()


def _claim_next_run(db: Session) -> str | None:
    candidate = db.scalar(
        select(Run.id)
        .where(Run.agent_registration_id.is_not(None), Run.state == RunState.QUEUED)
        .order_by(Run.created_at.asc(), Run.id.asc())
        .limit(1)
    )
    if candidate is None:
        return None
    with run_event_lock:
        result = db.execute(
            update(Run)
            .where(Run.id == candidate, Run.state == RunState.QUEUED)
            .values(state=RunState.RUNNING, started_at=datetime.now(UTC))
        )
        if result.rowcount != 1:
            db.rollback()
            return None
        run = db.get(Run, candidate)
        if run is None:
            db.rollback()
            return None
        append_run_event(db, run.id, "run_started", {"state": RunState.RUNNING.value, "worker": "remote"})
        db.commit()
    return candidate


def _persist_worker_event(db: Session, run_id: str, event: dict[str, object]) -> None:
    event_type = event.get("event_type")
    if not isinstance(event_type, str) or not event_type:
        raise LocalWorkerError("worker_protocol_error", "remote worker event type is missing")
    schema_version = event.get("schema_version", 1)
    if not isinstance(schema_version, int):
        schema_version = 1
    with run_event_lock:
        append_run_event(
            db,
            run_id,
            event_type,
            event,
            schema_version=schema_version,
        )
        db.commit()


def _finish_run(db: Session, run: Run, state: RunState, report: dict[str, object] | None, error: str | None) -> None:
    with run_event_lock:
        db.expire(run)
        current = db.get(Run, run.id)
        if current is None or current.state in {
            RunState.PASSED,
            RunState.FAILED,
            RunState.CANCELLED,
            RunState.TIMED_OUT,
            RunState.INCONCLUSIVE,
        }:
            return
        current.state = state
        current.error_message = error
        current.completed_at = datetime.now(UTC)
        if report is not None:
            report["run_state"] = state.value
            current.report_json = json.dumps(report, sort_keys=True)
        append_run_event(
            db,
            current.id,
            "run_completed" if state in {RunState.PASSED, RunState.FAILED} else "run_failed",
            {"state": state.value, "error": error, "worker": "remote"},
        )
        db.commit()


def run_once() -> bool:
    """Claim and execute one remote run; return whether work was found."""

    db = SessionLocal()
    try:
        run_id = _claim_next_run(db)
        if run_id is None:
            return False
        run = db.get(Run, run_id)
        if run is None or run.agent_registration_id is None:
            return True
        registration = db.get(AgentRegistration, run.agent_registration_id)
        if registration is None or not registration.enabled:
            _finish_run(db, run, RunState.INCONCLUSIVE, None, "remote agent registration is unavailable")
            return True
        try:
            source_path = Path(registration.source_path)
            source_bytes = source_path.read_bytes()
            if len(source_bytes) != registration.source_size or hashlib.sha256(source_bytes).hexdigest() != registration.source_sha256:
                _finish_run(db, run, RunState.INCONCLUSIVE, None, "remote agent artifact digest mismatch")
                return True
            scenario = FaultScenario(run.scenario)
            report = run_local_agent(
                source_path,
                _run_simulation_config(run, scenario),
                timeout_seconds=settings.veritybench_remote_run_timeout_seconds,
                on_event=lambda event: _persist_worker_event(db, run_id, event),
            )
            validated = RunReport.model_validate(report)
            evaluation = validated.evaluation
            passed = isinstance(evaluation, dict) and evaluation.get("passed") is True
            _finish_run(db, run, RunState.PASSED if passed else RunState.FAILED, report, None)
        except LocalWorkerError as exc:
            state = RunState.TIMED_OUT if exc.code == "agent_timeout" else RunState.INCONCLUSIVE
            _finish_run(db, run, state, None, f"{exc.code}: {exc.message}")
        except Exception as exc:
            logger.exception("remote worker run failed", extra={"run_id": run_id})
            _finish_run(db, run, RunState.INCONCLUSIVE, None, f"worker failure: {type(exc).__name__}")
        return True
    finally:
        db.close()


def _run_simulation_config(run: Run, scenario: FaultScenario) -> SimulationConfig:
    """Rebuild the validated configuration persisted when the run was queued."""

    if not run.scenario_config_json:
        return SimulationConfig(scenario=scenario, max_steps=settings.veritybench_max_run_steps)
    try:
        payload = json.loads(run.scenario_config_json)
        limits = payload.get("execution_limits", {})
        return SimulationConfig(
            scenario=scenario,
            seed=int(payload.get("seed", 0)),
            parameters=payload.get("parameters", {}),
            max_retries=int(limits.get("max_retries", 2)),
            max_steps=min(int(limits.get("max_steps", settings.veritybench_max_run_steps)), settings.veritybench_max_run_steps),
        )
    except (AttributeError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("persisted scenario configuration is invalid") from exc


def serve(poll_seconds: float = 1.0) -> None:
    """Poll the durable database until interrupted."""

    if poll_seconds <= 0:
        raise ValueError("poll_seconds must be positive")
    while True:
        if not run_once():
            time.sleep(poll_seconds)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    serve()
