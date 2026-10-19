"""VerityBench Python agent starter."""

from veritybench_engine import AgentAction, AgentContext, AgentDecision, OrderStatus, PaymentOutcome

AGENT_CONTRACT_VERSION = 1


class MyAgent:
    name = "my-agent"

    def decide(self, context: AgentContext) -> AgentDecision:
        if context.order.status is OrderStatus.CREATED:
            return AgentDecision(
                action=AgentAction.START_PAYMENT,
                idempotency_key=context.order.idempotency_key,
                rationale="start payment with a stable idempotency key",
            )
        if context.order.status is OrderStatus.PAYMENT_PENDING and context.last_outcome is PaymentOutcome.TIMEOUT:
            return AgentDecision(
                action=AgentAction.RECONCILE_PAYMENT,
                idempotency_key=context.order.idempotency_key,
                rationale="reconcile an uncertain payment before retrying",
            )
        if context.order.status is OrderStatus.PAID:
            return AgentDecision(action=AgentAction.FULFILL_ORDER, rationale="fulfill a settled payment")
        return AgentDecision(action=AgentAction.CANCEL_ORDER, rationale="stop on an unsafe or failed state")


def create_agent() -> MyAgent:
    return MyAgent()
