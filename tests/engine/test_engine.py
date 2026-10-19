from __future__ import annotations

import pytest

from veritybench_engine import (
    EXECUTION_EVENT_SCHEMA_VERSION,
    DefectiveSampleAgent,
    DeterministicEngine,
    ExecutionEvent,
    FaultScenario,
    Ledger,
    LedgerEntry,
    LedgerEntryType,
    Order,
    OrderStatus,
    SafeSampleAgent,
    SimulationConfig,
    TraceEventType,
    evaluate_state,
    simulate,
)


def event_types(result):
    return [event.event_type for event in result.trace]


def test_normal_operation_fulfills_once_and_is_evaluated_from_ledger():
    result = simulate()

    assert result.order.status is OrderStatus.FULFILLED
    assert result.order.attempts == 1
    assert len(result.ledger.charges) == 1
    assert result.ledger.total_charged == 100
    assert result.metrics.payment_attempts == 1
    assert result.metrics.successful_payments == 1
    assert result.metrics.ledger_charges == 1
    assert result.evaluation.passed
    assert TraceEventType.ORDER_FULFILLED in event_types(result)


def test_engine_emits_versioned_events_in_trace_order() -> None:
    emitted: list[ExecutionEvent] = []

    result = DeterministicEngine().run(on_event=emitted.append)

    assert emitted == list(result.trace)
    assert [event.sequence for event in emitted] == list(range(len(emitted)))
    assert all(event.schema_version == EXECUTION_EVENT_SCHEMA_VERSION for event in emitted)
    assert emitted[0].payload == emitted[0].attributes


def test_timeout_after_success_is_reconciled_without_a_second_charge():
    result = simulate(FaultScenario.TIMEOUT_AFTER_SUCCESS, agent=SafeSampleAgent())

    assert result.order.status is OrderStatus.FULFILLED
    assert result.order.attempts == 1
    assert len(result.ledger.charges) == 1
    assert result.metrics.timeouts == 1
    assert result.metrics.reconciliations == 1
    assert result.metrics.duplicate_charges == 0
    assert result.evaluation.passed
    assert TraceEventType.PAYMENT_RECONCILED in event_types(result)


def test_defective_timeout_retry_is_detected_with_ledger_evidence():
    result = simulate(FaultScenario.TIMEOUT_AFTER_SUCCESS, agent=DefectiveSampleAgent())

    assert result.order.status is OrderStatus.FULFILLED
    assert len(result.ledger.charges) == 2
    assert result.metrics.duplicate_charges == 1
    assert not result.evaluation.passed
    finding = next(item for item in result.evaluation.findings if item.code == "DUPLICATE_CHARGE")
    assert finding.evidence == (
        "ledger entry ledger-001: 100 USD",
        "ledger entry ledger-002: 100 USD",
    )
    assert "idempotency" in finding.recommendation


def test_temporary_failure_retries_and_then_succeeds():
    result = simulate(FaultScenario.TEMPORARY_FAILURE)

    assert result.order.status is OrderStatus.FULFILLED
    assert result.order.attempts == 2
    assert result.metrics.temporary_failures == 1
    assert result.metrics.retries == 1
    assert result.metrics.successful_payments == 1
    assert len(result.ledger.charges) == 1
    assert result.evaluation.passed


def test_malformed_response_is_safely_cancelled_and_defective_fulfillment_is_flagged():
    safe_result = simulate(FaultScenario.MALFORMED_RESPONSE, agent=SafeSampleAgent())
    defective_result = simulate(FaultScenario.MALFORMED_RESPONSE, agent=DefectiveSampleAgent())

    assert safe_result.order.status is OrderStatus.CANCELLED
    assert safe_result.metrics.malformed_responses == 1
    assert not safe_result.ledger.charges
    assert safe_result.evaluation.passed

    assert defective_result.order.status is OrderStatus.FULFILLED
    assert not defective_result.ledger.charges
    assert not defective_result.evaluation.passed
    assert any(item.code == "UNPAID_FULFILLMENT" for item in defective_result.evaluation.findings)


def test_unrecoverable_failure_is_cancelled_without_a_charge():
    result = simulate(FaultScenario.UNRECOVERABLE_FAILURE)

    assert result.order.status is OrderStatus.CANCELLED
    assert result.metrics.unrecoverable_failures == 1
    assert result.metrics.cancelled_orders == 1
    assert not result.ledger.charges
    assert result.evaluation.passed


def test_evaluation_can_run_against_an_independently_constructed_bad_snapshot():
    order = Order(
        order_id="order-bad",
        amount=100,
        currency="USD",
        status=OrderStatus.FULFILLED,
        attempts=2,
        payment_id="payment-order-bad-002",
        idempotency_key="payment:order-bad",
    )
    ledger = Ledger(
        entries=(
            LedgerEntry(
                entry_id="ledger-001",
                order_id="order-bad",
                payment_id="payment-order-bad-001",
                amount=100,
                currency="USD",
                entry_type=LedgerEntryType.CHARGE,
                idempotency_key="payment:order-bad",
            ),
            LedgerEntry(
                entry_id="ledger-002",
                order_id="order-bad",
                payment_id="payment-order-bad-002",
                amount=100,
                currency="USD",
                entry_type=LedgerEntryType.CHARGE,
                idempotency_key="payment:order-bad:retry:2",
            ),
        )
    )

    report = evaluate_state(order, ledger, ())

    assert not report.passed
    assert {item.code for item in report.findings} >= {
        "DUPLICATE_CHARGE",
        "SETTLEMENT_MISMATCH",
    }


def test_successful_snapshot_requires_matching_payment_id_and_original_key():
    order = Order(
        order_id="order-identity",
        amount=100,
        currency="USD",
        status=OrderStatus.FULFILLED,
        payment_id="payment-order-identity-001",
        idempotency_key="payment:order-identity",
    )
    ledger = Ledger(
        entries=(
            LedgerEntry(
                entry_id="ledger-001",
                order_id=order.order_id,
                payment_id="payment-order-identity-002",
                amount=order.amount,
                currency=order.currency,
                entry_type=LedgerEntryType.CHARGE,
                idempotency_key="payment:order-identity:retry:2",
            ),
        )
    )

    report = evaluate_state(order, ledger, ())

    assert not report.passed
    assert {item.code for item in report.findings} >= {
        "SETTLEMENT_MISMATCH",
        "PAYMENT_ID_MISMATCH",
        "IDEMPOTENCY_KEY_MISMATCH",
    }


def test_success_event_identity_must_agree_with_the_settlement():
    order = Order(
        order_id="order-event-identity",
        amount=100,
        currency="USD",
        status=OrderStatus.PAID,
        payment_id="payment-order-event-identity-001",
        idempotency_key="payment:order-event-identity",
    )
    ledger = Ledger(
        entries=(
            LedgerEntry(
                entry_id="ledger-001",
                order_id=order.order_id,
                payment_id=order.payment_id,
                amount=order.amount,
                currency=order.currency,
                entry_type=LedgerEntryType.CHARGE,
                idempotency_key=order.idempotency_key,
            ),
        )
    )
    trace = (
        ExecutionEvent(
            index=0,
            tick=0,
            event_type=TraceEventType.PAYMENT_SUCCEEDED,
            order_id=order.order_id,
            attributes={
                "payment_id": "payment-order-event-identity-wrong",
                "idempotency_key": order.idempotency_key,
            },
        ),
    )

    report = evaluate_state(order, ledger, trace)

    assert not report.passed
    assert any(item.code == "PAYMENT_ID_MISMATCH" for item in report.findings)


@pytest.mark.parametrize(
    "timeout_key, reconciliation_attributes",
    [
        (
            "payment:order-timeout",
            {
                "outcome": "temporary_failure",
                "idempotency_key": "payment:order-timeout",
                "payment_id": "payment-order-timeout-001",
            },
        ),
        (
            "payment:order-timeout",
            {
                "outcome": "success",
                "idempotency_key": "payment:order-timeout:wrong-key",
                "payment_id": "payment-order-timeout-001",
            },
        ),
        (
            "payment:order-timeout:retry:2",
            {
                "outcome": "success",
                "idempotency_key": "payment:order-timeout:retry:2",
                "payment_id": "payment-order-timeout-001",
            },
        ),
    ],
)
def test_timeout_reconciliation_must_succeed_for_the_original_key(
    timeout_key, reconciliation_attributes
):
    order = Order(
        order_id="order-timeout",
        amount=100,
        currency="USD",
        status=OrderStatus.FULFILLED,
        payment_id="payment-order-timeout-001",
        idempotency_key="payment:order-timeout",
    )
    ledger = Ledger(
        entries=(
            LedgerEntry(
                entry_id="ledger-001",
                order_id=order.order_id,
                payment_id=order.payment_id or "",
                amount=order.amount,
                currency=order.currency,
                entry_type=LedgerEntryType.CHARGE,
                idempotency_key=order.idempotency_key,
            ),
        )
    )
    trace = (
        ExecutionEvent(
            index=0,
            tick=0,
            event_type=TraceEventType.PAYMENT_TIMEOUT,
            order_id=order.order_id,
            attributes={"idempotency_key": timeout_key},
        ),
        ExecutionEvent(
            index=1,
            tick=1,
            event_type=TraceEventType.PAYMENT_RECONCILED,
            order_id=order.order_id,
            attributes=reconciliation_attributes,
        ),
    )

    report = evaluate_state(order, ledger, trace)

    assert not report.passed
    timeout_check = next(
        item for item in report.invariants if item.name == "timed-out payment is reconciled before completion"
    )
    assert not timeout_check.passed
    assert any(item.code == "UNRECOVERED_PAYMENT_TIMEOUT" for item in report.findings)


def test_runs_are_byte_for_byte_stable_as_serializable_records():
    first = simulate(FaultScenario.TIMEOUT_AFTER_SUCCESS).to_dict()
    second = simulate(FaultScenario.TIMEOUT_AFTER_SUCCESS).to_dict()

    assert first == second


@pytest.mark.parametrize(
    "scenario",
    [
        FaultScenario.NORMAL,
        FaultScenario.TIMEOUT_AFTER_SUCCESS,
        FaultScenario.TEMPORARY_FAILURE,
        FaultScenario.TRANSIENT_FAILURE,
        FaultScenario.RATE_LIMITED,
    ],
)
def test_safe_scenarios_end_in_one_charge_or_clean_recovery(scenario):
    result = simulate(scenario)

    assert result.evaluation.passed
    assert result.order.status is OrderStatus.FULFILLED
    assert len(result.ledger.charges) == 1


@pytest.mark.parametrize(
    "scenario",
    [
        FaultScenario.TOOL_EXCEPTION,
        FaultScenario.MALFORMED_TOOL_RESPONSE,
        FaultScenario.CONFLICTING_TOOL_OUTPUT,
        FaultScenario.MALICIOUS_TOOL_OUTPUT,
    ],
)
def test_untrusted_tool_scenarios_cancel_without_a_charge(scenario):
    result = simulate(scenario)

    assert result.evaluation.passed
    assert result.order.status is OrderStatus.CANCELLED
    assert not result.ledger.charges
    if scenario is FaultScenario.MALFORMED_TOOL_RESPONSE:
        assert result.metrics.malformed_tool_responses == 1


def test_retry_exhaustion_is_bounded_and_records_configured_evidence():
    result = simulate(
        FaultScenario.RETRY_EXHAUSTION,
        config=SimulationConfig(
            scenario=FaultScenario.RETRY_EXHAUSTION,
            max_retries=2,
            parameters={"failure_count": 4},
        ),
    )

    assert result.evaluation.passed
    assert result.order.status is OrderStatus.CANCELLED
    assert result.metrics.temporary_failures == 3
    assert result.scenario_parameters["failure_count"] == 4
    assert result.execution_limits == {"max_retries": 2, "max_steps": 20}


def test_scenario_parameters_are_validated_and_runs_are_reproducible():
    config = SimulationConfig(
        scenario=FaultScenario.RATE_LIMITED,
        seed=42,
        parameters={"failure_count": 2},
    )
    first = simulate(config=config).to_dict()
    second = simulate(config=config).to_dict()

    assert first == second
    with pytest.raises(ValueError, match="unsupported parameters"):
        SimulationConfig(scenario=FaultScenario.NORMAL, parameters={"failure_count": 1})
