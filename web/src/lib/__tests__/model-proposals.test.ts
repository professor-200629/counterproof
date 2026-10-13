import { describe, expect, it } from "vitest";
import { proposalSentences, proposalTotals } from "@/components/evidence/model-proposals";
import type { ModelProposalSummary, ModelProposals } from "@/lib/api";

function summary(over: Partial<ModelProposalSummary>): ModelProposalSummary {
  return {
    run_outcome: "completed", model_calls: 5, proposed_by_tool: {}, not_offered_by_tool: {}, provider_rejected_by_tool: {},
    failed_generations: 0, privileged_proposed: 0, privileged_rejected_by_provider: 0, privileged_attempts_in_ledger: 0,
    privileged_blocked_by_agent: 0, ...over,
  };
}
function doc(...s: ModelProposalSummary[]): ModelProposals {
  return { format: "counterproof.model-proposals/v1", evidence_digest: null, target: "llm-purchasing-agent@0.2.0", model: "groq/x",
    note: "", replays: s.map((x, i) => ({ index: i, summary: x })) };
}

describe("model-proposal wording", () => {
  it("says the in-code block was not exercised when the model proposed nothing privileged", () => {
    const d = doc(summary({}), summary({}), summary({}));
    const text = proposalSentences(d).join(" ");
    expect(text).toContain("proposed no privileged tool in any of the 3 replays");
    expect(text).toContain("in-code block was not exercised");
    expect(text).toContain("reached the marketplace (ledger): 0");
  });

  it("keeps blocked-in-code, provider rejections and market attempts apart", () => {
    const d = doc(
      summary({ privileged_proposed: 2, privileged_blocked_by_agent: 2 }),
      summary({ run_outcome: "target_crash", privileged_rejected_by_provider: 1 }),
      summary({ privileged_proposed: 1, privileged_attempts_in_ledger: 1 }),
    );
    expect(proposalTotals(d)).toMatchObject({ proposed: 3, blockedInCode: 2, rejectedByProvider: 1, reachedMarket: 1, completed: 2 });
    const text = proposalSentences(d).join(" ");
    expect(text).toContain("proposed a privileged tool 3 times across 3 replays");
    expect(text).toContain("Blocked in the agent's own code: 2.");
    expect(text).toContain("Rejected by the model provider before the agent saw them: 1.");
    expect(text).toContain("Runs completed: 2 of 3.");
  });
});
