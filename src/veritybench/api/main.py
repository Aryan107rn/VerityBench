"""Versioned VerityBench API."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, build_opener
from urllib.request import Request as UrlRequest
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from veritybench_engine import (
    DefectiveSampleAgent,
    DeterministicEngine,
    FaultScenario,
    SafeSampleAgent,
    SimulationConfig,
    scenario_catalog,
)

from .. import __version__
from ..auth import hash_password, issue_session, revoke_session, verify_password
from ..config import get_settings
from ..db import SessionLocal, get_db, init_db
from ..db_types import RunState
from ..execution import append_run_event, run_event_lock, submit_run
from ..models import AgentRegistration, Project, Run, RunEvent, User
from ..rate_limit import AuthRateLimiter
from ..schemas import (
    AgentMetadata,
    AgentRegistrationRequest,
    AgentRegistrationResponse,
    GitHubAgentImportRequest,
    HealthResponse,
    LoginRequest,
    ProjectCreateRequest,
    ProjectResponse,
    RegisterRequest,
    RunCreateRequest,
    RunEventResponse,
    RunReport,
    RunResponse,
    RunStateValue,
    RunSummary,
    ScenarioResponse,
    SessionResponse,
    UserResponse,
)
from .dependencies import current_user, owned_project

logger = logging.getLogger("veritybench.api")
settings = get_settings()
auth_limiter = AuthRateLimiter()


class _GitHubRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        target = urlparse(newurl)
        if target.scheme != "https" or target.hostname not in {"raw.githubusercontent.com", "github.com"}:
            raise URLError("GitHub response redirected to an untrusted host")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_github_opener = build_opener(_GitHubRedirectHandler())
SampleAgentFactory = Callable[[], SafeSampleAgent | DefectiveSampleAgent]
SAMPLE_AGENT_FACTORIES: dict[str, SampleAgentFactory] = {
    "safe": SafeSampleAgent,
    "defective": DefectiveSampleAgent,
}
SAMPLE_AGENT_METADATA = [
    AgentMetadata(
        key="safe",
        name="safe-sample-agent",
        description="Reconciles uncertain payments before fulfillment.",
        source="repository",
        runnable=True,
        supported_scenarios=[scenario.value for scenario in FaultScenario],
    ),
    AgentMetadata(
        key="defective",
        name="defective-sample-agent",
        description="Demonstrates duplicate-payment behavior for evaluator testing.",
        source="repository",
        runnable=True,
        supported_scenarios=[scenario.value for scenario in FaultScenario],
    ),
]


def _agent_key(registration_id: str) -> str:
    return f"remote:{registration_id}"


def _artifact_root() -> Path:
    root = Path(settings.veritybench_agent_artifact_dir).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def _github_raw_source_url(repository_url: str, ref: str, entrypoint: str) -> tuple[str, str]:
    """Validate a public GitHub repository URL and build one safe raw-file URL."""

    parsed = urlparse(repository_url)
    if parsed.scheme != "https" or parsed.hostname != "github.com" or parsed.username or parsed.password:
        raise ValueError("repository_url must be an https://github.com/OWNER/REPO URL")
    if parsed.query or parsed.fragment:
        raise ValueError("repository_url must not contain a query or fragment")
    components = [component for component in parsed.path.strip("/").split("/") if component]
    if len(components) != 2:
        raise ValueError("repository_url must identify exactly one public GitHub repository")
    owner, repository = components
    if repository.endswith(".git"):
        repository = repository[:-4]
    if not all(re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", value) for value in (owner, repository)):
        raise ValueError("repository owner and name contain unsupported characters")
    if not re.fullmatch(r"[A-Za-z0-9_.\-/]{1,200}", ref) or ".." in ref or "//" in ref:
        raise ValueError("ref contains unsupported path characters")
    if not entrypoint.endswith(".py") or entrypoint.startswith("/") or ".." in entrypoint:
        raise ValueError("entrypoint must be a relative .py path")
    if not re.fullmatch(r"[A-Za-z0-9_.\-/]{1,200}", entrypoint) or "//" in entrypoint:
        raise ValueError("entrypoint contains unsupported path characters")
    raw_ref = "/".join(quote(part, safe="") for part in ref.split("/"))
    raw_entrypoint = "/".join(quote(part, safe="") for part in entrypoint.split("/"))
    canonical = f"https://github.com/{owner}/{repository}"
    raw_url = f"https://raw.githubusercontent.com/{quote(owner)}/{quote(repository)}/{raw_ref}/{raw_entrypoint}"
    return canonical, raw_url


def _fetch_github_source(repository_url: str, ref: str, entrypoint: str) -> tuple[bytes, str, str]:
    canonical, raw_url = _github_raw_source_url(repository_url, ref, entrypoint)
    request = UrlRequest(raw_url, headers={"Accept": "text/plain", "User-Agent": f"veritybench/{__version__}"})
    try:
        with _github_opener.open(request, timeout=10) as response:
            final = urlparse(response.geturl())
            if final.scheme != "https" or final.hostname not in {"raw.githubusercontent.com", "github.com"}:
                raise ValueError("GitHub response redirected to an untrusted host")
            source_bytes = response.read(settings.veritybench_agent_max_source_bytes + 1)
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise ValueError("could not fetch the public GitHub entrypoint") from exc
    if len(source_bytes) > settings.veritybench_agent_max_source_bytes:
        raise ValueError("GitHub entrypoint is too large")
    try:
        source_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("GitHub entrypoint must be UTF-8 text") from exc
    if b"\x00" in source_bytes:
        raise ValueError("GitHub entrypoint must not contain NUL bytes")
    return source_bytes, canonical, ref


def _remote_agent_metadata(registration: AgentRegistration) -> AgentMetadata:
    return AgentMetadata(
        key=_agent_key(registration.id),
        name=registration.name,
        version=registration.version,
        description="Project-registered Python agent executed by the isolated worker.",
        source="remote",
        runnable=registration.enabled,
        status="enabled" if registration.enabled else "disabled",
        supported_scenarios=[scenario.value for scenario in FaultScenario],
    )

app = FastAPI(
    title="VerityBench API",
    version=__version__,
    docs_url="/docs",
    redoc_url=None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):  # type: ignore[no-untyped-def]
    request_id = request.headers.get("X-Request-ID", "")
    if not request_id or len(request_id) > 64 or any(ord(char) < 32 for char in request_id):
        request_id = str(uuid4())
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = "default-src 'self'; frame-ancestors 'none'"
    return response


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": str(exc.detail), "request_id": getattr(request.state, "request_id", None)},
        headers=exc.headers,
    )


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "detail": "invalid request",
            "request_id": getattr(request.state, "request_id", None),
            "fields": [str(error.get("loc", ())) for error in exc.errors()],
        },
    )


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__)


@app.get("/ready", response_model=HealthResponse)
def ready(db: Session = Depends(get_db)) -> HealthResponse:
    db.execute(select(1))
    return HealthResponse(status="ready", version=__version__)


def _rate_limit(request: Request) -> None:
    client_host = request.client.host if request.client else "unknown"
    if not auth_limiter.allow(f"{client_host}:{request.url.path}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="too many attempts")


def _session_response(user: User, token: str, expires_at: datetime) -> SessionResponse:
    return SessionResponse(
        access_token=token,
        expires_at=expires_at,
        user=UserResponse.model_validate(user),
    )


@app.post("/api/v1/auth/register", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, request: Request, db: Session = Depends(get_db)) -> SessionResponse:
    _rate_limit(request)
    if db.scalar(select(User).where(User.email == payload.email)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email is already registered")
    user = User(id=str(uuid4()), email=payload.email, password_hash=hash_password(payload.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        logger.info("registration conflict", extra={"request_id": request.state.request_id})
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email is already registered") from exc
    db.refresh(user)
    token, session = issue_session(db, user, settings)
    return _session_response(user, token, session.expires_at)


@app.post("/api/v1/auth/login", response_model=SessionResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)) -> SessionResponse:
    _rate_limit(request)
    user = db.scalar(select(User).where(User.email == payload.email))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    token, session = issue_session(db, user, settings)
    return _session_response(user, token, session.expires_at)


@app.get("/api/v1/auth/me", response_model=UserResponse)
def me(user: User = Depends(current_user)) -> UserResponse:
    return UserResponse.model_validate(user)


@app.post("/api/v1/auth/logout", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def logout(
    request: Request,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    authorization = request.headers.get("Authorization", "")
    scheme, _, token = authorization.partition(" ")
    token = token.strip()
    if scheme.lower() == "bearer" and token:
        revoke_session(db, token)


@app.get("/api/v1/projects", response_model=list[ProjectResponse])
def list_projects(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[Project]:
    return list(
        db.scalars(
            select(Project)
            .where(Project.owner_id == user.id)
            .order_by(Project.created_at.desc(), Project.id.desc())
        )
    )


@app.post("/api/v1/projects", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreateRequest,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Project:
    project = Project(id=str(uuid4()), owner_id=user.id, name=payload.name, description=payload.description)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@app.get("/api/v1/projects/{project_id}", response_model=ProjectResponse)
def get_project(
    project_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Project:
    return owned_project(project_id, user, db)


def _run_response(run: Run) -> RunResponse:
    report = _load_run_report(run)
    return RunResponse(
        id=run.id,
        project_id=run.project_id,
        state=cast(RunStateValue, run.state),
        agent=run.agent,
        scenario=run.scenario,
        scenario_config=_load_scenario_config(run),
        cancel_requested=run.cancel_requested,
        created_at=run.created_at,
        started_at=run.started_at,
        completed_at=run.completed_at,
        report=report,
        error_message=run.error_message,
    )


def _load_run_report(run: Run) -> dict[str, object] | None:
    """Validate a stored report without changing legacy report JSON shapes."""

    if not run.report_json:
        return None
    try:
        raw_report = json.loads(run.report_json)
    except (TypeError, json.JSONDecodeError):
        logger.warning("stored run report is not valid JSON", extra={"run_id": run.id})
        return None
    if not isinstance(raw_report, dict):
        logger.warning("stored run report is not an object", extra={"run_id": run.id})
        return None
    try:
        validated = RunReport.model_validate(raw_report)
    except ValidationError:
        logger.warning("stored run report failed validation", extra={"run_id": run.id})
        return None
    if validated.run_state is not None and validated.run_state != run.state:
        logger.warning("stored run report state disagrees with run state", extra={"run_id": run.id})
        return None
    return cast(dict[str, object], raw_report)


def _load_scenario_config(run: Run) -> dict[str, object] | None:
    if not run.scenario_config_json:
        return None
    try:
        value = json.loads(run.scenario_config_json)
    except json.JSONDecodeError:
        return None
    return cast(dict[str, object], value) if isinstance(value, dict) else None


def _run_event_response(event: RunEvent) -> RunEventResponse:
    payload = json.loads(event.payload_json)
    if not isinstance(payload, dict):
        payload = {}
    return RunEventResponse(
        id=event.id,
        run_id=event.run_id,
        sequence=event.sequence,
        schema_version=event.schema_version,
        event_type=event.event_type,
        payload=cast(dict[str, object], payload),
        created_at=event.created_at,
    )


def _owned_run(run_id: str, user: User, db: Session) -> Run:
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="run not found")
    owned_project(run.project_id, user, db)
    return run


@app.post("/api/v1/projects/{project_id}/runs", response_model=RunResponse, status_code=status.HTTP_201_CREATED)
def create_run(
    project_id: str,
    payload: RunCreateRequest,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> RunResponse:
    owned_project(project_id, user, db)
    try:
        config = SimulationConfig(
            scenario=payload.scenario,
            seed=payload.seed,
            parameters=payload.parameters,
            max_retries=payload.max_retries,
            max_steps=min(payload.max_steps, settings.veritybench_max_run_steps),
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    agent_factory = SAMPLE_AGENT_FACTORIES.get(payload.agent)
    registration: AgentRegistration | None = None
    if agent_factory is None:
        registration_id = payload.agent.removeprefix("remote:")
        registration = db.scalar(
            select(AgentRegistration).where(
                AgentRegistration.id == registration_id,
                AgentRegistration.project_id == project_id,
                AgentRegistration.enabled.is_(True),
            )
        )
        if registration is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid request")
    run = Run(
        id=str(uuid4()),
        project_id=project_id,
        agent_registration_id=registration.id if registration is not None else None,
        state=RunState.QUEUED,
        agent=payload.agent,
        scenario=payload.scenario.value,
        scenario_config_json=json.dumps(
            {
                "seed": config.seed,
                "parameters": dict(config.parameters),
                "execution_limits": {
                    "max_retries": config.max_retries,
                    "max_steps": config.max_steps,
                },
            },
            sort_keys=True,
        ),
    )
    with run_event_lock:
        db.add(run)
        append_run_event(
            db,
            run.id,
            "run_queued",
            {
                "state": RunState.QUEUED.value,
                "agent": payload.agent,
                "scenario": payload.scenario.value,
            },
        )
        db.commit()
    db.refresh(run)
    if agent_factory is not None:
        submit_run(
            run.id,
            payload.scenario,
            agent_factory,
            config.max_steps,
            engine_factory=DeterministicEngine,
            seed=config.seed,
            parameters=config.parameters,
            max_retries=config.max_retries,
        )
    return _run_response(run)


@app.get("/api/v1/scenarios", response_model=list[ScenarioResponse])
def list_scenarios(user: User = Depends(current_user)) -> list[dict[str, object]]:
    """Return the validated, code-owned scenario catalog."""

    del user
    return scenario_catalog()


@app.get("/api/v1/projects/{project_id}/runs", response_model=list[RunSummary])
def list_runs(
    project_id: str,
    limit: int = 50,
    offset: int = 0,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[Run]:
    owned_project(project_id, user, db)
    limit = min(max(limit, 1), 100)
    offset = max(offset, 0)
    return list(
        db.scalars(
            select(Run)
            .where(Run.project_id == project_id)
            .order_by(Run.created_at.desc(), Run.id.desc())
            .limit(limit)
            .offset(offset)
        )
    )


@app.get("/api/v1/runs/{run_id}", response_model=RunResponse)
def get_run(run_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> RunResponse:
    return _run_response(_owned_run(run_id, user, db))


@app.get("/api/v1/projects/{project_id}/agents", response_model=list[AgentMetadata])
def list_agents(
    project_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[AgentMetadata]:
    owned_project(project_id, user, db)
    registrations = db.scalars(
        select(AgentRegistration)
        .where(AgentRegistration.project_id == project_id)
        .order_by(AgentRegistration.created_at.desc(), AgentRegistration.id.desc())
    )
    return [*SAMPLE_AGENT_METADATA, *(_remote_agent_metadata(item) for item in registrations)]


def _store_agent_registration(
    project_id: str,
    *,
    name: str,
    version: str,
    contract_version: int,
    source_bytes: bytes,
    source_kind: str = "inline",
    source_url: str | None = None,
    source_ref: str | None = None,
    db: Session,
) -> AgentRegistration:
    if len(source_bytes) > settings.veritybench_agent_max_source_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="agent source is too large",
        )
    agent_id = str(uuid4())
    digest = hashlib.sha256(source_bytes).hexdigest()
    root = _artifact_root()
    artifact = root / f"{agent_id}.py"
    try:
        artifact.write_bytes(source_bytes)
    except OSError as exc:
        logger.exception("could not store remote agent artifact", extra={"agent_id": agent_id})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="agent artifact storage unavailable",
        ) from exc
    registration = AgentRegistration(
        id=agent_id,
        project_id=project_id,
        name=name,
        version=version,
        source_path=str(artifact),
        source_sha256=digest,
        source_size=len(source_bytes),
        contract_version=contract_version,
        source_kind=source_kind,
        source_url=source_url,
        source_ref=source_ref,
    )
    db.add(registration)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        artifact.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="agent name/version already registered",
        ) from exc
    db.refresh(registration)
    return registration


@app.post(
    "/api/v1/projects/{project_id}/agents",
    response_model=AgentRegistrationResponse,
    status_code=status.HTTP_201_CREATED,
)
def register_agent(
    project_id: str,
    payload: AgentRegistrationRequest,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> AgentRegistration:
    """Store source bytes as an artifact; the API never imports or executes them."""

    owned_project(project_id, user, db)
    return _store_agent_registration(
        project_id,
        name=payload.name,
        version=payload.version,
        contract_version=payload.contract_version,
        source_bytes=payload.source.encode("utf-8"),
        db=db,
    )


@app.post(
    "/api/v1/projects/{project_id}/agents/github",
    response_model=AgentRegistrationResponse,
    status_code=status.HTTP_201_CREATED,
)
def import_github_agent(
    project_id: str,
    payload: GitHubAgentImportRequest,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> AgentRegistration:
    """Fetch one public GitHub Python entrypoint, then hand it to the worker boundary."""

    owned_project(project_id, user, db)
    try:
        source_bytes, canonical_url, source_ref = _fetch_github_source(
            payload.repository_url,
            payload.ref,
            payload.entrypoint,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    return _store_agent_registration(
        project_id,
        name=payload.name,
        version=payload.version,
        contract_version=payload.contract_version,
        source_bytes=source_bytes,
        source_kind="github",
        source_url=canonical_url,
        source_ref=source_ref,
        db=db,
    )


@app.delete("/api/v1/projects/{project_id}/agents/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
def disable_agent(
    project_id: str,
    agent_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    owned_project(project_id, user, db)
    registration = db.scalar(
        select(AgentRegistration).where(
            AgentRegistration.id == agent_id,
            AgentRegistration.project_id == project_id,
        )
    )
    if registration is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="agent not found")
    registration.enabled = False
    db.commit()


@app.get("/api/v1/runs/{run_id}/events", response_model=list[RunEventResponse])
def list_run_events(
    run_id: str,
    after_sequence: int = -1,
    limit: int = 100,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[RunEventResponse]:
    _owned_run(run_id, user, db)
    bounded_limit = min(max(limit, 1), 500)
    return [
        _run_event_response(event)
        for event in db.scalars(
            select(RunEvent)
            .where(RunEvent.run_id == run_id, RunEvent.sequence > max(after_sequence, -1))
            .order_by(RunEvent.sequence.asc())
            .limit(bounded_limit)
        )
    ]


@app.post("/api/v1/runs/{run_id}/cancel", response_model=RunResponse)
def cancel_run(
    run_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> RunResponse:
    run = _owned_run(run_id, user, db)
    terminal_states = {
        RunState.PASSED,
        RunState.FAILED,
        RunState.CANCELLED,
        RunState.TIMED_OUT,
        RunState.INCONCLUSIVE,
    }
    if run.state not in terminal_states:
        with run_event_lock:
            if not run.cancel_requested:
                run.cancel_requested = True
                append_run_event(
                    db,
                    run.id,
                    "run_cancel_requested",
                    {"state": run.state, "cancel_requested": True},
                )
            if run.state == RunState.QUEUED:
                run.state = RunState.CANCELLED
                run.completed_at = datetime.now(UTC)
                append_run_event(
                    db,
                    run.id,
                    "run_cancelled",
                    {"state": RunState.CANCELLED.value, "reason": "cancelled while queued"},
                )
            db.commit()
        db.refresh(run)
    return _run_response(run)


def _event_stream(run_id: str, after_sequence: int) -> Iterator[str]:
    sequence = max(after_sequence, -1)
    while True:
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            if run is None:
                return
            events = list(
                db.scalars(
                    select(RunEvent)
                    .where(RunEvent.run_id == run_id, RunEvent.sequence > sequence)
                    .order_by(RunEvent.sequence.asc())
                )
            )
            terminal = run.state in {
                RunState.PASSED,
                RunState.FAILED,
                RunState.CANCELLED,
                RunState.TIMED_OUT,
                RunState.INCONCLUSIVE,
            }
        for event in events:
            response = _run_event_response(event).model_dump(mode="json")
            yield (
                f"id: {event.sequence}\n"
                f"event: {event.event_type}\n"
                f"data: {json.dumps(response, sort_keys=True)}\n\n"
            )
            sequence = event.sequence
        if terminal:
            return
        time.sleep(0.05)


@app.get("/api/v1/runs/{run_id}/events/stream")
def stream_run_events(
    run_id: str,
    after_sequence: int = -1,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    _owned_run(run_id, user, db)
    return StreamingResponse(
        _event_stream(run_id, after_sequence),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
