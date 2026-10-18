"""Deterministic order/payment simulation with no external integrations."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace

from .agents import Agent, SafeSampleAgent
from .evaluation import compute_metrics, evaluate_state
from .models import (
    AgentAction,
    AgentContext,
    ExecutionEvent,
    FaultScenario,
    Ledger,
    LedgerEntry,
    LedgerEntryType,
    Order,
    OrderStatus,
    PaymentOutcome,
    SimulationConfig,
    SimulationResult,
    TraceEvent,
    TraceEventType,
)


class ExecutionCancelled(Exception):
    """Raised when a cooperative execution cancellation is requested."""


@dataclass(frozen=True, slots=True)
class _PaymentReceipt:
    payment_id: str
    order_id: str
    amount: int
    currency: str
    idempotency_key: str


@dataclass(frozen=True, slots=True)
class _GatewayResult:
    outcome: PaymentOutcome
    receipt: _PaymentReceipt | None = None
    charged: bool = False
    replayed: bool = False


class _DeterministicPaymentGateway:
    """A local provider model whose responses are fully determined by inputs."""

    def __init__(self, config: SimulationConfig) -> None:
        self._config = config
        self._ledger_entries: list[LedgerEntry] = []
        self._processed: dict[str, _PaymentReceipt] = {}
        self._requests = 0
        self._one_shot_fault_emitted = False

    @property
    def ledger(self) -> Ledger:
        return Ledger(entries=tuple(self._ledger_entries))

    def request(self, order: Order, idempotency_key: str) -> _GatewayResult:
        self._requests += 1

        existing = self._processed.get(idempotency_key)
        if existing is not None:
            return _GatewayResult(
                outcome=PaymentOutcome.SUCCESS,
                receipt=existing,
                replayed=True,
            )

        scenario = self._config.scenario
        if scenario is FaultScenario.TIMEOUT_AFTER_SUCCESS and not self._one_shot_fault_emitted:
            receipt = self._charge(order, idempotency_key)
            self._processed[idempotency_key] = receipt
            self._one_shot_fault_emitted = True
            return _GatewayResult(
                outcome=PaymentOutcome.TIMEOUT,
                receipt=receipt,
                charged=True,
            )

        if scenario is FaultScenario.MALFORMED_RESPONSE and not self._one_shot_fault_emitted:
            self._one_shot_fault_emitted = True
            return _GatewayResult(outcome=PaymentOutcome.MALFORMED_RESPONSE)

        if scenario is FaultScenario.TEMPORARY_FAILURE and not self._one_shot_fault_emitted:
            self._one_shot_fault_emitted = True
            return _GatewayResult(outcome=PaymentOutcome.TEMPORARY_FAILURE)

        if scenario is FaultScenario.UNRECOVERABLE_FAILURE:
            return _GatewayResult(outcome=PaymentOutcome.UNRECOVERABLE_FAILURE)

        receipt = self._charge(order, idempotency_key)
        self._processed[idempotency_key] = receipt
        return _GatewayResult(
            outcome=PaymentOutcome.SUCCESS,
            receipt=receipt,
            charged=True,
        )

    def reconcile(self, idempotency_key: str) -> _GatewayResult:
        receipt = self._processed.get(idempotency_key)
        if receipt is None:
            return _GatewayResult(outcome=PaymentOutcome.UNRECOVERABLE_FAILURE)
        return _GatewayResult(outcome=PaymentOutcome.SUCCESS, receipt=receipt, replayed=True)

    def _charge(self, order: Order, idempotency_key: str) -> _PaymentReceipt:
        payment_id = f"payment-{order.order_id}-{len(self._ledger_entries) + 1:03d}"
        receipt = _PaymentReceipt(
            payment_id=payment_id,
            order_id=order.order_id,
            amount=order.amount,
            currency=order.currency,
            idempotency_key=idempotency_key,
        )
        self._ledger_entries.append(
            LedgerEntry(
                entry_id=f"ledger-{len(self._ledger_entries) + 1:03d}",
                order_id=order.order_id,
                payment_id=payment_id,
                amount=order.amount,
                currency=order.currency,
                entry_type=LedgerEntryType.CHARGE,
                idempotency_key=idempotency_key,
            )
        )
        return receipt


class DeterministicEngine:
    """Run one deterministic workflow with a pluggable decision agent."""

    def __init__(self, config: SimulationConfig | None = None) -> None:
        self.config = config or SimulationConfig()
        self._on_event: Callable[[ExecutionEvent], None] | None = None
        self._should_cancel: Callable[[], bool] | None = None

    def run(
        self,
        agent: Agent | None = None,
        *,
        on_event: Callable[[ExecutionEvent], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> SimulationResult:
        self._on_event = on_event
        self._should_cancel = should_cancel
        self._check_cancel()
        selected_agent = agent or SafeSampleAgent()
        gateway = _DeterministicPaymentGateway(self.config)
        order = Order(
            order_id=self.config.order_id,
            amount=self.config.amount,
            currency=self.config.currency.upper(),
            status=OrderStatus.CREATED,
            idempotency_key=f"payment:{self.config.order_id}",
        )
        trace: list[TraceEvent] = []
        last_outcome: PaymentOutcome | None = None

        self._emit(trace, TraceEventType.ORDER_CREATED, order)

        for _ in range(self.config.max_steps):
            self._check_cancel()
            context = AgentContext(
                order=order,
                scenario=self.config.scenario,
                last_outcome=last_outcome,
                max_retries=self.config.max_retries,
            )
            decision = selected_agent.decide(context)
            self._emit(
                trace,
                TraceEventType.AGENT_DECISION,
                order,
                action=decision.action.value,
                rationale=decision.rationale,
                idempotency_key=decision.idempotency_key,
            )
            self._check_cancel()

            if decision.action is AgentAction.START_PAYMENT:
                key = decision.idempotency_key or order.idempotency_key
                order, last_outcome = self._payment_request(order, key, gateway, trace)
            elif decision.action is AgentAction.RETRY_PAYMENT:
                self._emit(trace, TraceEventType.PAYMENT_RETRY, order)
                key = decision.idempotency_key or order.idempotency_key
                order, last_outcome = self._payment_request(order, key, gateway, trace)
            elif decision.action is AgentAction.RECONCILE_PAYMENT:
                key = decision.idempotency_key or order.idempotency_key
                order, last_outcome = self._reconcile(order, key, gateway, trace)
            elif decision.action is AgentAction.FULFILL_ORDER:
                order = replace(order, status=OrderStatus.FULFILLED)
                self._emit(trace, TraceEventType.ORDER_FULFILLED, order)
                break
            elif decision.action is AgentAction.CANCEL_ORDER:
                order = replace(order, status=OrderStatus.CANCELLED)
                self._emit(trace, TraceEventType.ORDER_CANCELLED, order)
                break
            else:
                break

        ledger = gateway.ledger
        metrics = compute_metrics(trace, ledger)
        evaluation = evaluate_state(order, ledger, trace)
        return SimulationResult(
            agent_name=selected_agent.name,
            scenario=self.config.scenario,
            order=order,
            ledger=ledger,
            trace=tuple(trace),
            metrics=metrics,
            evaluation=evaluation,
        )

    def _payment_request(
        self,
        order: Order,
        idempotency_key: str,
        gateway: _DeterministicPaymentGateway,
        trace: list[TraceEvent],
    ) -> tuple[Order, PaymentOutcome]:
        order = replace(
            order,
            status=OrderStatus.PAYMENT_PENDING,
            attempts=order.attempts + 1,
        )
        self._emit(
            trace,
            TraceEventType.PAYMENT_REQUESTED,
            order,
            attempt=order.attempts,
            idempotency_key=idempotency_key,
        )
        result = gateway.request(order, idempotency_key)

        if result.charged and result.receipt is not None:
            self._emit(
                trace,
                TraceEventType.LEDGER_CHARGED,
                order,
                payment_id=result.receipt.payment_id,
                amount=result.receipt.amount,
                currency=result.receipt.currency,
                idempotency_key=idempotency_key,
            )

        if result.outcome is PaymentOutcome.TIMEOUT:
            self._emit(
                trace,
                TraceEventType.PAYMENT_TIMEOUT,
                order,
                attempt=order.attempts,
                idempotency_key=idempotency_key,
            )
            return order, result.outcome

        self._emit(
            trace,
            TraceEventType.PAYMENT_RESPONSE,
            order,
            outcome=result.outcome.value,
            replayed=result.replayed,
            idempotency_key=idempotency_key,
        )
        if result.outcome is PaymentOutcome.SUCCESS and result.receipt is not None:
            order = replace(
                order,
                status=OrderStatus.PAID,
                payment_id=result.receipt.payment_id,
            )
            self._emit(trace, TraceEventType.PAYMENT_SUCCEEDED, order, replayed=result.replayed)
        else:
            order = replace(order, status=OrderStatus.PAYMENT_FAILED)
            self._emit(trace, TraceEventType.PAYMENT_FAILED, order, outcome=result.outcome.value)
        return order, result.outcome

    def _reconcile(
        self,
        order: Order,
        idempotency_key: str,
        gateway: _DeterministicPaymentGateway,
        trace: list[TraceEvent],
    ) -> tuple[Order, PaymentOutcome]:
        result = gateway.reconcile(idempotency_key)
        self._emit(
            trace,
            TraceEventType.PAYMENT_RECONCILED,
            order,
            outcome=result.outcome.value,
            idempotency_key=idempotency_key,
            payment_id=result.receipt.payment_id if result.receipt else None,
        )
        if result.outcome is PaymentOutcome.SUCCESS and result.receipt is not None:
            order = replace(
                order,
                status=OrderStatus.PAID,
                payment_id=result.receipt.payment_id,
            )
            self._emit(trace, TraceEventType.PAYMENT_SUCCEEDED, order, source="reconciliation")
        else:
            order = replace(order, status=OrderStatus.PAYMENT_FAILED)
            self._emit(trace, TraceEventType.PAYMENT_FAILED, order, outcome=result.outcome.value)
        return order, result.outcome

    def _emit(
        self,
        trace: list[TraceEvent],
        event_type: TraceEventType,
        order: Order,
        **attributes: str | int | float | bool | None,
    ) -> None:
        event = ExecutionEvent(
            index=len(trace),
            tick=len(trace),
            event_type=event_type,
            order_id=order.order_id,
            attributes=attributes,
        )
        trace.append(event)
        if self._on_event is not None:
            self._on_event(event)
        self._check_cancel()

    def _check_cancel(self) -> None:
        if self._should_cancel is not None and self._should_cancel():
            raise ExecutionCancelled


def simulate(
    scenario: FaultScenario = FaultScenario.NORMAL,
    *,
    agent: Agent | None = None,
    config: SimulationConfig | None = None,
) -> SimulationResult:
    """Convenience API for one deterministic run."""

    selected_config = config or SimulationConfig(scenario=scenario)
    return DeterministicEngine(selected_config).run(agent)
