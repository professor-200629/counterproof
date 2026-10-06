import type { ReactNode } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { LLM_NEVER_DECIDES, NOT_PROOF_OF_SAFETY } from "@/components/truth";
import { cn } from "@/lib/cn";

interface Row {
  key: string;
  result: ReactNode;
  shows: ReactNode;
  doesNot: ReactNode;
}

const ROWS: Row[] = [
  {
    key: "verified",
    result: <StatusBadge status="verified_violation" domain="evaluation" />,
    shows:
      "The declared trusted evaluator replayed the exact action sequence in fresh, isolated synthetic marketplaces, and the deterministic checker found the stated rule broken in the required number of replays, for that agent version.",
    doesNot: "That the agent fails the same way with real merchants, real money, other versions or other inputs.",
  },
  {
    key: "no-violation",
    result: (
      <span className="inline-flex flex-wrap gap-1.5">
        <StatusBadge status="no_violation_found" domain="run" />
        <StatusBadge status="not_reproduced" domain="evaluation" />
      </span>
    ),
    shows: "The sequences that were actually tried, within the stated search budget, did not break the rules on the tested version.",
    doesNot: `${NOT_PROOF_OF_SAFETY} Sequences that were not tried, other versions and other rules may still break.`,
  },
  {
    key: "attestation",
    result: "Evaluator signature",
    shows: "The declared trusted evaluator signed an EIP-712 attestation about its own replay and verdict.",
    doesNot:
      "Anything beyond trusting that evaluator. It is an attestation, not a zero-knowledge proof, and the contract cannot re-check the replay.",
  },
  {
    key: "receipt",
    result: "Blockchain receipt",
    shows:
      "A funding, settlement, refund or withdrawal transaction was recorded on the chain it names. The backend reads every receipt from the chain itself; it never trusts values sent by this page.",
    doesNot: "That the AI agent is correct or incorrect. Receipts from local anvil (31337) are not on Monad.",
  },
  {
    key: "model",
    result: "Language-model output",
    shows: "A model may propose candidate sequences or drive an independent implementation under test.",
    doesNot: `A verdict or a payout. ${LLM_NEVER_DECIDES}`,
  },
  {
    key: "fixture",
    result: "Findings against a fixture",
    shows: "Against an intentionally vulnerable fixture, a finding demonstrates one of its planted defects and exercises the whole loop.",
    doesNot: "A discovery about a production agent.",
  },
];

/** The standing "what a result does and does not prove" box (truth rules). */
export function ProofLimits({ className, headingId = "proof-limits-heading" }: { className?: string; headingId?: string }) {
  return (
    <Card as="section" aria-labelledby={headingId} className={cn(className)}>
      <CardHeader
        id={headingId}
        level={2}
        title="What a result does and does not prove"
        description="Read every number on this site with these limits."
      />
      <CardBody>
        <dl className="divide-y divide-line">
          {ROWS.map((r) => (
            <div key={r.key} className="py-3 first:pt-0 last:pb-0">
              <dt className="text-sm font-semibold text-fg">{r.result}</dt>
              <dd className="mt-1.5 space-y-1 text-sm">
                <p>
                  <span className="font-medium text-muted">Shows: </span>
                  <span className="text-fg">{r.shows}</span>
                </p>
                <p>
                  <span className="font-medium text-muted">Does not show: </span>
                  <span className="text-fg">{r.doesNot}</span>
                </p>
              </dd>
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}
