"""Versioned contract for Python agents executed by the local CLI worker.

This module deliberately contains only the small adapter contract needed to
plug a local Python agent into the existing deterministic engine.  It does not
load Python files; loading happens in :mod:`veritybench.local_worker`, which is
started in a separate process by the CLI.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol, cast

from veritybench_engine import Agent, AgentAction, AgentContext, AgentDecision

AGENT_CONTRACT_NAME = "veritybench.python-agent"
AGENT_CONTRACT_VERSION = 1
MAX_AGENT_NAME_LENGTH = 128
MAX_RATIONALE_LENGTH = 2_048
MAX_IDEMPOTENCY_KEY_LENGTH = 256


class AgentContractError(ValueError):
    """A local agent refused or failed the documented Python contract."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class PythonAgent(Protocol):
    """The object returned by a local module's ``create_agent`` function."""

    @property
    def name(self) -> str:
        ...

    def decide(self, context: AgentContext) -> AgentDecision:
        ...


class _ValidatedAgent:
    """Adapt and validate a contract object before the engine sees it."""

    def __init__(self, agent: object, name: str) -> None:
        self._agent = agent
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    def decide(self, context: AgentContext) -> AgentDecision:
        callback = cast(Callable[[AgentContext], object], cast(PythonAgent, self._agent).decide)
        try:
            decision = callback(context)
        except AgentContractError:
            raise
        except Exception as exc:
            raise AgentContractError(
                "agent_exception",
                f"agent {self._name!r} raised {type(exc).__name__}: {exc}",
            ) from exc

        if not isinstance(decision, AgentDecision):
            raise AgentContractError(
                "invalid_decision",
                "decide(context) must return veritybench_engine.AgentDecision",
            )
        if not isinstance(decision.action, AgentAction):
            raise AgentContractError("invalid_decision", "AgentDecision.action must be AgentAction")
        if not isinstance(decision.rationale, str) or not decision.rationale.strip():
            raise AgentContractError("invalid_decision", "AgentDecision.rationale must be non-empty text")
        if len(decision.rationale) > MAX_RATIONALE_LENGTH:
            raise AgentContractError(
                "invalid_decision",
                f"AgentDecision.rationale is limited to {MAX_RATIONALE_LENGTH} characters",
            )
        if decision.idempotency_key is not None:
            if not isinstance(decision.idempotency_key, str) or not decision.idempotency_key.strip():
                raise AgentContractError(
                    "invalid_decision",
                    "AgentDecision.idempotency_key must be non-empty text or None",
                )
            if len(decision.idempotency_key) > MAX_IDEMPOTENCY_KEY_LENGTH:
                raise AgentContractError(
                    "invalid_decision",
                    f"AgentDecision.idempotency_key is limited to {MAX_IDEMPOTENCY_KEY_LENGTH} characters",
                )
        return decision


def validate_agent(agent: object) -> Agent:
    """Validate and adapt a factory result for the deterministic engine."""

    try:
        name = cast(PythonAgent, agent).name
    except Exception as exc:
        raise AgentContractError(
            "invalid_agent",
            f"agent name could not be read ({type(exc).__name__})",
        ) from exc
    if not isinstance(name, str) or not name.strip():
        raise AgentContractError("invalid_agent", "agent.name must be non-empty text")
    if len(name) > MAX_AGENT_NAME_LENGTH:
        raise AgentContractError(
            "invalid_agent",
            f"agent.name is limited to {MAX_AGENT_NAME_LENGTH} characters",
        )

    callback = getattr(agent, "decide", None)
    if not callable(callback):
        raise AgentContractError("invalid_agent", "agent.decide must be callable")
    return _ValidatedAgent(agent, name)


def create_agent_from_module(module: object) -> Agent:
    """Validate a loaded module's version and factory, then return its adapter."""

    version = getattr(module, "AGENT_CONTRACT_VERSION", None)
    if type(version) is not int or version != AGENT_CONTRACT_VERSION:  # noqa: E721
        raise AgentContractError(
            "unsupported_contract",
            f"module must declare AGENT_CONTRACT_VERSION = {AGENT_CONTRACT_VERSION}",
        )

    factory = getattr(module, "create_agent", None)
    if not callable(factory):
        raise AgentContractError("invalid_module", "module must export callable create_agent()")
    try:
        agent = factory()
    except AgentContractError:
        raise
    except Exception as exc:
        raise AgentContractError(
            "agent_factory_error",
            f"create_agent() raised {type(exc).__name__}: {exc}",
        ) from exc
    return validate_agent(agent)
