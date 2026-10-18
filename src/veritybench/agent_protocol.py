"""Serialization helpers for the decision-only sandbox protocol."""

from __future__ import annotations

from veritybench_engine import (
    AgentAction,
    AgentContext,
    AgentDecision,
    FaultScenario,
    Order,
    OrderStatus,
    PaymentOutcome,
)


def context_to_dict(context: AgentContext) -> dict[str, object]:
    return {
        "order": {
            "order_id": context.order.order_id,
            "amount": context.order.amount,
            "currency": context.order.currency,
            "status": context.order.status.value,
            "attempts": context.order.attempts,
            "payment_id": context.order.payment_id,
            "idempotency_key": context.order.idempotency_key,
        },
        "scenario": context.scenario.value,
        "last_outcome": context.last_outcome.value if context.last_outcome is not None else None,
        "max_retries": context.max_retries,
    }


def context_from_dict(payload: object) -> AgentContext:
    if not isinstance(payload, dict):
        raise ValueError("decision context must be an object")
    order_payload = payload.get("order")
    if not isinstance(order_payload, dict):
        raise ValueError("decision context order must be an object")
    order = Order(
        order_id=str(order_payload["order_id"]),
        amount=int(order_payload["amount"]),
        currency=str(order_payload["currency"]),
        status=OrderStatus(str(order_payload["status"])),
        attempts=int(order_payload.get("attempts", 0)),
        payment_id=(
            str(order_payload["payment_id"])
            if order_payload.get("payment_id") is not None
            else None
        ),
        idempotency_key=str(order_payload.get("idempotency_key", "")),
    )
    outcome = payload.get("last_outcome")
    return AgentContext(
        order=order,
        scenario=FaultScenario(str(payload["scenario"])),
        last_outcome=PaymentOutcome(str(outcome)) if outcome is not None else None,
        max_retries=int(payload["max_retries"]),
    )


def decision_to_dict(decision: AgentDecision) -> dict[str, object]:
    return {
        "action": decision.action.value,
        "rationale": decision.rationale,
        "idempotency_key": decision.idempotency_key,
    }


def decision_from_dict(payload: object) -> AgentDecision:
    if not isinstance(payload, dict):
        raise ValueError("decision must be an object")
    return AgentDecision(
        action=AgentAction(str(payload["action"])),
        rationale=str(payload["rationale"]),
        idempotency_key=(
            str(payload["idempotency_key"])
            if payload.get("idempotency_key") is not None
            else None
        ),
    )
