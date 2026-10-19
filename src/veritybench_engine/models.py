"""Typed domain models for the deterministic VerityBench engine.

The engine represents money as an integer number of minor units.  No model in
this package talks to a network, clock, payment provider, or secret store.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType

type JSONPrimitive = str | int | float | bool | None


class FaultScenario(str, Enum):
    """Stable IDs for code-owned deterministic scenarios."""

    NORMAL = "normal"
    TIMEOUT_AFTER_SUCCESS = "timeout_after_success"
    MALFORMED_RESPONSE = "malformed_response"
    MALFORMED_TOOL_RESPONSE = "malformed_tool_response"
    TEMPORARY_FAILURE = "temporary_failure"
    UNRECOVERABLE_FAILURE = "unrecoverable_failure"
    TRANSIENT_FAILURE = "transient_failure"
    RATE_LIMITED = "rate_limited"
    TOOL_EXCEPTION = "tool_exception"
    RETRY_EXHAUSTION = "retry_exhaustion"
    DUPLICATE_OPERATION = "duplicate_operation"
    CONFLICTING_TOOL_OUTPUT = "conflicting_tool_output"
    MALICIOUS_TOOL_OUTPUT = "malicious_tool_output"


# These aliases make the scenario type convenient for callers that use either
# domain terminology without creating a second, subtly different enum.
PaymentScenario = FaultScenario
Scenario = FaultScenario


class OrderStatus(str, Enum):
    CREATED = "created"
    PAYMENT_PENDING = "payment_pending"
    PAYMENT_FAILED = "payment_failed"
    PAID = "paid"
    FULFILLED = "fulfilled"
    CANCELLED = "cancelled"


class PaymentOutcome(str, Enum):
    SUCCESS = "success"
    TIMEOUT = "timeout"
    MALFORMED_RESPONSE = "malformed_response"
    MALFORMED_TOOL_RESPONSE = "malformed_tool_response"
    TEMPORARY_FAILURE = "temporary_failure"
    UNRECOVERABLE_FAILURE = "unrecoverable_failure"
    RATE_LIMITED = "rate_limited"
    TOOL_EXCEPTION = "tool_exception"
    CONFLICTING_TOOL_OUTPUT = "conflicting_tool_output"
    MALICIOUS_TOOL_OUTPUT = "malicious_tool_output"


class AgentAction(str, Enum):
    START_PAYMENT = "start_payment"
    RETRY_PAYMENT = "retry_payment"
    RECONCILE_PAYMENT = "reconcile_payment"
    FULFILL_ORDER = "fulfill_order"
    CANCEL_ORDER = "cancel_order"
    STOP = "stop"


class TraceEventType(str, Enum):
    ORDER_CREATED = "order_created"
    AGENT_DECISION = "agent_decision"
    PAYMENT_REQUESTED = "payment_requested"
    PAYMENT_RETRY = "payment_retry"
    PAYMENT_RESPONSE = "payment_response"
    PAYMENT_TIMEOUT = "payment_timeout"
    PAYMENT_RECONCILED = "payment_reconciled"
    PAYMENT_SUCCEEDED = "payment_succeeded"
    PAYMENT_FAILED = "payment_failed"
    LEDGER_CHARGED = "ledger_charged"
    ORDER_FULFILLED = "order_fulfilled"
    ORDER_CANCELLED = "order_cancelled"


ExecutionEventType = TraceEventType
EXECUTION_EVENT_SCHEMA_VERSION = 1
REPORT_SCHEMA_VERSION = 1


class LedgerEntryType(str, Enum):
    CHARGE = "charge"
    REVERSAL = "reversal"


class FindingSeverity(str, Enum):
    WARNING = "warning"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class SimulationConfig:
    """Inputs that fully determine one simulation run."""

    scenario: FaultScenario = FaultScenario.NORMAL
    order_id: str = "order-001"
    amount: int = 100
    currency: str = "USD"
    max_retries: int = 2
    max_steps: int = 20
    seed: int = 0
    parameters: Mapping[str, JSONPrimitive] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.order_id.strip():
            raise ValueError("order_id must not be empty")
        if self.amount <= 0:
            raise ValueError("amount must be greater than zero minor units")
        if len(self.currency) != 3 or not self.currency.isalpha():
            raise ValueError("currency must be a three-letter code")
        if self.max_retries < 0:
            raise ValueError("max_retries must not be negative")
        if self.max_steps < 1:
            raise ValueError("max_steps must be at least one")
        if not 0 <= self.seed <= 2_147_483_647:
            raise ValueError("seed must be between 0 and 2147483647")
        if any(not isinstance(key, str) or not key.strip() for key in self.parameters):
            raise ValueError("scenario parameter names must be non-empty strings")
        if any(isinstance(value, dict | list | tuple | set) for value in self.parameters.values()):
            raise ValueError("scenario parameters must be JSON primitive values")
        from .scenarios import validate_scenario_parameters

        validated_parameters = validate_scenario_parameters(self.scenario, dict(self.parameters))
        object.__setattr__(self, "parameters", MappingProxyType(validated_parameters))


@dataclass(frozen=True, slots=True)
class Order:
    """The final externally visible order state."""

    order_id: str
    amount: int
    currency: str
    status: OrderStatus
    attempts: int = 0
    payment_id: str | None = None
    idempotency_key: str = ""


@dataclass(frozen=True, slots=True)
class LedgerEntry:
    """One deterministic accounting entry for an order."""

    entry_id: str
    order_id: str
    payment_id: str
    amount: int
    currency: str
    entry_type: LedgerEntryType
    idempotency_key: str


@dataclass(frozen=True, slots=True)
class Ledger:
    """Immutable ledger snapshot returned by a simulation."""

    entries: tuple[LedgerEntry, ...] = ()

    @property
    def charges(self) -> tuple[LedgerEntry, ...]:
        return tuple(entry for entry in self.entries if entry.entry_type is LedgerEntryType.CHARGE)

    @property
    def total_charged(self) -> int:
        return sum(entry.amount for entry in self.charges)

    def charges_for_order(self, order_id: str) -> tuple[LedgerEntry, ...]:
        return tuple(entry for entry in self.charges if entry.order_id == order_id)

    def to_dict(self) -> dict[str, object]:
        return {
            "entries": [
                {
                    "entry_id": entry.entry_id,
                    "order_id": entry.order_id,
                    "payment_id": entry.payment_id,
                    "amount": entry.amount,
                    "currency": entry.currency,
                    "entry_type": entry.entry_type.value,
                    "idempotency_key": entry.idempotency_key,
                }
                for entry in self.entries
            ],
            "total_charged": self.total_charged,
        }


@dataclass(frozen=True, slots=True)
class ExecutionEvent:
    """A versioned, structured, deterministic event in an execution trace."""

    index: int
    tick: int
    event_type: TraceEventType
    order_id: str
    attributes: Mapping[str, JSONPrimitive] = field(default_factory=dict)
    schema_version: int = EXECUTION_EVENT_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.index < 0 or self.tick < 0:
            raise ValueError("trace index and tick must not be negative")
        if self.schema_version < 1:
            raise ValueError("execution event schema_version must be positive")
        object.__setattr__(self, "attributes", MappingProxyType(dict(self.attributes)))

    @property
    def kind(self) -> TraceEventType:
        """Compatibility-friendly name for the event type."""

        return self.event_type

    @property
    def sequence(self) -> int:
        """Execution-wide ordering alias used by persisted event consumers."""

        return self.index

    @property
    def payload(self) -> Mapping[str, JSONPrimitive]:
        """Structured attribute alias used by event-stream consumers."""

        return self.attributes

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "index": self.index,
            "tick": self.tick,
            "event_type": self.event_type.value,
            "order_id": self.order_id,
            "attributes": dict(self.attributes),
        }


# TraceEvent remains the public name used by existing engine consumers.
TraceEvent = ExecutionEvent


@dataclass(frozen=True, slots=True)
class AgentContext:
    """Read-only information supplied to an agent before each decision."""

    order: Order
    scenario: FaultScenario
    last_outcome: PaymentOutcome | None
    max_retries: int


@dataclass(frozen=True, slots=True)
class AgentDecision:
    """An agent's next workflow action."""

    action: AgentAction
    rationale: str
    idempotency_key: str | None = None


@dataclass(frozen=True, slots=True)
class Metrics:
    """Metrics derived from the trace and final ledger, not agent claims."""

    payment_attempts: int = 0
    retries: int = 0
    successful_payments: int = 0
    timeouts: int = 0
    malformed_responses: int = 0
    malformed_tool_responses: int = 0
    temporary_failures: int = 0
    unrecoverable_failures: int = 0
    reconciliations: int = 0
    ledger_charges: int = 0
    duplicate_charges: int = 0
    fulfilled_orders: int = 0
    cancelled_orders: int = 0
    rate_limited: int = 0
    tool_exceptions: int = 0
    conflicting_outputs: int = 0
    malicious_outputs: int = 0

    def to_dict(self) -> dict[str, int]:
        return {
            "payment_attempts": self.payment_attempts,
            "retries": self.retries,
            "successful_payments": self.successful_payments,
            "timeouts": self.timeouts,
            "malformed_responses": self.malformed_responses,
            "malformed_tool_responses": self.malformed_tool_responses,
            "temporary_failures": self.temporary_failures,
            "unrecoverable_failures": self.unrecoverable_failures,
            "reconciliations": self.reconciliations,
            "ledger_charges": self.ledger_charges,
            "duplicate_charges": self.duplicate_charges,
            "fulfilled_orders": self.fulfilled_orders,
            "cancelled_orders": self.cancelled_orders,
            "rate_limited": self.rate_limited,
            "tool_exceptions": self.tool_exceptions,
            "conflicting_outputs": self.conflicting_outputs,
            "malicious_outputs": self.malicious_outputs,
        }


@dataclass(frozen=True, slots=True)
class InvariantResult:
    name: str
    passed: bool
    evidence: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Finding:
    """An actionable evaluator finding backed by trace or ledger evidence."""

    code: str
    severity: FindingSeverity
    title: str
    evidence: tuple[str, ...]
    recommendation: str

    def to_dict(self) -> dict[str, object]:
        return {
            "code": self.code,
            "severity": self.severity.value,
            "title": self.title,
            "evidence": list(self.evidence),
            "recommendation": self.recommendation,
        }


@dataclass(frozen=True, slots=True)
class EvaluationReport:
    passed: bool
    invariants: tuple[InvariantResult, ...]
    findings: tuple[Finding, ...]
    report_version: int = REPORT_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.report_version < 1:
            raise ValueError("evaluation report_version must be positive")

    def to_dict(self) -> dict[str, object]:
        return {
            "report_version": self.report_version,
            "passed": self.passed,
            "invariants": [
                {"name": item.name, "passed": item.passed, "evidence": list(item.evidence)}
                for item in self.invariants
            ],
            "findings": [finding.to_dict() for finding in self.findings],
        }


@dataclass(frozen=True, slots=True)
class SimulationResult:
    """Complete output suitable for a CLI, API response, or benchmark record."""

    agent_name: str
    scenario: FaultScenario
    order: Order
    ledger: Ledger
    trace: tuple[ExecutionEvent, ...]
    metrics: Metrics
    evaluation: EvaluationReport
    scenario_seed: int = 0
    scenario_parameters: Mapping[str, JSONPrimitive] = field(default_factory=dict)
    execution_limits: Mapping[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "report_version": self.evaluation.report_version,
            "agent_name": self.agent_name,
            "scenario": self.scenario.value,
            "order": {
                "order_id": self.order.order_id,
                "amount": self.order.amount,
                "currency": self.order.currency,
                "status": self.order.status.value,
                "attempts": self.order.attempts,
                "payment_id": self.order.payment_id,
                "idempotency_key": self.order.idempotency_key,
            },
            "ledger": self.ledger.to_dict(),
            "trace": [event.to_dict() for event in self.trace],
            "metrics": self.metrics.to_dict(),
            "evaluation": self.evaluation.to_dict(),
            "scenario_config": {
                "seed": self.scenario_seed,
                "parameters": dict(self.scenario_parameters),
                "execution_limits": dict(self.execution_limits),
            },
        }
