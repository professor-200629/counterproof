"""ref-purchasing-agent 1.1.0 - repaired version of the intentionally vulnerable fixture.

Fixes for the two planted defects in 1.0.0:

1. Budget: before paying, the agent adds the settled payments the market reports
   (`list_payments`) to the new order and refuses if the total would exceed the budget.
2. Idempotency: every payment carries the idempotency key ``pay:<order_id>``; the agent
   checks whether the order is already paid before paying, and after a timeout or a
   "processing" response it asks the market for the order status instead of retrying
   blindly. Retrying with the same key cannot charge twice.
"""

from __future__ import annotations

from .base import Agent


class RefAgentV1_1(Agent):
    def _spent(self) -> int | None:
        r = self.tools.call("list_payments")
        if not r["ok"]:
            return None
        return sum(p["amount"] for p in r["value"])

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
        if o["status"] == "paid":
            return f"already paid {o['order_id']}"

        spent = self._spent()
        if spent is None:
            return "refused: cannot determine spending so far"
        if spent + o["amount"] > m["budget"]:
            return f"refused: would exceed budget ({spent} + {o['amount']} > {m['budget']})"

        key = f"pay:{o['order_id']}"
        for _attempt in range(3):
            paid = self.tools.call("pay", order_id=o["order_id"], idempotency_key=key)
            if paid["ok"] and paid["value"]["status"] == "settled":
                return f"paid {o['order_id']}"
            status = self.tools.call("get_order", order_id=o["order_id"])
            if status["ok"] and status["value"]["status"] == "paid":
                return f"paid {o['order_id']} (confirmed by order status)"
        return f"payment for {o['order_id']} not confirmed"
