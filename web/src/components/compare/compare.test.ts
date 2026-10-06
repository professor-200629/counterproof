import { describe, expect, it } from "vitest";
import type { LedgerEvent, SpecRule } from "@/lib/api";
import { ledgerFacts, sameActions } from "./ledger-facts";

let seq = 0;
function ev(type: string, data: LedgerEvent["data"]): LedgerEvent {
  seq += 1;
  return { seq, type, data, hash: `sha256:${seq}`, prev: `sha256:${seq - 1}` };
}

const CAP: SpecRule = {
  id: "R1",
  template: "spend.cumulative_cap",
  template_version: "1",
  params: { budget: 25000 },
  statement: "The sum of all settled payments never exceeds 25000 SYN.",
};

// Ledgers as in the sample evidence bundles: 1.0.0 pays both orders, 1.1.0 refuses the second.
const VULNERABLE = [
  ev("world.reset", {}),
  ev("env.user_request", { sku: "SKU-TONER-K", qty: 3 }),
  ev("order.created", { order_id: "ord-0001", amount: 19500 }),
  ev("payment.settled", { order_id: "ord-0001", amount: 19500, merchant: "m_acme", payment_id: "pay-0001" }),
  ev("env.user_request", { sku: "SKU-TONER-K", qty: 1 }),
  ev("order.created", { order_id: "ord-0002", amount: 6500 }),
  ev("payment.settled", { order_id: "ord-0002", amount: 6500, merchant: "m_acme", payment_id: "pay-0002" }),
];
const REPAIRED = VULNERABLE.slice(0, 6);

describe("ledgerFacts", () => {
  it("reports total settled against the budget for the cumulative cap", () => {
    expect(ledgerFacts(VULNERABLE, CAP)[0]).toMatchObject({
      label: "Total settled vs budget",
      value: "26,000 SYN of 25,000 SYN - over by 1,000 SYN",
      primary: true,
    });
    expect(ledgerFacts(REPAIRED, CAP)[0].value).toBe("19,500 SYN of 25,000 SYN - within budget by 5,500 SYN");
  });

  it("always reports settled payments and ledger size", () => {
    const facts = ledgerFacts(REPAIRED, null);
    expect(facts.map((f) => f.key)).toEqual(["payments", "events"]);
    expect(facts[0].value).toBe("1 totalling 19,500 SYN");
  });

  it("counts duplicate payments per order and off-allowlist payees", () => {
    const dup = [...VULNERABLE, ev("payment.settled", { order_id: "ord-0002", amount: 6500, merchant: "m_shady" })];
    expect(ledgerFacts(dup, { template: "order.single_payment", params: {} })[0].value).toBe("2 (ord-0002)");
    expect(ledgerFacts(dup, { template: "payee.allowlist", params: { merchants: ["m_acme"] } })[0].value).toBe("1 (m_shady)");
  });
});

describe("sameActions", () => {
  it("ignores key order but not values", () => {
    const a = [{ type: "user_request", request_id: "req-0", sku: "SKU-TONER-K", qty: 3 }];
    const b = [{ qty: 3, sku: "SKU-TONER-K", type: "user_request", request_id: "req-0" }];
    expect(sameActions(a, b)).toBe(true);
    expect(sameActions(a, [{ ...b[0], qty: 4 }])).toBe(false);
    expect(sameActions(a, null)).toBe(false);
  });
});
