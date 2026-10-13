"use client";

import type { ModelProposals } from "@/lib/api";
import { plural } from "@/lib/format";
import { useModelProposals } from "@/lib/queries";

/** Totals across a sidecar's replays, keeping apart what must not be added together. */
export function proposalTotals(doc: ModelProposals) {
  const t = { replays: doc.replays.length, completed: 0, proposed: 0, rejectedByProvider: 0, blockedInCode: 0, reachedMarket: 0 };
  for (const r of doc.replays) {
    const s = r.summary;
    if (s.run_outcome === "completed") t.completed += 1;
    t.proposed += s.privileged_proposed;
    t.rejectedByProvider += s.privileged_rejected_by_provider;
    t.blockedInCode += s.privileged_blocked_by_agent;
    t.reachedMarket += s.privileged_attempts_in_ledger;
  }
  return t;
}

/** One sentence per fact, from the evaluator's broker record (alongside, not inside, the sealed bundle). */
export function proposalSentences(doc: ModelProposals): string[] {
  const t = proposalTotals(doc);
  const runs = `${t.replays} ${plural(t.replays, "replay")}`;
  const out: string[] = [];
  if (t.proposed === 0 && t.rejectedByProvider === 0) {
    out.push(
      `The model proposed no privileged tool in any of the ${runs}, so the agent's in-code block was not exercised in these runs.`,
    );
  } else {
    out.push(`The model proposed a privileged tool ${t.proposed} ${plural(t.proposed, "time")} across ${runs}.`);
    out.push(`Blocked in the agent's own code: ${t.blockedInCode}.`);
    if (t.rejectedByProvider) out.push(`Rejected by the model provider before the agent saw them: ${t.rejectedByProvider}.`);
  }
  out.push(`Privileged calls that reached the marketplace (ledger): ${t.reachedMarket}. Runs completed: ${t.completed} of ${t.replays}.`);
  return out;
}

/**
 * What the model proposed versus what the agent's code allowed through, as observed by the
 * evaluator's model broker. Shown separately from the ledger-based verdict: enforcement success
 * and remaining unsafe model behaviour are different facts.
 */
export function ModelProposalsSummary({ digest }: { digest: string | null | undefined }) {
  const q = useModelProposals(digest);
  if (!digest) return null;
  if (q.isPending) return <p className="text-xs text-muted">Loading the model-proposal record…</p>;
  if (q.isError || !q.data) return <p className="text-xs text-muted">The model-proposal record could not be loaded.</p>;
  return (
    <div className="space-y-1 rounded-md border border-line bg-raised px-3 py-2 text-sm" aria-label="Model proposals observed by the evaluator">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Model proposals (observed by the evaluator&apos;s broker)</p>
      {proposalSentences(q.data).map((s) => (
        <p key={s}>{s}</p>
      ))}
      <p className="text-xs text-muted">
        Recorded alongside, not inside, the sealed evidence bundle ({q.data.model ?? "model not recorded"}). It describes these
        runs only; it is not a guarantee about other inputs or dates.
      </p>
    </div>
  );
}
