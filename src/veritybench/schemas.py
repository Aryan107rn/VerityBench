"""Validated API request and response models."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from veritybench_engine import FaultScenario


def _as_utc(value: datetime) -> datetime:
    """Return API timestamps with an explicit UTC offset.

    SQLite drops timezone information for ``DateTime(timezone=True)`` columns.
    Normalizing at the response boundary keeps timestamps from being interpreted
    as browser-local time while preserving timezone-aware values from databases
    that retain them.
    """

    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


class ErrorResponse(BaseModel):
    detail: str
    request_id: str | None = None


class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=12, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if "@" not in normalized or normalized.startswith("@") or normalized.endswith("@"):
            raise ValueError("email must be a valid address")
        return normalized


class LoginRequest(RegisterRequest):
    pass


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    email: str
    created_at: datetime

    @field_validator("created_at", mode="after")
    @classmethod
    def normalize_created_at(cls, value: datetime) -> datetime:
        return _as_utc(value)


class SessionResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_at: datetime
    user: UserResponse

    @field_validator("expires_at", mode="after")
    @classmethod
    def normalize_expires_at(cls, value: datetime) -> datetime:
        return _as_utc(value)


class ProjectCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name must not be empty")
        return value


class ProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: str
    created_at: datetime

    @field_validator("created_at", mode="after")
    @classmethod
    def normalize_created_at(cls, value: datetime) -> datetime:
        return _as_utc(value)


class RunCreateRequest(BaseModel):
    agent: str = Field(default="safe", min_length=1, max_length=128)
    scenario: FaultScenario = FaultScenario.NORMAL
    seed: int = Field(default=0, ge=0, le=2_147_483_647)
    parameters: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
    max_retries: int = Field(default=2, ge=0, le=20)
    max_steps: int = Field(default=20, ge=1, le=1_000)

    @field_validator("agent")
    @classmethod
    def clean_agent(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("agent must not be empty")
        return value


RunStateValue = Literal[
    "queued",
    "running",
    "passed",
    "failed",
    "cancelled",
    "timed_out",
    "inconclusive",
]


class RunSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    state: RunStateValue
    agent: str
    scenario: str
    scenario_config: dict[str, object] | None = None
    cancel_requested: bool = False
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None

    @field_validator("created_at", "started_at", "completed_at", mode="after")
    @classmethod
    def normalize_timestamps(cls, value: datetime | None) -> datetime | None:
        return _as_utc(value) if value is not None else None


class RunResponse(RunSummary):
    report: dict[str, object] | None = None
    error_message: str | None = None


class RunReport(BaseModel):
    """Compatibility validator for persisted reports.

    Reports predating ``report_version`` remain readable.  Current reports
    carry a positive version and the database-backed run state; unknown fields
    are retained because the engine report is an extensible evidence payload.
    """

    model_config = ConfigDict(extra="allow")

    report_version: int | None = Field(default=None, ge=1)
    run_state: RunStateValue | None = None
    agent_name: str | None = None
    scenario: str | None = None
    order: dict[str, object] | None = None
    ledger: dict[str, object] | None = None
    trace: list[dict[str, object]] | None = None
    metrics: dict[str, int] | None = None
    evaluation: dict[str, object] | None = None
    scenario_config: dict[str, object] | None = None

    @model_validator(mode="after")
    def validate_versioned_report(self) -> RunReport:
        if self.report_version is not None and any(
            value is None
            for value in (
                self.agent_name,
                self.scenario,
                self.order,
                self.ledger,
                self.trace,
                self.metrics,
                self.evaluation,
            )
        ):
            raise ValueError("versioned report is missing required evidence fields")
        return self


class ScenarioParameterResponse(BaseModel):
    name: str
    label: str
    description: str
    type: Literal["integer", "number", "string", "boolean"]
    default: str | int | float | bool | None = None
    minimum: int | float | None = None
    maximum: int | float | None = None
    choices: list[str] = Field(default_factory=list)


class ScenarioResponse(BaseModel):
    id: str
    name: str = Field(validation_alias="label", serialization_alias="name")
    category: str
    description: str
    expected_outcome: str
    deterministic: bool
    supported_agent_contract: int
    parameters: list[ScenarioParameterResponse]
    execution_limits: dict[str, int]


class RunEventResponse(BaseModel):
    id: str
    run_id: str
    sequence: int
    schema_version: int
    event_type: str
    payload: dict[str, object]
    created_at: datetime

    @field_validator("created_at", mode="after")
    @classmethod
    def normalize_created_at(cls, value: datetime) -> datetime:
        return _as_utc(value)


class AgentMetadata(BaseModel):
    key: str
    name: str
    description: str
    source: Literal["repository", "remote"]
    runnable: bool
    supported_scenarios: list[str]
    version: str | None = None
    status: Literal["enabled", "disabled"] = "enabled"


class AgentRegistrationRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    version: str = Field(min_length=1, max_length=64)
    contract_version: int = Field(default=1, ge=1, le=1)
    source: str = Field(min_length=1, max_length=1_048_576)

    @field_validator("name", "version")
    @classmethod
    def clean_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value must not be empty")
        return value

    @field_validator("source")
    @classmethod
    def validate_source(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("source must not contain NUL bytes")
        return value


class GitHubAgentImportRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    version: str = Field(min_length=1, max_length=64)
    contract_version: int = Field(default=1, ge=1, le=1)
    repository_url: str = Field(min_length=1, max_length=500)
    ref: str = Field(default="main", min_length=1, max_length=200)
    entrypoint: str = Field(default="agent.py", min_length=1, max_length=200)

    @field_validator("name", "version", "repository_url", "ref", "entrypoint")
    @classmethod
    def clean_github_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value must not be empty")
        return value

class AgentRegistrationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    name: str
    version: str
    source_sha256: str
    source_size: int
    contract_version: int
    source_kind: Literal["inline", "github"] = "inline"
    source_url: str | None = None
    source_ref: str | None = None
    enabled: bool
    created_at: datetime

    @field_validator("created_at", mode="after")
    @classmethod
    def normalize_created_at(cls, value: datetime) -> datetime:
        return _as_utc(value)


class HealthResponse(BaseModel):
    status: Literal["ok", "ready"]
    version: str
