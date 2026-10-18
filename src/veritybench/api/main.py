"""Versioned VerityBench API."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from veritybench_engine import (
    DefectiveSampleAgent,
    DeterministicEngine,
    SafeSampleAgent,
    SimulationConfig,
)

from .. import __version__
from ..auth import hash_password, issue_session, revoke_session, verify_password
from ..config import get_settings
from ..db import get_db, init_db
from ..db_types import RunState
from ..models import Project, Run, User
from ..rate_limit import AuthRateLimiter
from ..schemas import (
    HealthResponse,
    LoginRequest,
    ProjectCreateRequest,
    ProjectResponse,
    RegisterRequest,
    RunCreateRequest,
    RunResponse,
    RunSummary,
    SessionResponse,
    UserResponse,
)
from .dependencies import current_user, owned_project

logger = logging.getLogger("veritybench.api")
settings = get_settings()
auth_limiter = AuthRateLimiter()
SampleAgentFactory = Callable[[], SafeSampleAgent | DefectiveSampleAgent]
SAMPLE_AGENT_FACTORIES: dict[str, SampleAgentFactory] = {
    "safe": SafeSampleAgent,
    "defective": DefectiveSampleAgent,
}

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
    allow_methods=["GET", "POST"],
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
    report = json.loads(run.report_json) if run.report_json else None
    return RunResponse(
        id=run.id,
        project_id=run.project_id,
        state=run.state,
        agent=run.agent,
        scenario=run.scenario,
        created_at=run.created_at,
        completed_at=run.completed_at,
        report=report,
        error_message=run.error_message,
    )


@app.post("/api/v1/projects/{project_id}/runs", response_model=RunResponse, status_code=status.HTTP_201_CREATED)
def create_run(
    project_id: str,
    payload: RunCreateRequest,
    request: Request,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> RunResponse:
    owned_project(project_id, user, db)
    agent_factory = SAMPLE_AGENT_FACTORIES.get(payload.agent)
    if agent_factory is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="unsupported sample agent")
    run = Run(
        id=str(uuid4()),
        project_id=project_id,
        state=RunState.QUEUED,
        agent=payload.agent,
        scenario=payload.scenario.value,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    run.state = RunState.RUNNING
    db.commit()
    try:
        selected_agent = agent_factory()
        result = DeterministicEngine(
            SimulationConfig(scenario=payload.scenario, max_steps=settings.veritybench_max_run_steps)
        ).run(selected_agent)
        run.report_json = json.dumps(result.to_dict(), sort_keys=True)
        run.state = RunState.PASSED if result.evaluation.passed else RunState.FAILED
    except Exception as exc:  # bounded engine errors become explicit inconclusive runs
        logger.exception("run execution failed", extra={"request_id": request.state.request_id, "run_id": run.id})
        run.state = RunState.INCONCLUSIVE
        run.error_message = f"execution failed: {type(exc).__name__}"
    run.completed_at = datetime.now(UTC)
    db.commit()
    db.refresh(run)
    return _run_response(run)


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
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="run not found")
    owned_project(run.project_id, user, db)
    return _run_response(run)
