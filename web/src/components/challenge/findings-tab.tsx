"use client";

import { ArrowRight, GitCompare, Send } from "lucide-react";
import { useState } from "react";
import { LOCAL_CHECK_NOTE } from "@/components/truth";
import { TxHash } from "@/components/tx-hash";
import { Button, ButtonLink } from "@/components/ui/button";
import { Callout, Card, CardBody, CardHeader } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { Section } from "@/components/ui/section";
import { EmptyState, ErrorState, QueryState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { TimeAgo } from "@/components/ui/time";
import { finishedSummary, type AppConfig, type CandidateSummary, type ChallengeView, type Evaluation } from "@/lib/api";
import { useCandidate, useSubmitCandidate } from "@/lib/queries";
import { isEvaluationActive } from "@/lib/status";
import { ActionList } from "@/components/evidence/action-list";
import { ObservedView } from "@/components/evidence/observed";
import { VerdictBadge } from "@/components/evidence/verdict";
import { Mono, TextLink } from "@/components/ui/text-link";
import { Disclosure } from "@/components/ui/disclosure";
import { ReadOnlyNote } from "@/components/snapshot";
import { SNAPSHOT_MODE } from "@/lib/snapshot";
import { useCompareLinkLabel } from "@/components/compare/compare-link-label";

/** Why the backend would refuse a submission now (services.submit_candidate), or null. */
function submitBlockedReason(view: ChallengeView, nowMs: number | null): string | null {
  if (view.status !== "offchain" && view.status !== "funded") return `Submissions are closed: the challenge is ${view.status}.`;
  if (nowMs !== null && nowMs / 1000 > view.spec.deadlines.submission_deadline) return "The submission deadline has passed.";
  return null;
}

export interface FindingsTabProps {
  view: ChallengeView;
  config: AppConfig | null;
  nowMs: number | null;
}

/** Candidates (unverified, challenger-side) and the evaluator's independent replays (evidence). */
export function FindingsTab({ view, config, nowMs }: FindingsTabProps) {
  const blocked = submitBlockedReason(view, nowMs);
  const candidates = [...view.candidates].sort((a, b) => b.created_at - a.created_at);
  const evaluations = [...view.evaluations].sort((a, b) => b.created_at - a.created_at);
  const hasVerified = evaluations.some((e) => e.outcome === "verified_violation");
  const compareLabel = useCompareLinkLabel(view.id, view.spec.target, "Repair and re-test");

  return (
    <div className="space-y-8">
      <Section
        title="Candidates"
        description={`Sequences a search flagged with its own self-check. ${LOCAL_CHECK_NOTE}`}
      >
        {candidates.length === 0 ? (
          <EmptyState
            title="No candidates yet"
            description={
              SNAPSHOT_MODE
                ? "No search run's self-check had flagged a sequence when this snapshot was recorded."
                : "Candidates appear here when a search run's self-check flags a sequence. Start a run under Live testing."
            }
            compact
          />
        ) : (
          <ul className="space-y-4">
            {candidates.map((c) => (
              <CandidateCard
                key={c.id}
                candidate={c}
                view={view}
                config={config}
                evaluation={evaluations.find((e) => e.candidate_id === c.id) ?? null}
                blockedReason={blocked}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Independent replays - evidence"
        description="Each submitted candidate is replayed by the declared trusted evaluator in fresh isolated synthetic marketplaces. Only these outcomes are evidence."
        actions={
          hasVerified ? (
            <ButtonLink href={`/challenges/${view.id}/compare`} size="sm" icon={<GitCompare />}>
              {compareLabel}
            </ButtonLink>
          ) : null
        }
      >
        {evaluations.length === 0 ? (
          <EmptyState
            title="Nothing has been submitted for independent replay"
            description={
              SNAPSHOT_MODE
                ? "No candidate had been submitted for independent replay when this snapshot was recorded."
                : "Submit a candidate above. The evaluator's verdict, ledger and digests then appear here."
            }
            compact
          />
        ) : (
          <EvaluationsTable view={view} evaluations={evaluations} />
        )}
      </Section>
    </div>
  );
}

function EvaluationsTable({ view, evaluations }: { view: ChallengeView; evaluations: Evaluation[] }) {
  return (
    <Table className="relative" caption="Evaluations of this challenge, newest first">
      <THead>
        <tr>
          <TH>Evaluation</TH>
          <TH>Claimed rule</TH>
          <TH>Outcome</TH>
          <TH>Reason</TH>
          <TH className="text-right">Replays violating</TH>
          <TH>Submission</TH>
          <TH>Finished</TH>
          <TH>Evidence</TH>
        </tr>
      </THead>
      <TBody>
        {evaluations.map((e) => {
          const s = finishedSummary(e);
          const claimed = s?.rule?.rule_id ?? view.candidates.find((c) => c.id === e.candidate_id)?.claimed_rule ?? null;
          const violated = s ? s.replays.filter((r) => r.claimed_rule_violated).length : null;
          return (
            <TR key={e.id}>
              <TD>
                <TextLink href={`/evaluations/${e.id}`} className="font-mono text-xs">
                  {e.id}
                </TextLink>
              </TD>
              <TD>{claimed ? <Mono>{claimed}</Mono> : <span className="text-subtle">-</span>}</TD>
              <TD>
                <VerdictBadge outcome={e.outcome ?? e.status} size="sm" />
              </TD>
              <TD className="min-w-[14rem] text-sm">
                {s ? s.reason : isEvaluationActive(e.status) ? <span className="text-muted">replay not finished</span> : "-"}
              </TD>
              <TD numeric>{s && violated !== null ? `${violated} / ${s.replays.length}` : "-"}</TD>
              <TD>
                {e.source === "chain" && e.commit_tx ? (
                  <TxHash hash={e.commit_tx} chainId={view.chain_id} label="commit transaction hash" head={6} tail={4} />
                ) : (
                  <span className="text-xs text-muted">off-chain</span>
                )}
              </TD>
              <TD>
                <TimeAgo ts={e.finished_at} emptyText="not yet" />
              </TD>
              <TD>
                <TextLink href={`/evaluations/${e.id}`} className="whitespace-nowrap text-sm">
                  Open evidence <ArrowRight aria-hidden="true" className="size-3.5" />
                </TextLink>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}

interface CandidateCardProps {
  candidate: CandidateSummary;
  view: ChallengeView;
  config: AppConfig | null;
  evaluation: Evaluation | null;
  blockedReason: string | null;
}

function CandidateCard({ candidate: c, view, config, evaluation, blockedReason }: CandidateCardProps) {
  const submit = useSubmitCandidate(view.id);
  const [showActions, setShowActions] = useState(false);
  const rule = view.spec.rules.find((r) => r.id === c.claimed_rule);
  const run = view.runs.find((r) => r.id === c.run_id);
  const result = submit.data ?? null;
  const linked = result ?? evaluation;
  const canSubmit = c.status === "candidate_found" && !evaluation && !result;
  const funded = view.status === "funded";

  return (
    <Card as="li">
      <CardHeader
        level={3}
        eyebrow="Claims a violation of"
        title={
          <span className="inline-flex flex-wrap items-baseline gap-2">
            <Mono>{c.claimed_rule}</Mono>
            <span className="font-normal">{rule?.statement ?? "a rule not in this spec"}</span>
          </span>
        }
        actions={<StatusBadge status={c.status} domain="candidate" />}
      />
      <CardBody className="space-y-3">
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <div className="flex items-center gap-1">
            <dt className="text-muted">Candidate</dt>
            <dd>
              <Digest value={c.digest} label="candidate digest" />
            </dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted">From run</dt>
            <dd className="font-mono text-fg">
              {run ? `${run.strategy} ` : ""}
              {c.run_id ?? "external"}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted">Found</dt>
            <dd>
              <TimeAgo ts={c.created_at} />
            </dd>
          </div>
        </dl>

        {c.local_check ? (
          <div className="rounded-md border border-dashed border-line-strong bg-inset p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Challenger self-check - not evidence</p>
            <p className="mt-1 text-sm text-fg">{c.local_check.summary}</p>
            <p className="mt-1 text-xs text-muted">{LOCAL_CHECK_NOTE}</p>
            {Object.keys(c.local_check.observed).length > 0 ? (
              <Disclosure bare className="mt-1" summary={<span className="text-xs font-medium">What the self-check saw</span>}>
                <ObservedView observed={c.local_check.observed} currency={view.spec.initial_state.currency} />
              </Disclosure>
            ) : null}
          </div>
        ) : null}

        <Disclosure
          summary="Action sequence"
          onToggle={(e) => {
            if (e.currentTarget.open) setShowActions(true);
          }}
        >
          {showActions ? <CandidateActions id={c.id} view={view} /> : null}
        </Disclosure>

        {linked ? (
          <Callout
            tone="neutral"
            role="status"
            title={
              result?.duplicate
                ? "Already evaluated"
                : result
                  ? "Queued for independent replay"
                  : "Independent replay"
            }
          >
            {result?.duplicate ? (
              <p>
                This exact candidate (same digest) was submitted before. The backend returned the existing evaluation; a replay can
                never produce a second payable finding.
              </p>
            ) : null}
            <p className="mt-1 flex flex-wrap items-center gap-2">
              <VerdictBadge outcome={linked.outcome ?? linked.status} size="sm" />
              <TextLink href={`/evaluations/${linked.id}`}>
                Open evidence <span className="font-mono text-xs">{linked.id}</span>
              </TextLink>
            </p>
          </Callout>
        ) : null}

        {canSubmit && SNAPSHOT_MODE ? (
          <ReadOnlyNote action="Submitting this candidate for independent replay" />
        ) : canSubmit ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                icon={<Send />}
                disabled={!!blockedReason}
                busy={submit.isPending}
                busyLabel="Submitting..."
                onClick={() => submit.mutate(c.id)}
              >
                Submit for independent replay
              </Button>
              {blockedReason ? <span className="text-xs text-muted">{blockedReason}</span> : null}
            </div>
            {funded && config ? (
              <p className="text-xs text-muted">
                On a funded challenge the backend first commits the candidate digest on chain from its challenger account
                {config.challenger_bot.address ? <span className="font-mono"> {config.challenger_bot.address}</span> : null}; the
                reward is bound to the recipient in the candidate at that moment.
                {!config.challenger_bot.can_commit ? (
                  <span className="text-warn"> The backend reports it has no challenger key, so the commit will be refused.</span>
                ) : null}
              </p>
            ) : null}
            {submit.isError ? <ErrorState error={submit.error} title="The submission was refused" compact /> : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function CandidateActions({ id, view }: { id: string; view: ChallengeView }) {
  const q = useCandidate(id);
  if (!q.data) return <QueryState query={q} label="candidate" rows={2} />;
  const doc = q.data.json;
  return (
    <div className="space-y-2">
      <ActionList
        actions={doc.actions}
        products={view.spec.initial_state.products}
        merchants={view.spec.initial_state.merchants}
        currency={view.spec.initial_state.currency}
      />
      <p className="text-xs text-muted">
        Recipient bound in the candidate: <span className="font-mono text-fg">{doc.recipient}</span>
        {doc.provenance.note ? ` - ${doc.provenance.note}` : ""}
      </p>
    </div>
  );
}
