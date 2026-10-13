import type { Regression } from "@/lib/api";

/**
 * The explanation shown for a regression that is neither a pass nor a reproduced violation.
 *
 * The backend's own reason comes first when it gave one. A regression whose evaluator verdict was
 * not_reproduced, but where some replays did not complete (for example the provider rejected the
 * model's generation, so the agent's own guard never ran), is recorded as inconclusive; the
 * evidence bundle's verdict alone would read like a pass, so it is not where to send the reader.
 */
export function unclearRegressionText(r: Pick<Regression, "outcome" | "status" | "outcome_reason">): string {
  const ended = `The replay ended as "${r.outcome ?? r.status}". That is neither a pass nor a reproduced violation`;
  return r.outcome_reason ? `${ended}: ${r.outcome_reason}` : `${ended}; see the evidence bundle for the evaluator's reason.`;
}
