"""Background persistence for repository-owned deterministic sample runs."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from threading import Lock, Thread
from typing import cast
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from veritybench_engine import (
    EXECUTION_EVENT_SCHEMA_VERSION,
    Agent,
    DeterministicEngine,
    ExecutionCancelled,
    ExecutionEvent,
    FaultScenario,
    SimulationConfig,
)

from .db import SessionLocal
from .db_types import RunState
from .models import Run, RunEvent

logger = logging.getLogger("veritybench.execution")
run_event_lock = Lock()

LifecycleEventPayload = Mapping[str, object]
AgentFactory = Callable[[], Agent]
EngineFactory = Callable[[SimulationConfig], DeterministicEngine]


def append_run_event(
    db: Session,
    run_id: str,
    event_type: str,
    payload: LifecycleEventPayload,
    *,
    schema_version: int = EXECUTION_EVENT_SCHEMA_VERSION,
) -> RunEvent:
    """Append one event at the next durable sequence number."""

    latest = db.scalar(select(func.max(RunEvent.sequence)).where(RunEvent.run_id == run_id))
    next_sequence = int(latest) + 1 if latest is not None else 0
    event = RunEvent(
        id=str(uuid4()),
        run_id=run_id,
        sequence=next_sequence,
        schema_version=schema_version,
        event_type=event_type,
        payload_json=json.dumps(dict(payload), sort_keys=True),
        created_at=datetime.now(UTC),
    )
    db.add(event)
    return event


def persist_engine_event(db: Session, run_id: str, event: ExecutionEvent) -> None:
    """Persist an engine event without changing its structured payload."""

    with run_event_lock:
        append_run_event(
            db,
            run_id,
            event.event_type.value,
            cast(LifecycleEventPayload, event.to_dict()),
            schema_version=event.schema_version,
        )
        db.commit()


def submit_run(
    run_id: str,
    scenario: FaultScenario,
    agent_factory: AgentFactory,
    max_steps: int,
    *,
    engine_factory: EngineFactory = DeterministicEngine,
) -> Thread:
    """Start a run in a daemon worker and return without waiting for it."""

    worker = Thread(
        target=_execute_run,
        args=(run_id, scenario, agent_factory, max_steps, engine_factory),
        name=f"veritybench-run-{run_id}",
        daemon=True,
    )
    worker.start()
    return worker


def _execute_run(
    run_id: str,
    scenario: FaultScenario,
    agent_factory: AgentFactory,
    max_steps: int,
    engine_factory: EngineFactory,
) -> None:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return
        if run.state == RunState.CANCELLED:
            return
        if run.cancel_requested:
            _cancel_run(db, run, "cancelled before execution started")
            return

        with run_event_lock:
            db.expire(run)
            run = db.get(Run, run_id)
            if run is None or run.state == RunState.CANCELLED:
                return
            if run.cancel_requested:
                _cancel_run_locked(db, run, "cancelled before execution started")
                return
            run.state = RunState.RUNNING
            run.started_at = datetime.now(UTC)
            append_run_event(
                db,
                run.id,
                "run_started",
                {"state": RunState.RUNNING.value},
            )
            db.commit()

        def should_cancel() -> bool:
            with SessionLocal() as check_db:
                requested = check_db.scalar(
                    select(Run.cancel_requested).where(Run.id == run_id)
                )
                return bool(requested)

        def on_event(event: ExecutionEvent) -> None:
            persist_engine_event(db, run_id, event)

        result = engine_factory(
            SimulationConfig(scenario=scenario, max_steps=max_steps)
        ).run(
            agent_factory(),
            on_event=on_event,
            should_cancel=should_cancel,
        )
        if should_cancel():
            raise ExecutionCancelled

        db.rollback()
        run = db.get(Run, run_id)
        if run is None:
            return
        with run_event_lock:
            db.expire(run)
            run = db.get(Run, run_id)
            if run is None:
                return
            if run.cancel_requested:
                _cancel_run_locked(db, run, "cancellation requested")
                return
            run.report_json = json.dumps(result.to_dict(), sort_keys=True)
            run.state = RunState.PASSED if result.evaluation.passed else RunState.FAILED
            run.completed_at = datetime.now(UTC)
            append_run_event(
                db,
                run.id,
                "run_completed",
                {
                    "state": run.state.value,
                    "passed": result.evaluation.passed,
                    "trace_event_count": len(result.trace),
                },
            )
            db.commit()
    except ExecutionCancelled:
        db.rollback()
        run = db.get(Run, run_id)
        if run is not None:
            _cancel_run(db, run, "cancellation requested")
    except Exception as exc:  # bounded engine errors become explicit inconclusive runs
        logger.exception("background run execution failed", extra={"run_id": run_id})
        db.rollback()
        run = db.get(Run, run_id)
        if run is not None:
            with run_event_lock:
                db.expire(run)
                run = db.get(Run, run_id)
                if run is not None:
                    if run.cancel_requested:
                        _cancel_run_locked(db, run, "cancellation requested")
                    else:
                        run.state = RunState.INCONCLUSIVE
                        run.error_message = f"execution failed: {type(exc).__name__}"
                        run.completed_at = datetime.now(UTC)
                        append_run_event(
                            db,
                            run.id,
                            "run_failed",
                            {"state": RunState.INCONCLUSIVE.value, "error": run.error_message},
                        )
                        db.commit()
    finally:
        db.close()


def _cancel_run(db: Session, run: Run, reason: str) -> None:
    with run_event_lock:
        _cancel_run_locked(db, run, reason)


def _cancel_run_locked(db: Session, run: Run, reason: str) -> None:
    run.cancel_requested = True
    run.state = RunState.CANCELLED
    run.completed_at = run.completed_at or datetime.now(UTC)
    append_run_event(
        db,
        run.id,
        "run_cancelled",
        {"state": RunState.CANCELLED.value, "reason": reason},
    )
    db.commit()
