import { ArrowRight, Download, FileText } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { Section } from "@/components/ui/section";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { TextLink } from "@/components/ui/text-link";
import { TimeAgo } from "@/components/ui/time";
import { TrustStatement } from "@/components/truth";
import { evidenceDownloadUrl, finishedSummary, type ChallengeView } from "@/lib/api";

/** Off-chain challenges have no escrow, no attestation and no payout: evidence only. */
export function OffchainSettlement({ view }: { view: ChallengeView }) {
  const evaluations = [...view.evaluations].sort((a, b) => b.created_at - a.created_at);
  return (
    <div className="space-y-6">
      <Callout tone="neutral" icon={<FileText />} title="Off-chain challenge - there is no reward to settle">
        This challenge was published without a blockchain. Nothing was escrowed, the evaluator signs no attestation, and no
        transaction will ever pay anyone. What it produces is evidence: each submission is replayed independently by the
        declared evaluator and recorded as an evidence bundle you can download and check.
      </Callout>

      <Section
        title="Evidence produced"
        description="Every evaluation of this challenge with its outcome and evidence bundle. Outcomes come from the deterministic checker, not from the agent or a language model."
        actions={
          <ButtonLink href={`/challenges/${view.id}/compare`} size="sm" icon={<ArrowRight />}>
            Before / after comparison
          </ButtonLink>
        }
      >
        {evaluations.length === 0 ? (
          <EmptyState
            title="No evaluations yet"
            description="Run a search or submit a candidate on the challenge page; the evaluator's independent replay will appear here."
            action={
              <ButtonLink href={`/challenges/${view.id}`} size="sm">
                Open the challenge
              </ButtonLink>
            }
          />
        ) : (
          <Table caption="Evaluations of this off-chain challenge">
            <THead>
              <tr>
                <TH>Evaluation</TH>
                <TH>Outcome</TH>
                <TH>Rule</TH>
                <TH>Evidence</TH>
                <TH>Finished</TH>
              </tr>
            </THead>
            <TBody>
              {evaluations.map((e) => {
                const s = finishedSummary(e);
                return (
                  <TR key={e.id}>
                    <TD>
                      <TextLink href={`/evaluations/${e.id}`} className="font-mono text-xs">
                        {e.id}
                      </TextLink>
                    </TD>
                    <TD>
                      <StatusBadge status={e.status} domain="evaluation" size="sm" />
                    </TD>
                    <TD className="min-w-48 text-xs text-muted">
                      {s?.rule ? (
                        <>
                          <span className="font-mono text-fg">{s.rule.rule_id}</span> {s.rule.statement}
                        </>
                      ) : (
                        "n/a"
                      )}
                    </TD>
                    <TD>
                      {e.evidence_digest ? (
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <Digest value={e.evidence_digest} label="evidence digest" href={`/evaluations/${e.id}`} />
                          <TextLink
                            href={evidenceDownloadUrl(e.evidence_digest)}
                            download
                            className="text-xs"
                            aria-label={`Download the evidence bundle of ${e.id} as JSON`}
                          >
                            <Download aria-hidden="true" className="size-3.5" />
                            JSON
                          </TextLink>
                        </span>
                      ) : (
                        <span className="text-xs text-subtle">not produced yet</span>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap text-xs text-muted">
                      <TimeAgo ts={e.finished_at} emptyText="not finished" />
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
        <TrustStatement kind="llm" className="mt-3" />
      </Section>
    </div>
  );
}
