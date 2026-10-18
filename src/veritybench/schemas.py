"""Validated API request and response models."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

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
    agent: Literal["safe", "defective"] = "safe"
    scenario: FaultScenario = FaultScenario.NORMAL


class RunSummary(BaseModel):
    id: str
    project_id: str
    state: str
    agent: str
    scenario: str
    created_at: datetime
    completed_at: datetime | None = None

    @field_validator("created_at", "completed_at", mode="after")
    @classmethod
    def normalize_timestamps(cls, value: datetime | None) -> datetime | None:
        return _as_utc(value) if value is not None else None


class RunResponse(RunSummary):
    report: dict[str, object] | None = None
    error_message: str | None = None


class HealthResponse(BaseModel):
    status: Literal["ok", "ready"]
    version: str
