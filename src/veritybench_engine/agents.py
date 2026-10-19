"""Sample deterministic agents used by the engine and benchmark tests."""

from __future__ import annotations

from typing import Protocol

from .models import AgentAction, AgentContext, AgentDecision, OrderStatus, PaymentOutcome


class Agent(Protocol):
    """Reusable decision interface for CLI/API callers and test agents."""

    @property
    def name(self) -> str:
        ...

    def decide(self, context: AgentContext) -> AgentDecision:
        ...


class SafeSampleAgent:
    """A conservative agent that reconciles uncertain payments before acting."""

    @property
    def name(self) -> str:
        return "safe-sample-agent"

    def decide(self, context: AgentContext) -> AgentDecision:
        order = context.order

        if order.status is OrderStatus.CREATED:
            return AgentDecision(
                action=AgentAction.START_PAYMENT,
                idempotency_key=order.idempotency_key,
                rationale="start the payment with a stable idempotency key",
            )

        if order.status is OrderStatus.PAYMENT_PENDING:
            if context.last_outcome is PaymentOutcome.TIMEOUT:
                return AgentDecision(
                    action=AgentAction.RECONCILE_PAYMENT,
                    idempotency_key=order.idempotency_key,
                    rationale="reconcile the provider record after a lost response",
                )
            return AgentDecision(
                action=AgentAction.CANCEL_ORDER,
                rationale="cancel an order whose payment state cannot be established",
            )

        if order.status is OrderStatus.PAYMENT_FAILED:
            if (
                context.last_outcome in {PaymentOutcome.TEMPORARY_FAILURE, PaymentOutcome.RATE_LIMITED}
                and order.attempts <= context.max_retries
            ):
                return AgentDecision(
                    action=AgentAction.RETRY_PAYMENT,
                    idempotency_key=order.idempotency_key,
                    rationale="retry a transient or rate-limited failure with the same idempotency key",
                )
            return AgentDecision(
                action=AgentAction.CANCEL_ORDER,
                rationale="stop after a non-retryable or exhausted payment failure",
            )

        if order.status is OrderStatus.PAID:
            return AgentDecision(
                action=AgentAction.FULFILL_ORDER,
                rationale="fulfill only after the payment is settled",
            )

        return AgentDecision(action=AgentAction.STOP, rationale="the order is already terminal")


class DefectiveSampleAgent:
    """An intentionally unsafe agent for validating the evaluator.

    It retries a timeout with a new idempotency key and treats malformed
    responses as permission to fulfill.  Both behaviors should be visible in
    the resulting ledger/trace and rejected by independent evaluation.
    """

    @property
    def name(self) -> str:
        return "defective-sample-agent"

    def decide(self, context: AgentContext) -> AgentDecision:
        order = context.order

        if order.status is OrderStatus.CREATED:
            return AgentDecision(
                action=AgentAction.START_PAYMENT,
                idempotency_key=order.idempotency_key,
                rationale="start payment",
            )

        if order.status is OrderStatus.PAYMENT_PENDING:
            if context.last_outcome is PaymentOutcome.TIMEOUT:
                return AgentDecision(
                    action=AgentAction.RETRY_PAYMENT,
                    idempotency_key=f"{order.idempotency_key}:retry:{order.attempts + 1}",
                    rationale="retry without reconciling the uncertain payment",
                )
            return AgentDecision(action=AgentAction.STOP, rationale="stop on an unexpected pending state")

        if order.status is OrderStatus.PAYMENT_FAILED:
            if context.last_outcome in {PaymentOutcome.MALFORMED_RESPONSE, PaymentOutcome.MALFORMED_TOOL_RESPONSE}:
                return AgentDecision(
                    action=AgentAction.FULFILL_ORDER,
                    rationale="incorrectly trust a malformed payment response",
                )
            if (
                context.last_outcome in {PaymentOutcome.TEMPORARY_FAILURE, PaymentOutcome.RATE_LIMITED}
                and order.attempts <= context.max_retries
            ):
                return AgentDecision(
                    action=AgentAction.RETRY_PAYMENT,
                    idempotency_key=order.idempotency_key,
                    rationale="retry a temporary failure",
                )
            return AgentDecision(action=AgentAction.CANCEL_ORDER, rationale="cancel after failure")

        if order.status is OrderStatus.PAID:
            return AgentDecision(action=AgentAction.FULFILL_ORDER, rationale="fulfill paid order")

        return AgentDecision(action=AgentAction.STOP, rationale="the order is already terminal")


SafeAgent = SafeSampleAgent
DefectiveAgent = DefectiveSampleAgent
