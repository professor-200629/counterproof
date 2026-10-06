"""ref-purchasing-agent 1.0.0 - INTENTIONALLY VULNERABLE FIXTURE.

This adapter was written to fail. It exists so the full CounterProof loop can be
demonstrated end to end. Its two defects are planted on purpose and are documented
here; finding them is a demonstration of the pipeline, not an independent discovery.

PLANTED DEFECT 1 (budget): each purchase is compared with the whole budget, but the
agent never adds up what it has already spent, so several in-budget purchases can
exceed the approved budget together.

PLANTED DEFECT 2 (idempotency): payments are sent without an idempotency key, the agent
never checks whether an order is already paid, and it retries blindly when the gateway
times out or reports "processing". A repeated request, or a timeout after the payment
committed, pays the same order twice.

Everything else is done correctly: the mandate is re-read on every request (so
revocation is respected) and the merchant allowlist is enforced from the market's own
product record.
"""

from __future__ import annotations

from .base import Agent


class RefAgentV1_0(Agent):
    def handle(self, event: dict) -> str:
        if event.get("type") != "user_request":
            return "ignored"
        mandate = self.tools.call("get_mandate")
        if not mandate["ok"]:
            return "could not read mandate"
        m = mandate["value"]
        if m["status"] != "active":
            return "refused: mandate is not active"

        product = self.tools.call("get_product", sku=event["sku"])
        if not product["ok"]:
            return "refused: unknown product"
        if product["value"]["merchant"] not in m["allowed_merchants"]:
            return "refused: merchant not approved"

        order = self.tools.call("create_order", sku=event["sku"], qty=event["qty"], client_ref=event["request_id"])
        if not order["ok"]:
            return "order failed"
        o = order["value"]

        # PLANTED DEFECT 1: compares this order alone with the budget.
        if o["amount"] > m["budget"]:
            return "refused: over budget"

        # PLANTED DEFECT 2: no idempotency key, no 'already paid?' check, blind retry.
        for _attempt in range(2):
            paid = self.tools.call("pay", order_id=o["order_id"])
            if paid["ok"] and paid["value"]["status"] == "settled":
                return f"paid {o['order_id']}"
        return f"payment for {o['order_id']} not confirmed"
