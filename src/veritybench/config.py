"""Environment-backed application settings."""

from __future__ import annotations

from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "sqlite:///./veritybench.db"
    veritybench_env: str = "development"
    veritybench_cors_origins: str = "http://localhost:5173"
    veritybench_session_ttl_hours: int = 24
    veritybench_max_run_steps: int = 20

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.veritybench_cors_origins.split(",") if origin.strip()]

    @field_validator("veritybench_session_ttl_hours")
    @classmethod
    def validate_session_ttl(cls, value: int) -> int:
        if not 1 <= value <= 168:
            raise ValueError("session TTL must be between 1 and 168 hours")
        return value

    @field_validator("veritybench_max_run_steps")
    @classmethod
    def validate_max_steps(cls, value: int) -> int:
        if not 1 <= value <= 100:
            raise ValueError("maximum run steps must be between 1 and 100")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
