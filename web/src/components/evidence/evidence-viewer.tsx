"use client";

import { ArrowLeft, Download, FileJson, GitCompare, RotateCcw, Scale } from "lucide-react";
import type { ReactNode } from "react";
import { Limitations, TrustStatement } from "@/components/truth";
import { JobFacts } from "@/components/job-facts";
import { TxHash } from "@/components/tx-hash";
import { Address } from "@/components/ui/address";
import { Breadcrumbs, challengeCrumbs } from "@/components/ui/breadcrumbs";
import { Button, ButtonLink } from "@/components/ui/button";
import { Callout, Card, CardBody, CardHeader } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { JsonView } from "@/components/ui/json-view";
import { ProvenanceBadge } from "@/components/ui/provenance-badge";
import { PageHeader, Section } from "@/components/ui/section";
import { KeyValueList } from "@/components/ui/stat";
import { ErrorState, Loading, QueryState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { DateTime } from "@/components/ui/time";
import { toneSurface, type Tone } from "@/components/ui/tone";
import {
  evidenceDownloadUrl,
  specJsonUrl,
  type AppConfig,
  type ChallengeSpec,
  type ChallengeView,
  type Evaluation,
  type EvidenceBundle,
  type PreviousAttempt,
} from "@/lib/api";
import { formatWei, txNetworkPhrase } from "@/lib/chain";
import { cn } from "@/lib/cn";
import { plural, sameHex, shortAddress } from "@/lib/format";
import { useCandidate, useChallenge, useConfig, useEvaluation, useEvidence, useRetryEvaluation, useRuleTemplates } from "@/lib/queries";
import { isEvaluationActive, statusMeta } from "@/lib/status";
import { Mono, TextLink, textLinkClasses } from "@/components/ui/text-link";
import { ActionList } from "./action-list";
import { AttestationPanel, type AttestationLike } from "./attestation-panel";
import { ObservedView } from "./observed";
import { ReplayDetails, ReplaysTable } from "./replays";
import { DataPairs } from "./values";
import { MatchMark } from "@/components/ui/match-mark";
import { VerdictBadge, VerdictBanner } from "./verdict";
import { WhoChecked } from "./who-checked";
import { useSignatureBinding, type SignatureBinding } from "@/components/settlement/use-recovered-signer";

const NAV = [
  ["answers", "At a glance"],
  ["promise", "Promise"],
  ["failure", "What failed"],
  ["counterexample", "Counterexample"],
  ["replays", "Replays"],
  ["checker", "Who checked"],
  ["digests", "Digests"],
  ["limitations", "Limitations"],
  ["reward", "Attestation and reward"],
] as const;

export function EvidenceViewer({ id }: { id: string }) {
  const evq = useEvaluation(id);
  const evaluation = evq.data ?? null;
  const challengeQ = useChallenge(evaluation?.challenge_id ?? null);
  const challenge = challengeQ.data ?? null;
  const evidenceQ = useEvidence(evaluation?.evidence_digest ?? null);
  const configQ = useConfig();

  if (!evaluation) {
    return (
      <>
        <PageHeader
          title="Evaluation evidence"
          breadcrumb={<Breadcrumbs items={[{ label: "Challenges", href: "/challenges" }, { label: id, mono: true }]} />}
          description={<span className="font-mono text-xs">{id}</span>}
        />
        <QueryState
          query={evq}
          label="evaluation"
          rows={6}
          card
          notFound={{
            title: `Evaluation ${id} does not exist`,
            description: "The backend has no evaluation with this id. Evaluations are listed under a challenge's Findings tab.",
            action: <ButtonLink href="/challenges">All challenges</ButtonLink>,
          }}
        />
      </>
    );
  }

  const bundle = evidenceQ.data ?? null;
  const spec = challenge?.spec ?? null;
  const outcome = evaluation.outcome ?? (isEvaluationActive(evaluation.status) ? null : evaluation.status);
  const digest = evaluation.evidence_digest;
  const attestation: AttestationLike | null =
    evaluation.attestation ?? (challenge?.attestation && challenge.attestation.evaluation_id === evaluation.id ? challenge.attestation : null);

  return (
    <>
      <PageHeader
        breadcrumb={<Breadcrumbs items={challengeCrumbs(evaluation.challenge_id, challenge?.spec.title, "Evaluation")} />}
        title="Independent replay evidence"
        description={
          <>
            Evaluation <span className="font-mono text-xs text-fg">{evaluation.id}</span> of submission{" "}
            <span className="font-mono text-xs text-fg">{evaluation.submission_id}</span>
            {spec ? (
              <>
                {" "}
                for <span className="text-fg">{spec.title}</span>
              </>
            ) : null}
          </>
        }
        meta={
          <>
            {outcome ? <VerdictBadge outcome={outcome} /> : <StatusBadge status={evaluation.status} domain="evaluation" />}
            {bundle || spec ? (
              <ProvenanceBadge
                kind="target"
                value={(bundle?.target.label ?? spec?.target.label) as string}
                requiresModel={challenge?.target_info?.requires_model}
              />
            ) : null}
            {challenge ? <ProvenanceBadge kind="network" value={challenge.network} /> : null}
          </>
        }
        actions={
          <>
            {digest ? (
              <ButtonLink href={evidenceDownloadUrl(digest)} external download variant="primary" icon={<Download />}>
                Download evidence bundle
              </ButtonLink>
            ) : null}
            <ButtonLink href={`/challenges/${evaluation.challenge_id}/settlement`} icon={<Scale />}>
              Settlement
            </ButtonLink>
          </>
        }
      />

      {isEvaluationActive(evaluation.status) ? (
        <PendingEvaluation evaluation={evaluation} spec={spec} />
      ) : !digest ? (
        <div className="space-y-4">
          <Callout tone="neutral" title={`Finished without an evidence bundle (${statusMeta(evaluation.status, "evaluation").label})`}>
            The backend reports no evidence digest for this evaluation, so there is nothing to show beyond its status.
          </Callout>
          <PreviousAttempts evaluation={evaluation} />
        </div>
      ) : !bundle ? (
        evidenceQ.isError ? (
          <ErrorState error={evidenceQ.error} title="Could not load the evidence bundle" onRetry={() => void evidenceQ.refetch()} />
        ) : (
          <Loading label="evidence bundle" rows={8} card />
        )
      ) : (
        <EvidenceBody
          evaluation={evaluation}
          bundle={bundle}
          challenge={challenge}
          challengeError={challengeQ.isError ? challengeQ.error : null}
          attestation={attestation}
          config={configQ.data ?? null}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------- pending
function PendingEvaluation({ evaluation, spec }: { evaluation: Evaluation; spec: ChallengeSpec | null }) {
  const candidateQ = useCandidate(evaluation.candidate_id);
  const job = evaluation.job ?? null;
  return (
    <div className="space-y-6">
      <Callout tone="warn" role="status" title={`Independent replay ${evaluation.status === "queued" ? "queued" : "in progress"}`}>
        <p>
          {statusMeta(evaluation.status, "evaluation").description} The evaluator reports no partial progress, so none is shown;
          this page refreshes every few seconds and the verdict appears when the replay finishes.
        </p>
        <JobFacts job={job} requestedAt={evaluation.created_at} requestedLabel="Submitted" className="mt-2" />
      </Callout>
      <PreviousAttempts evaluation={evaluation} />
      <Section title="Sequence being replayed" description="The candidate as submitted. Its self-check is not used; only the evaluator's replay decides.">
        {candidateQ.data ? (
          <Card padded>
            <p className="mb-3 text-sm text-muted">
              Claimed rule <Mono>{candidateQ.data.claimed_rule}</Mono>
              {spec ? <> - {spec.rules.find((r) => r.id === candidateQ.data?.claimed_rule)?.statement}</> : null}
            </p>
            <ActionList
              actions={candidateQ.data.json.actions}
              products={spec?.initial_state.products}
              merchants={spec?.initial_state.merchants}
              currency={spec?.initial_state.currency}
            />
          </Card>
        ) : evaluation.candidate_id ? (
          <QueryState query={candidateQ} label="candidate" />
        ) : (
          <p className="text-sm text-muted">This submission was revealed by an external challenger; its candidate is shown once replayed.</p>
        )}
      </Section>
    </div>
  );
}

function PreviousAttempts({ evaluation }: { evaluation: Evaluation }) {
  const attempts: PreviousAttempt[] = evaluation.summary?.previous_attempts ?? [];
  if (attempts.length === 0) return null;
  return (
    <Section title="Earlier attempts" description="Runner failures kept when the evaluation was retried. They say nothing about the agent." level={3}>
      <Table className="relative" caption="Earlier attempts of this evaluation">
        <THead>
          <tr>
            <TH>Outcome</TH>
            <TH>Reason</TH>
            <TH>Evidence</TH>
            <TH>Finished</TH>
          </tr>
        </THead>
        <TBody>
          {attempts.map((a, i) => (
            <TR key={i}>
              <TD>
                <VerdictBadge outcome={a.outcome} size="sm" />
              </TD>
              <TD className="text-sm">{a.reason ?? "-"}</TD>
              <TD>
                <Digest value={a.evidence_digest} label="earlier evidence digest" href={a.evidence_digest ? evidenceDownloadUrl(a.evidence_digest) : null} />
              </TD>
              <TD>
                <DateTime ts={a.finished_at} />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Section>
  );
}

// ---------------------------------------------------------------------------- evidence body
interface BodyProps {
  evaluation: Evaluation;
  bundle: EvidenceBundle;
  challenge: ChallengeView | null;
  challengeError: unknown;
  attestation: AttestationLike | null;
  config: AppConfig | null;
}

function EvidenceBody({ evaluation, bundle, challenge, challengeError, attestation, config }: BodyProps) {
  const spec = challenge?.spec ?? null;
  const templates = useRuleTemplates();
  const retry = useRetryEvaluation(evaluation.challenge_id);
  const v = bundle.verdict;
  const currency = spec?.initial_state.currency ?? "SYN";
  const specRule = spec?.rules.find((r) => r.id === (v.rule?.rule_id ?? bundle.claimed_rule)) ?? null;
  const rule = v.rule ?? (specRule ? { rule_id: specRule.id, template: specRule.template, statement: specRule.statement } : null);
  const template = templates.data?.find((t) => t.id === rule?.template) ?? null;
  const violated = bundle.replays.filter((r) => r.claimed_rule_violated).length;
  const ledgerRef = bundle.replays[0]?.ledger_digest ?? null;
  const identical = bundle.replays.length > 1 && bundle.replays.every((r) => r.ledger_digest !== null && r.ledger_digest === ledgerRef);
  const evidenceDigest = bundle.evidence_digest ?? evaluation.evidence_digest;
  const actions = bundle.candidate?.actions ?? [];
  const shrunk = !!bundle.candidate?.provenance.note && /shrunk/i.test(bundle.candidate.provenance.note);
  const reward = rewardAnswer({ evaluation, bundle, challenge, attestation, evidenceDigest });
  const binding = useSignatureBinding(attestation, bundle.evaluator.address);
  const deterministic = bundle.target.determinism === "deterministic";
  const specLink = (
    <a href={specJsonUrl(bundle.challenge.spec_digest)} download={`spec-${bundle.challenge.spec_digest.slice(7, 19)}.json`} className={textLinkClasses}>
      spec JSON
    </a>
  );

  return (
    <div className="space-y-8">
      <nav aria-label="On this page" className="-mt-2 overflow-x-auto">
        <ul className="flex gap-1 whitespace-nowrap text-sm">
          {NAV.map(([anchor, label]) => (
            <li key={anchor}>
              <a
                href={`#${anchor}`}
                className="inline-flex rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-fg focus-visible:outline-offset-[-2px]"
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <VerdictBanner bundle={bundle} />

      {challengeError ? <ErrorState error={challengeError} title="Could not load the challenge (spec, network, reward)" compact /> : null}

      {evaluation.outcome === "runner_failure" ? (
        <Callout tone="warn" title="Runner failure - no verdict about the agent">
          <p>The evaluator&apos;s own runner failed, so this says nothing about the agent. The backend allows a runner failure to be retried; every other verdict is final.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button icon={<RotateCcw />} busy={retry.isPending} busyLabel="Re-queuing..." onClick={() => retry.mutate(evaluation.id)}>
              Retry the replay
            </Button>
          </div>
          {retry.isError ? <ErrorState error={retry.error} title="Retry refused" compact className="mt-2" /> : null}
        </Callout>
      ) : null}
      <PreviousAttempts evaluation={evaluation} />

      {/* ------------------------------------------------------------ at a glance */}
      <Section id="answers" title="At a glance" description="The five questions this page answers, each from the evidence below.">
        <dl className="divide-y divide-line rounded-lg border border-line bg-surface">
          <Answer q="What was promised?" href="#promise">
            {rule ? (
              <>
                <Mono>{rule.rule_id}</Mono> {rule.statement}
              </>
            ) : (
              <span className="text-muted">No rule could be matched to this submission.</span>
            )}
          </Answer>
          <Answer q="What failed?" href="#failure">
            {v.outcome === "verified_violation" && v.summary ? (
              <span className="text-bad">{v.summary}</span>
            ) : (
              <span>
                {v.outcome === "not_reproduced"
                  ? "Nothing: the claimed rule held in the evaluator's replays."
                  : `No verified failure - the outcome is "${statusMeta(v.outcome, "evaluation").label.toLowerCase()}", not a verdict that the rule was broken. The checker's reason is in the verdict above.`}
              </span>
            )}
          </Answer>
          <Answer q="Can I reproduce it?" href="#counterexample">
            {v.outcome === "runner_failure" || v.outcome === "cancelled" ? (
              <span>
                Not established: the evaluator&apos;s replay did not complete ({statusMeta(v.outcome, "evaluation").label.toLowerCase()}),
                so this says nothing about the agent.
              </span>
            ) : bundle.replays.length > 0 ? (
              <>
                The evaluator replayed {actions.length} {plural(actions.length, "action")} {bundle.replays.length}{" "}
                {plural(bundle.replays.length, "time")} in fresh synthetic marketplaces; the claimed rule was violated in{" "}
                <span className="font-semibold tabular">
                  {violated} of {bundle.replays.length}
                </span>
                {bundle.replays.length > 1 ? (identical ? ", with identical ledgers each time." : ", with differing ledgers.") : "."}{" "}
                {deterministic ? null : <span className="text-warn">{bundle.reproducibility.statement} </span>}
                The evidence bundle holds the candidate, each replay&apos;s ledger and digests, and the verdict. To replay it you also
                need the {specLink} (rules, parameters, initial state) and the target{" "}
                <span className="font-mono text-xs">
                  {bundle.target.adapter}@{bundle.target.version}
                </span>{" "}
                (artifact <Digest value={bundle.target.artifact_digest} label="target artifact digest" />
                ).
              </>
            ) : (
              <span className="text-muted">Nothing was replayed: {v.reason}</span>
            )}
          </Answer>
          <Answer q="Who checked it?" href="#checker" tone={binding.state === "checking" || (binding.state === "recovered" && binding.matches) ? undefined : "warn"}>
            <WhoAnswer bundle={bundle} binding={binding} />
          </Answer>
          <Answer q="Was the reward paid?" href="#reward" tone={reward.tone}>
            {reward.text}
          </Answer>
        </dl>
      </Section>

      {/* ------------------------------------------------------------ promise */}
      <Section id="promise" title="What was promised" description="The explicit rule the challenger claims was broken, as written in the content-addressed spec.">
        <Card padded className="space-y-3">
          {rule ? (
            <>
              <p className="flex flex-wrap items-baseline gap-2 text-base font-medium text-fg">
                <Mono>{rule.rule_id}</Mono>
                <span>{rule.statement}</span>
              </p>
              <KeyValueList
                items={[
                  {
                    key: "tpl",
                    label: "Rule template",
                    value: (
                      <span>
                        <span className="font-mono text-xs">
                          {rule.template}
                          {specRule ? ` v${specRule.template_version}` : ""}
                        </span>
                        {template ? <span className="text-muted"> - {template.title}</span> : null}
                      </span>
                    ),
                  },
                  ...(specRule ? [{ key: "params", label: "Parameters", value: <DataPairs data={specRule.params} currency={currency} /> }] : []),
                  ...(template ? [{ key: "evidence", label: "What the checker reads", value: template.evidence }] : []),
                  {
                    key: "target",
                    label: "Tested version",
                    value: (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">
                          {bundle.target.adapter}@{bundle.target.version}
                        </span>
                        <Digest value={bundle.target.artifact_digest} label="target artifact digest" />
                        <span className="text-xs text-muted">{bundle.target.determinism}</span>
                      </span>
                    ),
                  },
                ]}
              />
              <ProvenanceBadge kind="target" value={bundle.target.label} requiresModel={challenge?.target_info?.requires_model} />
            </>
          ) : (
            <p className="text-sm text-muted">The submission did not name a rule of this challenge.</p>
          )}
        </Card>
      </Section>

      {/* ------------------------------------------------------------ failure */}
      <Section id="failure" title="What failed" description="Expected versus observed, computed by the deterministic checker from the evaluator's ledger only.">
        {v.observed ? (
          <Card padded className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-line bg-inset px-3 py-2.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Expected</p>
                <p className="mt-1 font-mono text-sm text-fg">{v.expected ?? "not stated"}</p>
              </div>
              <div className={cn("rounded-md border px-3 py-2.5", toneSurface.bad)}>
                <p className="text-xs font-semibold uppercase tracking-wide">Observed</p>
                <p className="mt-1 text-sm text-fg">{v.summary ?? "see the table below"}</p>
              </div>
            </div>
            <ObservedView observed={v.observed} witnessSeqs={v.witness_seqs} currency={currency} />
            {v.witness_seqs && v.witness_seqs.length > 0 ? (
              <p className="text-xs text-muted">
                Witness ledger events: seq {v.witness_seqs.join(", ")} (highlighted in each replay&apos;s ledger below).
              </p>
            ) : null}
          </Card>
        ) : (
          <Card padded className="space-y-2">
            <p className="text-sm text-fg">
              {v.outcome === "not_reproduced"
                ? `The claimed rule held in ${bundle.replays.length === 1 ? "the replay" : `all ${bundle.replays.length} replays`}: the checker found nothing to report.`
                : v.outcome === "runner_failure" || v.outcome === "cancelled"
                  ? "Nothing was checked: the evaluator's replay did not complete, so the checker had no complete ledger to judge. The reason is in the verdict above."
                  : `No verified violation (${statusMeta(v.outcome, "evaluation").label.toLowerCase()}). The checker's reason is in the verdict above.`}
            </p>
            {v.outcome === "not_reproduced" ? <TrustStatement kind="not-proof" /> : null}
          </Card>
        )}
      </Section>

      {/* ------------------------------------------------------------ counterexample */}
      <Section
        id="counterexample"
        title={shrunk ? "Minimal counterexample" : "Counterexample"}
        description="The exact action sequence the evaluator replayed. Actions only shape the agent's environment; the agent's own decisions do the rest."
      >
        {bundle.candidate ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Card padded>
              <ActionList
                actions={actions}
                products={spec?.initial_state.products}
                merchants={spec?.initial_state.merchants}
                currency={currency}
                label="Counterexample actions"
              />
            </Card>
            <div className="space-y-4">
              <Card>
                <CardHeader title="Where it came from" level={3} />
                <CardBody>
                  <KeyValueList
                    items={[
                      {
                        key: "strategy",
                        label: "Search strategy",
                        value: (
                          <span className="font-mono text-xs">
                            {bundle.candidate.provenance.strategy}@{bundle.candidate.provenance.strategy_version}
                          </span>
                        ),
                      },
                      { key: "run", label: "Run", value: <span className="font-mono text-xs">{bundle.candidate.provenance.run_id}</span> },
                      {
                        key: "model",
                        label: "Model",
                        value: bundle.candidate.provenance.model ?? <span className="text-muted">none (deterministic search)</span>,
                      },
                      ...(bundle.candidate.provenance.note ? [{ key: "note", label: "Search note", value: bundle.candidate.provenance.note }] : []),
                      { key: "claimed", label: "Claimed rule", value: <Mono>{bundle.candidate.claimed_rule}</Mono> },
                    ]}
                  />
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Can I reproduce it?" level={3} />
                <CardBody className="space-y-2 text-sm text-fg">
                  <p>
                    Reset the synthetic market <span className="font-mono text-xs">{bundle.evaluator.market.name}@{bundle.evaluator.market.version}</span>{" "}
                    to the spec&apos;s initial state, run{" "}
                    <span className="font-mono text-xs">
                      {bundle.target.adapter}@{bundle.target.version}
                    </span>{" "}
                    and feed it these {actions.length} actions in order. Check the ledger with{" "}
                    <span className="font-mono text-xs">
                      {bundle.evaluator.checker.name}@{bundle.evaluator.checker.version}
                    </span>
                    .
                  </p>
                  {bundle.target.determinism === "deterministic" && ledgerRef ? (
                    <p>
                      The target is deterministic, so the ledger digest must come out as <Digest value={ledgerRef} label="expected ledger digest" />.
                    </p>
                  ) : (
                    <p className="text-muted">{bundle.reproducibility.statement}</p>
                  )}
                  <p className="text-muted">
                    The evidence bundle has the candidate, ledgers, digests and verdict, but not the initial state, the rule parameters
                    or the target&apos;s code; the spec JSON has the first two, and the target is named by adapter, version and
                    artifact digest.
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {evidenceDigest ? (
                      <ButtonLink href={evidenceDownloadUrl(evidenceDigest)} external download size="sm" icon={<Download />}>
                        Evidence bundle (JSON)
                      </ButtonLink>
                    ) : null}
                    <ButtonLink
                      href={specJsonUrl(bundle.challenge.spec_digest)}
                      external
                      download={`spec-${bundle.challenge.spec_digest.slice(7, 19)}.json`}
                      size="sm"
                      icon={<FileJson />}
                    >
                      Spec (JSON)
                    </ButtonLink>
                    {v.outcome === "verified_violation" ? (
                      <ButtonLink
                        href={`/challenges/${evaluation.challenge_id}/compare${evaluation.candidate_id ? `?candidate=${encodeURIComponent(evaluation.candidate_id)}` : ""}`}
                        size="sm"
                        icon={<GitCompare />}
                      >
                        Replay against a repaired version
                      </ButtonLink>
                    ) : null}
                  </div>
                </CardBody>
              </Card>
            </div>
            <div className="lg:col-span-2">
              <JsonView value={bundle.candidate} label="Candidate document (as committed)" collapsedDepth={0} />
            </div>
          </div>
        ) : (
          <Callout tone="warn" title="No valid candidate in this bundle">
            The submission did not validate, so there is no action sequence to show.
          </Callout>
        )}
      </Section>

      {/* ------------------------------------------------------------ replays */}
      <Section
        id="replays"
        title="Replays"
        description={`${bundle.replays.length} independent ${plural(bundle.replays.length, "replay")}, each in a fresh isolated synthetic marketplace. The spec requires ${bundle.reproducibility.required_violations} violating ${plural(bundle.reproducibility.required_violations, "replay")}.`}
      >
        <div className="space-y-5">
          {bundle.replays.length > 0 ? <ReplaysTable bundle={bundle} /> : null}
          <ReplayDetails bundle={bundle} currency={currency} />
        </div>
      </Section>

      {/* ------------------------------------------------------------ checker */}
      <section id="checker" aria-labelledby="checker-heading" className="scroll-mt-20">
        <WhoChecked bundle={bundle} spec={spec} config={config} binding={binding} level={2} headingId="checker-heading" />
      </section>

      {/* ------------------------------------------------------------ digests */}
      <Section id="digests" title="Digests and binding" description="Content digests tie the spec, the candidate and this evidence together; the submission fixes who is paid.">
        <Card padded>
          <KeyValueList
            items={[
              {
                key: "spec",
                label: "Spec",
                value: <Digest value={bundle.challenge.spec_digest} label="spec digest" href={`/challenges/${evaluation.challenge_id}`} />,
              },
              { key: "cand", label: "Candidate (replayed)", value: <Digest value={bundle.submission.candidate_digest} label="candidate digest" /> },
              {
                key: "committed",
                label: "Candidate (committed)",
                value: (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Digest value={bundle.submission.committed_candidate_digest} label="committed candidate digest" />
                    <MatchMark
                      ok={
                        bundle.submission.candidate_digest && bundle.submission.committed_candidate_digest
                          ? bundle.submission.candidate_digest === bundle.submission.committed_candidate_digest
                          : null
                      }
                      okText="same as the replayed candidate"
                      badText="differs from the replayed candidate"
                    />
                  </span>
                ),
              },
              { key: "evidence", label: "Evidence bundle", value: <Digest value={evidenceDigest} label="evidence digest" /> },
              { key: "artifact", label: "Target artifact", value: <Digest value={bundle.target.artifact_digest} label="target artifact digest" /> },
              ...(spec ? [{ key: "state", label: "Initial state", value: <Digest value={spec.initial_state_digest} label="initial state digest" /> }] : []),
              { key: "sub", label: "Submission id", value: <span className="break-all font-mono text-xs">{bundle.submission.submission_id}</span> },
              {
                key: "challenger",
                label: "Challenger",
                value: <Address value={bundle.submission.challenger ?? evaluation.challenger} label="challenger" />,
              },
              {
                key: "recipient",
                label: "Payout recipient",
                value: (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Address value={bundle.submission.recipient ?? evaluation.recipient} label="recipient" />
                    <span className="text-xs text-muted">bound when the submission was committed</span>
                  </span>
                ),
              },
              {
                key: "source",
                label: "Commitment",
                value:
                  evaluation.source === "chain" && evaluation.commit_tx ? (
                    <TxHash hash={evaluation.commit_tx} chainId={challenge?.chain_id} label="commit transaction hash" />
                  ) : (
                    <span className="text-muted">Off-chain submission (recorded by the backend, no commit transaction)</span>
                  ),
              },
              {
                key: "timing",
                label: "Evaluated",
                value: (
                  <span>
                    <DateTime ts={bundle.timing.started_at} seconds /> <span className="text-muted">to</span>{" "}
                    <DateTime ts={bundle.timing.finished_at} seconds />
                  </span>
                ),
              },
              { key: "format", label: "Bundle format", value: <span className="font-mono text-xs">{bundle.format}</span> },
            ]}
          />
        </Card>
      </Section>

      {/* ------------------------------------------------------------ limitations */}
      <Section id="limitations" title="Limitations" description="What this evidence does not show, as stated by the evaluator.">
        <div className="space-y-2">
          <Limitations items={bundle.limitations} title="Limitations stated by the evaluator" />
          <TrustStatement kind="not-proof" />
        </div>
      </Section>

      {/* ------------------------------------------------------------ attestation */}
      <Section id="reward" title="Attestation and reward" description="What the evaluator signed, and whether the reward moved. Settlement happens on the settlement page.">
        <div className="space-y-4">
          <Callout tone={reward.tone} role="note" title="Was the reward paid?">
            {reward.text}
          </Callout>
          <AttestationPanel evaluation={evaluation} bundle={bundle} challenge={challenge} attestation={attestation} binding={binding} />
        </div>
      </Section>

      <p>
        <TextLink href={`/challenges/${evaluation.challenge_id}?tab=findings`}>
          <ArrowLeft aria-hidden="true" className="size-4" /> Back to the challenge&apos;s findings
        </TextLink>
      </p>
    </div>
  );
}

/** "Who checked it?": what binds the result to the declared evaluator, said only as far as it was checked. */
function WhoAnswer({ bundle, binding }: { bundle: EvidenceBundle; binding: SignatureBinding }) {
  const addr = <span className="font-mono text-xs">{shortAddress(bundle.evaluator.address)}</span>;
  const checker = (
    <span className="font-mono text-xs">
      {bundle.evaluator.checker.name}@{bundle.evaluator.checker.version}
    </span>
  );
  const notThem = " Not the challenger, and not a language model.";
  switch (binding.state) {
    case "recovered":
      return binding.matches ? (
        <span className="text-fg">
          The declared trusted evaluator {addr} running {checker}: its EIP-712 attestation signature recovers to that address
          (checked in this browser).{notThem}
        </span>
      ) : (
        <span>
          The attestation signature recovers to <span className="font-mono text-xs">{shortAddress(binding.address)}</span>, not the
          declared trusted evaluator {addr}. Treat this result as unattested.
        </span>
      );
    case "checking":
      return (
        <span className="text-fg">
          Replayed for the declared trusted evaluator {addr} with {checker}; checking its attestation signature in this browser.{notThem}
        </span>
      );
    case "unrecoverable":
      return (
        <span>
          Replayed for the declared trusted evaluator {addr} with {checker}, but the attestation signature could not be recovered:{" "}
          {binding.message}
        </span>
      );
    case "unsigned":
      return (
        <span>
          Replayed by this backend on behalf of the declared trusted evaluator {addr} with {checker}; unsigned, so nothing binds
          this bundle to the evaluator&apos;s key.{notThem}
        </span>
      );
  }
}

function Answer({ q, href, tone, children }: { q: string; href: string; tone?: Tone; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-sm font-semibold text-fg">
        <a href={href} className="underline-offset-2 hover:text-accent-text hover:underline">
          {q}
        </a>
      </dt>
      <dd className={cn("min-w-0 text-sm", tone === "warn" ? "text-warn" : "text-fg")}>{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------- reward
function rewardAnswer({
  evaluation,
  bundle,
  challenge,
  attestation,
  evidenceDigest,
}: {
  evaluation: Evaluation;
  bundle: EvidenceBundle;
  challenge: ChallengeView | null;
  attestation: AttestationLike | null;
  evidenceDigest: string | null;
}): { tone: Tone; text: ReactNode } {
  const settlementLink = (
    <TextLink href={`/challenges/${evaluation.challenge_id}/settlement`} className="ml-1">
      Settlement
    </TextLink>
  );
  if (!challenge) return { tone: "neutral", text: "Loading the challenge's settlement state." };
  if (challenge.status === "offchain") {
    return { tone: "neutral", text: "No. This is an off-chain challenge: there is no reward, only evidence." };
  }
  const settle = challenge.transactions.find(
    (t) =>
      t.kind === "settle" &&
      t.status === "confirmed" &&
      typeof t.detail?.evidence_digest === "string" &&
      sameHex(t.detail.evidence_digest, evidenceDigest) === true,
  );
  if (settle) {
    const d = settle.detail ?? {};
    const amount = typeof d.reward_wei === "string" ? formatWei(d.reward_wei, challenge.network) : null;
    const recipient = typeof d.recipient === "string" ? d.recipient : null;
    return {
      tone: "ok",
      text: (
        <div className="text-fg">
          <span className="font-semibold text-ok">Yes.</span> A confirmed settle transaction on {txNetworkPhrase(settle.chain_id)} credited{" "}
          {amount ?? "the reward"} to {recipient ? <span className="font-mono text-xs">{shortAddress(recipient)}</span> : "the bound recipient"}{" "}
          for this evidence (the recipient withdraws it separately).{" "}
          <TxHash hash={settle.hash} chainId={settle.chain_id} label="settle transaction hash" /> <TrustStatement kind="receipt" className="mt-1" />
        </div>
      ),
    };
  }
  if (challenge.status === "settled") {
    return {
      tone: "neutral",
      text: <span>The challenge is settled, but no recorded settle transaction references this evidence. {settlementLink}</span>,
    };
  }
  if (challenge.status === "refunded") return { tone: "neutral", text: "No. The challenge was refunded to the publisher." };
  if (bundle.verdict.outcome !== "verified_violation") {
    return { tone: "neutral", text: "No. Only a verified violation can earn the reward, and this outcome is not one." };
  }
  if (!bundle.verdict.reward_eligible) {
    return { tone: "neutral", text: "No. This verified violation is not reward-eligible under the challenge's reward policy." };
  }
  if (attestation) {
    return {
      tone: "warn",
      text: (
        <span>
          Not yet. The evaluator signed an attestation, but no confirmed settle transaction has been recorded. Anyone may relay it.
          {settlementLink}
        </span>
      ),
    };
  }
  const reward = formatWei(challenge.reward_wei, challenge.network);
  return {
    tone: "warn",
    text: (
      <span>
        Not yet. No attestation has been issued for this verdict, so the {reward} reward has not moved.
      </span>
    ),
  };
}
