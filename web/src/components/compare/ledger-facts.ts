/**
 * Display-only facts computed from a replay's ledger (the evaluator-side market's
 * authoritative event log in the evidence bundle). They mirror what the checker looks at
 * for each rule template so the two versions can be compared side by side. The verdict
 * itself always comes from the evaluator's checker, never from these numbers.
 */
import type { CandidateAction, EvidenceBundle, EvidenceReplay, LedgerEvent, SpecRule } from "@/lib/api";
import { formatNumber, formatSyn } from "@/lib/format";
import { asNumber, asString, asStringList } from "@/lib/json";

export interface LedgerFact {
  key: string;
  label: string;
  value: string;
  /** Set when the fact is the rule's own measure (e.g. total settled vs budget). */
  primary?: boolean;
}

function settled(ledger: LedgerEvent[]): LedgerEvent[] {
  return ledger.filter((e) => e.type === "payment.settled");
}

/** Facts for one replay ledger, focused on `rule` (the claimed rule). */
export function ledgerFacts(ledger: LedgerEvent[], rule: Pick<SpecRule, "template" | "params"> | null, currency = "SYN"): LedgerFact[] {
  const pays = settled(ledger);
  const total = pays.reduce((sum, e) => sum + (asNumber(e.data.amount) ?? 0), 0);
  const facts: LedgerFact[] = [];

  switch (rule?.template) {
    case "spend.cumulative_cap": {
      const budget = asNumber(rule.params.budget);
      if (budget !== null) {
        const diff = total - budget;
        facts.push({
          key: "cap",
          label: "Total settled vs budget",
          value: `${formatSyn(total, currency)} of ${formatSyn(budget, currency)} - ${diff > 0 ? `over by ${formatSyn(diff, currency)}` : `within budget by ${formatSyn(-diff, currency)}`}`,
          primary: true,
        });
      }
      break;
    }
    case "payee.allowlist": {
      const allowed = new Set(asStringList(rule.params.merchants));
      const outside = pays.filter((e) => !allowed.has(asString(e.data.merchant) ?? ""));
      facts.push({
        key: "allow",
        label: "Payments to merchants outside the allowlist",
        value: outside.length
          ? `${formatNumber(outside.length)} (${[...new Set(outside.map((e) => asString(e.data.merchant) ?? "?"))].join(", ")})`
          : "0",
        primary: true,
      });
      break;
    }
    case "order.single_payment": {
      const byOrder = new Map<string, number>();
      for (const e of pays) {
        const id = asString(e.data.order_id) ?? "?";
        byOrder.set(id, (byOrder.get(id) ?? 0) + 1);
      }
      let worst: [string, number] | null = null;
      for (const entry of byOrder) if (!worst || entry[1] > worst[1]) worst = entry;
      facts.push({
        key: "single",
        label: "Most settled payments for one order",
        value: worst ? `${formatNumber(worst[1])} (${worst[0]})` : "0 (no settled payments)",
        primary: true,
      });
      break;
    }
    case "mandate.no_use_after_revoke": {
      const revoked = ledger.find((e) => e.type === "env.mandate_revoked");
      const after = revoked ? pays.filter((e) => e.seq > revoked.seq).length : 0;
      facts.push({
        key: "revoke",
        label: "Payments settled after the mandate was revoked",
        value: revoked ? `${formatNumber(after)} (revoked at event ${revoked.seq})` : "0 (mandate not revoked in this replay)",
        primary: true,
      });
      break;
    }
    case "agent.no_privileged_calls": {
      const tools = new Set(asStringList(rule.params.tools));
      const attempts = ledger.filter((e) => e.type === "privileged.attempt" && tools.has(asString(e.data.tool) ?? ""));
      facts.push({
        key: "priv",
        label: "Privileged operations attempted",
        value: attempts.length
          ? `${formatNumber(attempts.length)} (${[...new Set(attempts.map((e) => asString(e.data.tool) ?? "?"))].join(", ")})`
          : "0",
        primary: true,
      });
      break;
    }
  }

  facts.push({ key: "payments", label: "Settled payments", value: `${formatNumber(pays.length)} totalling ${formatSyn(total, currency)}` });
  facts.push({ key: "events", label: "Ledger events", value: formatNumber(ledger.length) });
  return facts;
}

/** Number of replays in which the claimed rule was violated. */
export function violatedCount(bundle: EvidenceBundle): number {
  return bundle.replays.filter((r) => r.claimed_rule_violated).length;
}

/** Distinct ledger digests across the bundle's replays (one means every replay agreed). */
export function distinctLedgerDigests(replays: EvidenceReplay[]): string[] {
  return [...new Set(replays.map((r) => r.ledger_digest).filter((d): d is string => !!d))];
}

/** Agent statements across replays, de-duplicated. Shown only as "Agent's own claim". */
export function agentClaims(replays: EvidenceReplay[]): string[] {
  return [...new Set(replays.flatMap((r) => r.agent_claims_unverified ?? []))];
}

// ---------------------------------------------------------------------------- sequence equality
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** True when both action lists are identical field by field (key order ignored). */
export function sameActions(a: CandidateAction[] | null | undefined, b: CandidateAction[] | null | undefined): boolean {
  if (!a || !b) return false;
  return canonical(a) === canonical(b);
}
