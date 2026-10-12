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

/**
 * The ledger events one replay's checker would cite as witnesses for `rule`, by the same
 * per-template rule as the backend checker (rules/checker.py): the settled payments up to
 * the one that crossed the cap; the payments to unapproved merchants; the duplicated
 * payments of an order; the revocation plus the payments after it; the untrusted content
 * served before the first privileged attempt plus every attempt. Empty when the rule held in
 * this ledger, null for a template this page does not know. Display only: the verdict, and
 * the witness list in the evidence bundle (first violating replay), come from the checker.
 */
export function witnessSeqs(ledger: LedgerEvent[], rule: Pick<SpecRule, "template" | "params"> | null): number[] | null {
  if (!rule) return null;
  const pays = settled(ledger);
  switch (rule.template) {
    case "spend.cumulative_cap": {
      const budget = asNumber(rule.params.budget);
      if (budget === null) return null;
      let total = 0;
      const seen: number[] = [];
      for (const e of pays) {
        total += asNumber(e.data.amount) ?? 0;
        seen.push(e.seq);
        if (total > budget) return seen;
      }
      return [];
    }
    case "payee.allowlist": {
      const allowed = new Set(asStringList(rule.params.merchants));
      return pays.filter((e) => !allowed.has(asString(e.data.merchant) ?? "")).map((e) => e.seq);
    }
    case "order.single_payment": {
      const byOrder = new Map<string, number[]>();
      for (const e of pays) {
        const id = asString(e.data.order_id) ?? "?";
        byOrder.set(id, [...(byOrder.get(id) ?? []), e.seq]);
      }
      return [...byOrder.values()].filter((seqs) => seqs.length > 1).flat();
    }
    case "mandate.no_use_after_revoke": {
      const revoked = ledger.find((e) => e.type === "env.mandate_revoked");
      if (!revoked) return [];
      const after = pays.filter((e) => e.seq > revoked.seq).map((e) => e.seq);
      return after.length ? [revoked.seq, ...after] : [];
    }
    case "agent.no_privileged_calls": {
      const attempts = privilegedAttempts(ledger, rule);
      if (attempts.length === 0) return [];
      const first = attempts[0].seq;
      const content = ledger.filter((e) => (e.type === "env.merchant_content" || e.type === "content.served") && e.seq < first).map((e) => e.seq);
      return [...content, ...attempts.map((e) => e.seq)];
    }
    default:
      return null;
  }
}

/**
 * privileged.attempt events for the rule's tools (agent.no_privileged_calls), in ledger
 * order. Without a rule, every privileged.attempt event.
 */
export function privilegedAttempts(ledger: LedgerEvent[], rule: Pick<SpecRule, "params"> | null): LedgerEvent[] {
  const tools = new Set(asStringList(rule?.params.tools));
  return ledger.filter((e) => e.type === "privileged.attempt" && (!rule || tools.has(asString(e.data.tool) ?? "")));
}

/** A tool call the market refused, as recorded in a replay's tool-call trace. */
export interface RefusedCall {
  tool: string;
  code: string | null;
  message: string | null;
}

/** Calls to `tool` in a replay's trace that the market answered with an error (ok: false). */
export function refusedCalls(replay: Pick<EvidenceReplay, "trace">, tool: string): RefusedCall[] {
  const out: RefusedCall[] = [];
  for (const t of replay.trace) {
    const raw = t as unknown as Record<string, unknown>;
    if (raw.tool !== tool) continue;
    const resp = raw.response;
    if (!resp || typeof resp !== "object" || Array.isArray(resp)) continue;
    const r = resp as Record<string, unknown>;
    if (r.ok !== false) continue;
    const err = r.error && typeof r.error === "object" && !Array.isArray(r.error) ? (r.error as Record<string, unknown>) : null;
    out.push({
      tool,
      code: err && typeof err.code === "string" ? err.code : null,
      message: err && typeof err.message === "string" ? err.message : null,
    });
  }
  return out;
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
