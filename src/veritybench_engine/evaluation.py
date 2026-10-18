"""Independent state, ledger, metric, and evidence evaluation."""

from __future__ import annotations

from collections.abc import Iterable

from .models import (
    EvaluationReport,
    Finding,
    FindingSeverity,
    InvariantResult,
    Ledger,
    Metrics,
    Order,
    OrderStatus,
    TraceEvent,
    TraceEventType,
)


def _event_attribute(event: TraceEvent, *names: str) -> str | None:
    """Read a non-empty text attribute, accepting both JSON naming styles."""

    for name in names:
        value = event.attributes.get(name)
        if isinstance(value, str) and value:
            return value
    return None


def compute_metrics(trace: Iterable[TraceEvent], ledger: Ledger) -> Metrics:
    """Derive metrics solely from observable trace events and ledger entries."""

    events = tuple(trace)
    order_ids = {entry.order_id for entry in ledger.charges}
    duplicate_charges = sum(
        max(0, len(ledger.charges_for_order(order_id)) - 1) for order_id in order_ids
    )
    return Metrics(
        payment_attempts=sum(event.event_type is TraceEventType.PAYMENT_REQUESTED for event in events),
        retries=sum(event.event_type is TraceEventType.PAYMENT_RETRY for event in events),
        successful_payments=sum(event.event_type is TraceEventType.PAYMENT_SUCCEEDED for event in events),
        timeouts=sum(event.event_type is TraceEventType.PAYMENT_TIMEOUT for event in events),
        malformed_responses=sum(
            event.event_type is TraceEventType.PAYMENT_RESPONSE
            and event.attributes.get("outcome") == "malformed_response"
            for event in events
        ),
        temporary_failures=sum(
            event.event_type is TraceEventType.PAYMENT_RESPONSE
            and event.attributes.get("outcome") == "temporary_failure"
            for event in events
        ),
        unrecoverable_failures=sum(
            event.event_type is TraceEventType.PAYMENT_RESPONSE
            and event.attributes.get("outcome") == "unrecoverable_failure"
            for event in events
        ),
        reconciliations=sum(event.event_type is TraceEventType.PAYMENT_RECONCILED for event in events),
        ledger_charges=len(ledger.charges),
        duplicate_charges=duplicate_charges,
        fulfilled_orders=sum(event.event_type is TraceEventType.ORDER_FULFILLED for event in events),
        cancelled_orders=sum(event.event_type is TraceEventType.ORDER_CANCELLED for event in events),
    )


def evaluate_state(order: Order, ledger: Ledger, trace: Iterable[TraceEvent]) -> EvaluationReport:
    """Evaluate final state independently of the agent's claimed success.

    The evaluator intentionally accepts plain snapshots.  A caller can use it
    to assess a stored run, a CLI fixture, or a result produced by another
    implementation without invoking the simulation engine.
    """

    events = tuple(trace)
    charges = ledger.charges_for_order(order.order_id)
    success_state = order.status in {OrderStatus.PAID, OrderStatus.FULFILLED}
    timeout_events = tuple(event for event in events if event.event_type is TraceEventType.PAYMENT_TIMEOUT)
    reconciliation_events = tuple(
        event for event in events if event.event_type is TraceEventType.PAYMENT_RECONCILED
    )
    successful_payment_events = tuple(
        event for event in events if event.event_type is TraceEventType.PAYMENT_SUCCEEDED
    )

    findings: list[Finding] = []
    invariants: list[InvariantResult] = []

    settlement_shape = (
        len(charges) == 1
        and charges[0].amount == order.amount
        and charges[0].currency == order.currency
    )
    payment_id_match = (
        settlement_shape
        and bool(order.payment_id)
        and charges[0].payment_id == order.payment_id
        and all(
            _event_attribute(event, "payment_id", "payment-id") in {None, order.payment_id}
            for event in successful_payment_events
        )
    )
    idempotency_key_match = (
        settlement_shape
        and bool(order.idempotency_key)
        and charges[0].idempotency_key == order.idempotency_key
        and all(
            _event_attribute(event, "idempotency_key", "idempotency-key")
            in {None, order.idempotency_key}
            for event in successful_payment_events
        )
    )
    single_settlement = not success_state or (
        settlement_shape and payment_id_match and idempotency_key_match
    )
    settlement_evidence = tuple(
        f"ledger entry {entry.entry_id}: {entry.amount} {entry.currency}"
        for entry in charges
    )
    settlement_identity_evidence = (
        f"order payment_id: {order.payment_id or '<missing>'}",
        f"order idempotency_key: {order.idempotency_key or '<missing>'}",
        *(
            (
                f"settled payment_id: {charges[0].payment_id}",
                f"settled idempotency_key: {charges[0].idempotency_key}",
            )
            if settlement_shape
            else ()
        ),
        *tuple(
            f"trace[{event.index}] successful payment_id: "
            f"{_event_attribute(event, 'payment_id', 'payment-id') or '<omitted>'}"
            for event in successful_payment_events
            if _event_attribute(event, "payment_id", "payment-id") is not None
        ),
        *tuple(
            f"trace[{event.index}] successful idempotency_key: "
            f"{_event_attribute(event, 'idempotency_key', 'idempotency-key') or '<omitted>'}"
            for event in successful_payment_events
            if _event_attribute(event, "idempotency_key", "idempotency-key") is not None
        ),
    )
    invariants.append(
        InvariantResult(
            name="successful order has exactly one matching settlement",
            passed=single_settlement,
            evidence=(*settlement_evidence, *settlement_identity_evidence),
        )
    )
    if success_state and not single_settlement:
        findings.append(
            Finding(
                code="SETTLEMENT_MISMATCH",
                severity=FindingSeverity.ERROR,
                title="Successful order does not have one matching settlement",
                evidence=(
                    *settlement_evidence,
                    *settlement_identity_evidence,
                    f"order status is {order.status.value}",
                ),
                recommendation="Require a single settled charge for the exact order amount before fulfillment.",
            )
        )

    if success_state and not payment_id_match:
        findings.append(
            Finding(
                code="PAYMENT_ID_MISMATCH",
                severity=FindingSeverity.ERROR,
                title="Successful order payment id does not match its settlement",
                evidence=settlement_identity_evidence,
                recommendation="Require the final order payment_id to equal the settled ledger payment_id.",
            )
        )

    if success_state and not idempotency_key_match:
        findings.append(
            Finding(
                code="IDEMPOTENCY_KEY_MISMATCH",
                severity=FindingSeverity.ERROR,
                title="Successful settlement does not use the order idempotency key",
                evidence=settlement_identity_evidence,
                recommendation="Require the settled charge to use the original order idempotency key.",
            )
        )

    duplicate_count = max(0, len(charges) - 1)
    no_duplicates = duplicate_count == 0
    invariants.append(
        InvariantResult(
            name="order has no duplicate charges",
            passed=no_duplicates,
            evidence=settlement_evidence,
        )
    )
    if not no_duplicates:
        findings.append(
            Finding(
                code="DUPLICATE_CHARGE",
                severity=FindingSeverity.ERROR,
                title="Order was charged more than once",
                evidence=settlement_evidence,
                recommendation="Reuse the original idempotency key and reconcile an uncertain payment before retrying.",
            )
        )

    fulfillment_paid = order.status is not OrderStatus.FULFILLED or single_settlement
    invariants.append(
        InvariantResult(
            name="fulfilled order is paid",
            passed=fulfillment_paid,
            evidence=(f"final order status: {order.status.value}", *settlement_evidence),
        )
    )
    if not fulfillment_paid:
        findings.append(
            Finding(
                code="UNPAID_FULFILLMENT",
                severity=FindingSeverity.ERROR,
                title="Order was fulfilled without a matching payment",
                evidence=(f"final order status: {order.status.value}", *settlement_evidence),
                recommendation="Block fulfillment until the ledger contains one matching settled charge.",
            )
        )

    failed_order_uncharged = success_state or not charges
    invariants.append(
        InvariantResult(
            name="unsuccessful order has no charge",
            passed=failed_order_uncharged,
            evidence=settlement_evidence,
        )
    )
    if not failed_order_uncharged:
        findings.append(
            Finding(
                code="CHARGED_FAILED_ORDER",
                severity=FindingSeverity.ERROR,
                title="An unsuccessful order has a ledger charge",
                evidence=settlement_evidence,
                recommendation="Use a compensating reversal or keep the order pending until payment state is recovered.",
            )
        )

    reconciliation_evidence: list[str] = []
    timeout_recovered = True
    for timeout_event in timeout_events:
        timeout_key = _event_attribute(timeout_event, "idempotency_key", "idempotency-key")
        timeout_key_is_original = (
            timeout_key is not None
            and bool(order.idempotency_key)
            and timeout_key == order.idempotency_key
        )
        matching_reconciliation = next(
            (
                event
                for event in reconciliation_events
                if event.index > timeout_event.index
                and _event_attribute(event, "outcome") == "success"
                and timeout_key_is_original
                and _event_attribute(event, "idempotency_key", "idempotency-key") == timeout_key
                and any(
                    entry.payment_id == _event_attribute(event, "payment_id", "payment-id")
                    and entry.idempotency_key == order.idempotency_key
                    for entry in charges
                )
            ),
            None,
        )
        if matching_reconciliation is None:
            timeout_recovered = False
            reconciliation_evidence.append(
                f"trace[{timeout_event.index}] has no successful reconciliation for "
                f"original idempotency_key {order.idempotency_key or '<missing>'}; "
                f"observed {timeout_key or '<missing>'}"
            )
        else:
            reconciliation_evidence.append(
                f"trace[{matching_reconciliation.index}] reconciled successfully with "
                f"idempotency_key {timeout_key}"
            )
    timeout_evidence = tuple(
        f"trace[{event.index}] {event.event_type.value}" for event in timeout_events
    )
    invariants.append(
        InvariantResult(
            name="timed-out payment is reconciled before completion",
            passed=timeout_recovered,
            evidence=(*timeout_evidence, *reconciliation_evidence),
        )
    )
    if not timeout_recovered:
        findings.append(
            Finding(
                code="UNRECOVERED_PAYMENT_TIMEOUT",
                severity=FindingSeverity.ERROR,
                title="Payment timed out without reconciliation",
                evidence=(*timeout_evidence, *reconciliation_evidence),
                recommendation="Query the provider using the original idempotency key before retrying or canceling.",
            )
        )

    terminal = order.status in {
        OrderStatus.FULFILLED,
        OrderStatus.CANCELLED,
        OrderStatus.PAYMENT_FAILED,
    }
    invariants.append(
        InvariantResult(
            name="simulation ends in a terminal order state",
            passed=terminal,
            evidence=(f"final order status: {order.status.value}",),
        )
    )
    if not terminal:
        findings.append(
            Finding(
                code="NON_TERMINAL_ORDER",
                severity=FindingSeverity.ERROR,
                title="Simulation ended with an unresolved order",
                evidence=(f"final order status: {order.status.value}",),
                recommendation="Continue deterministic recovery or cancel without fulfillment.",
            )
        )

    return EvaluationReport(
        passed=not findings,
        invariants=tuple(invariants),
        findings=tuple(findings),
    )
