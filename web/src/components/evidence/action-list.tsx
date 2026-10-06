import type { ReactNode } from "react";
import type { CandidateAction, Merchant, Product } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { Mono } from "@/components/ui/text-link";
import { CompactJson } from "./values";

export interface ActionListProps {
  actions: CandidateAction[];
  /** Products / merchants of the spec's synthetic initial state, to name SKUs. */
  products?: Product[];
  merchants?: Merchant[];
  currency?: string;
  className?: string;
  /** Label for the list (screen readers). */
  label?: string;
}

const FAULT_TEXT: Record<string, string> = {
  timeout_after_commit: "time out after the payment is committed (the money moves, the agent is told the outcome is unknown)",
  timeout_before_commit: "time out before the payment is committed (nothing is charged, the agent is told the outcome is unknown)",
  delayed_response: "answer late with status \"processing\" (the payment is committed)",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

/**
 * A candidate's action sequence as a numbered list in plain words. Actions only shape the
 * agent's environment (requests, merchant text, network faults, mandate revocation); the
 * descriptions follow counterproof.actions/v1. Unknown action types show their raw JSON.
 */
export function ActionList({ actions, products, merchants, currency = "SYN", className, label = "Action sequence" }: ActionListProps) {
  const productBySku = new Map((products ?? []).map((p) => [p.sku, p]));
  const merchantName = new Map((merchants ?? []).map((m) => [m.id, m.name]));
  const seenRequests = new Map<string, number>();

  const items = actions.map((a, i) => {
    let body: ReactNode;
    if (a.type === "user_request") {
      const sku = str(a.sku);
      const qty = typeof a.qty === "number" ? a.qty : Number(a.qty);
      const p = productBySku.get(sku);
      const rid = str(a.request_id);
      const firstSeen = seenRequests.get(rid);
      if (firstSeen === undefined) seenRequests.set(rid, i + 1);
      body = (
        <>
          <p className="text-fg">
            The principal asks the agent to buy{" "}
            <span className="font-semibold tabular">{formatNumber(qty)}</span> x {p ? p.name : sku}{" "}
            <span className="font-mono text-xs text-muted">({sku})</span>
            {p ? (
              <span className="text-muted">
                {" "}
                - {formatNumber(p.price)} {currency} each, sold by {merchantName.get(p.merchant) ?? p.merchant}
              </span>
            ) : null}
            .
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Request id <span className="font-mono text-fg">{rid}</span>
            {firstSeen !== undefined ? (
              <span className="text-warn"> - repeats the request id of step {firstSeen} (a duplicated delivery of the same request)</span>
            ) : null}
          </p>
        </>
      );
    } else if (a.type === "merchant_content") {
      const sku = str(a.sku);
      const p = productBySku.get(sku);
      body = (
        <>
          <p className="text-fg">
            The merchant{p ? ` ${merchantName.get(p.merchant) ?? p.merchant}` : ""} replaces the description of{" "}
            {p ? p.name : sku} <span className="font-mono text-xs text-muted">({sku})</span> with its own text.
          </p>
          <figure className="mt-1.5 rounded-md border border-dashed border-line bg-inset px-3 py-2">
            <figcaption className="text-xs font-medium text-muted">Untrusted merchant text shown to the agent</figcaption>
            <blockquote className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-fg">{str(a.text)}</blockquote>
          </figure>
        </>
      );
    } else if (a.type === "network_fault") {
      const count = typeof a.count === "number" ? a.count : 1;
      const fault = str(a.fault);
      body = (
        <p className="text-fg">
          Network fault: the next {count === 1 ? "call" : `${count} calls`} to <span className="font-mono text-xs">{str(a.op)}</span>{" "}
          will {FAULT_TEXT[fault] ?? <span className="font-mono text-xs">{fault}</span>}.
        </p>
      );
    } else if (a.type === "revoke_mandate") {
      body = (
        <p className="text-fg">
          The principal revokes the purchasing mandate. The agent is not notified; it has to check the mandate itself.
        </p>
      );
    } else {
      body = (
        <div className="text-fg">
          <p className="text-muted">Unrecognised action type - raw JSON:</p>
          <CompactJson value={a} />
        </div>
      );
    }
    return (
      <li key={i} className="flex gap-3 py-2.5 first:pt-0 last:pb-0">
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong bg-raised font-mono text-xs text-fg tabular"
        >
          {i + 1}
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <div className="mb-1">
            <span className="sr-only">Step {i + 1}: </span>
            <Mono>{a.type}</Mono>
          </div>
          {body}
        </div>
      </li>
    );
  });

  if (actions.length === 0) return <p className="text-sm text-muted">The sequence has no actions.</p>;
  return (
    <ol aria-label={label} className={cn("divide-y divide-line", className)}>
      {items}
    </ol>
  );
}
