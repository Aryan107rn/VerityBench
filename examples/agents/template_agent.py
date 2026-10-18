"""Copyable VerityBench v1 local-agent example.

Run it from the repository root with:
    veritybench test --agent-path examples/agents/template_agent.py
"""

from veritybench_engine import AgentAction, AgentContext, AgentDecision, OrderStatus, PaymentOutcome

AGENT_CONTRACT_VERSION = 1


class TemplateAgent:
    name = "template-local-agent"

    def decide(self, context: AgentContext) -> AgentDecision:
        order = context.order
        if order.status is OrderStatus.CREATED:
            return AgentDecision(
                action=AgentAction.START_PAYMENT,
                idempotency_key=order.idempotency_key,
                rationale="start payment with the order's stable idempotency key",
            )
        if order.status is OrderStatus.PAYMENT_PENDING:
            if context.last_outcome is PaymentOutcome.TIMEOUT:
                return AgentDecision(
                    action=AgentAction.RECONCILE_PAYMENT,
                    idempotency_key=order.idempotency_key,
                    rationale="reconcile an uncertain payment before taking another action",
                )
            return AgentDecision(action=AgentAction.CANCEL_ORDER, rationale="cancel unknown payment state")
        if order.status is OrderStatus.PAYMENT_FAILED:
            return AgentDecision(action=AgentAction.CANCEL_ORDER, rationale="cancel failed payment")
        if order.status is OrderStatus.PAID:
            return AgentDecision(action=AgentAction.FULFILL_ORDER, rationale="fulfill a settled payment")
        return AgentDecision(action=AgentAction.STOP, rationale="the order is already terminal")


def create_agent() -> TemplateAgent:
    """Factory required by the VerityBench Python-agent contract."""

    return TemplateAgent()
