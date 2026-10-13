"use client";

import { Play, ShieldAlert, ShieldQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import { NOT_PROOF_OF_SAFETY, TrustStatement } from "@/components/truth";
import { Breadcrumbs, challengeCrumbs } from "@/components/ui/breadcrumbs";
import { ButtonLink, Button } from "@/components/ui/button";
import { Callout, Card, CardBody } from "@/components/ui/card";
import { Select } from "@/components/ui/form";
import { ProvenanceBadge } from "@/components/ui/provenance-badge";
import { PageHeader, Section } from "@/components/ui/section";
import { EmptyState, ErrorState, QueryState } from "@/components/ui/states";
import {
  finishedSummary,
  type CandidateSummary,
  type ChallengeView,
  type Evaluation,
  type EvidenceBundle,
  type Regression,
  type Target,
  type TargetLabel,
} from "@/lib/api";
import { plural } from "@/lib/format";
import {
  adapterOfKey,
  compareVersions,
  isLiveModelLabel,
  isRepairedLabel,
  replayRelation,
  targetLabelText,
  type ReplayRelation,
} from "@/lib/target-labels";
import {
  useCandidate,
  useChallenge,
  useChallengeRegressions,
  useCreateRegression,
  useEvidence,
  useRegression,
  useTargets,
} from "@/lib/queries";
import { isRegressionActive, statusMeta } from "@/lib/status";
import { ActionSequence } from "./action-sequence";
import { ExportPanel, RegressionList, RegressionProgress } from "./regression-parts";
import { unclearRegressionText } from "./regression-reading";
import { ReadOnlyNote } from "@/components/snapshot";
import { SNAPSHOT_MODE } from "@/lib/snapshot";
import { VersionColumn } from "./version-column";
import { ModelProposalsSummary } from "@/components/evidence/model-proposals";

export interface CompareInitial {
  candidate?: string;
  target?: string;
  regression?: string;
}

function targetOptionLabel(t: Target): string {
  return `${t.key} - ${targetLabelText(t.label as TargetLabel, t.requires_model)}`;
}

/** Latest verified-violation evaluation for a candidate (else its latest evaluation). */
function originalEvaluationFor(view: ChallengeView, candidateId: string | null): Evaluation | null {
  if (!candidateId) return null;
  const evs = view.evaluations.filter((e) => e.candidate_id === candidateId).sort((a, b) => b.created_at - a.created_at);
  return evs.find((e) => e.outcome === "verified_violation") ?? evs[0] ?? null;
}

/**
 * Versions that can stand as "the repaired version" of the challenge's agent: the same
 * adapter (agent family), any other version. A different adapter is a different agent, never
 * its repair. Repaired labels first, then newest version first.
 */
export function repairTargets(targets: Target[], view: Pick<ChallengeView, "spec">): Target[] {
  const adapter = view.spec.target.adapter;
  const originalKey = `${adapter}@${view.spec.target.version}`;
  return targets
    .filter((t) => t.adapter === adapter && t.key !== originalKey)
    .sort((a, b) => Number(isRepairedLabel(b.label)) - Number(isRepairedLabel(a.label)) || compareVersions(b.version, a.version));
}

/** The default "repaired version": the best same-family version, or null when there is none. */
export function defaultTargetKey(targets: Target[], view: Pick<ChallengeView, "spec">): string | null {
  return repairTargets(targets, view)[0]?.key ?? null;
}

/** How a recorded regression's target relates to this challenge's own target (see replayRelation). */
export function relationOf(regression: Pick<Regression, "target_key">, view: Pick<ChallengeView, "spec">): ReplayRelation {
  return replayRelation(regression.target_key, view.spec.target);
}

/**
 * True only for a replay on ANOTHER version of the same adapter: the only replay that can stand
 * as "the repaired version". The original version re-run is not a repair, nor is another adapter.
 */
export function isRepairOf(regression: Pick<Regression, "target_key">, view: Pick<ChallengeView, "spec">): boolean {
  return relationOf(regression, view) === "repair";
}

/**
 * The page's lead sentence. In a recording it says whether a repaired version was actually
 * replayed, so the page never announces a before / after that was not recorded.
 */
export function compareDescription(
  view: Pick<ChallengeView, "id" | "spec"> | undefined,
  regs: Pick<Regression, "target_key" | "source_challenge_id">[] | undefined,
  snapshot: boolean = SNAPSHOT_MODE,
): string {
  if (!snapshot) {
    return "The exact action sequence that broke the original version, replayed by the same evaluator against another version of the same agent, then exported as a regression test.";
  }
  if (!view || !regs) return "The exact action sequence that broke the original version, and any recorded replay of it against another version.";
  const adapter = view.spec.target.adapter;
  return regs.some((r) => r.source_challenge_id === view.id && isRepairOf(r, view))
    ? `The exact action sequence that broke the original version, replayed by the same evaluator against another version of ${adapter} and exported as a regression test, as recorded.`
    : `The exact action sequence that broke the original version. No other version of ${adapter} had replayed it when the snapshot was recorded, so no repair is shown; below is the original evidence.`;
}

export function CompareView({ challengeId, initial }: { challengeId: string; initial: CompareInitial }) {
  const viewQ = useChallenge(challengeId);
  const view = viewQ.data;
  const regsQ = useChallengeRegressions(view ? challengeId : null);
  const breadcrumb = <Breadcrumbs items={challengeCrumbs(challengeId, view?.spec.title, "Before / after")} />;
  const header = (
    <PageHeader
      title="Before / after"
      breadcrumb={breadcrumb}
      description={compareDescription(view, regsQ.data)}
      meta={
        view ? (
          <>
            <span className="text-sm text-fg">{view.spec.title}</span>
            <ProvenanceBadge kind="target" value={view.spec.target.label} requiresModel={view.target_info?.requires_model} size="md" />
          </>
        ) : undefined
      }
    />
  );
  if (!view) {
    return (
      <>
        {header}
        <QueryState
          query={viewQ}
          label="challenge"
          card
          rows={6}
          notFound={{
            title: `Challenge #${challengeId} does not exist`,
            description: "The backend has no challenge with this id, so there is nothing to compare.",
            action: <ButtonLink href="/challenges">All challenges</ButtonLink>,
          }}
        />
      </>
    );
  }
  return (
    <>
      {header}
      <Comparison view={view} initial={initial} />
    </>
  );
}

function Comparison({ view, initial }: { view: ChallengeView; initial: CompareInitial }) {
  const targetsQ = useTargets();
  const regsQ = useChallengeRegressions(view.id);
  const create = useCreateRegression(view.id);

  const [candidatePick, setCandidatePick] = useState<string | null>(initial.candidate ?? null);
  const [targetPick, setTargetPick] = useState<string | null>(initial.target ?? null);
  const [regressionPick, setRegressionPick] = useState<string | null>(initial.regression ?? null);

  const regs = regsQ.data ?? [];
  // A repair is another version of the same adapter; see isRepairOf.
  const repairsOf = (cid: string | null) => regs.filter((r) => r.source_candidate_id === cid && isRepairOf(r, view));

  const verified: CandidateSummary[] = view.candidates
    .filter((c) => c.status === "verified_violation")
    .sort((a, b) => b.created_at - a.created_at);
  // Default: the newest verified counterexample that has a recorded repair replay, else the newest.
  const defaultCandidate = verified.find((c) => repairsOf(c.id).length > 0)?.id ?? verified[0]?.id ?? null;
  const candidateId = candidatePick && verified.some((c) => c.id === candidatePick) ? candidatePick : defaultCandidate;

  const targets = targetsQ.data ?? [];
  // Only versions of the same agent family are offered: another adapter is not this agent's repair.
  const options = repairTargets(targets, view);
  const targetKey = targetPick && options.some((t) => t.key === targetPick) ? targetPick : defaultTargetKey(targets, view);
  const adapter = view.spec.target.adapter;
  const originalKey = `${adapter}@${view.spec.target.version}`;

  // By default only a repair (another version of the same adapter) fills the "After" column; a
  // recorded re-run of the original version or a replay against another agent family is listed
  // below (labelled) and shown only when picked explicitly.
  const candidateRepairs = repairsOf(candidateId);
  const regressionId = regressionPick ?? candidateRepairs[0]?.id ?? null;
  const regressionQ = useRegression(regressionId);
  const regressionRaw: Regression | null = regressionQ.data ?? regs.find((r) => r.id === regressionId) ?? null;
  // A regression id from the URL that belongs to another challenge is ignored.
  const regression = regressionRaw && regressionRaw.source_challenge_id === view.id ? regressionRaw : null;

  const sourceCandidateId = regression?.source_candidate_id ?? candidateId;
  const sourceCandidate = view.candidates.find((c) => c.id === sourceCandidateId) ?? null;
  const originalEval = originalEvaluationFor(view, sourceCandidateId);
  const beforeQ = useEvidence(originalEval?.evidence_digest);
  const candidateQ = useCandidate(sourceCandidateId);
  const afterQ = useEvidence(regression?.evidence_digest);

  const ruleId = sourceCandidate?.claimed_rule ?? finishedSummary(originalEval)?.rule?.rule_id ?? null;
  const rule = view.spec.rules.find((r) => r.id === ruleId) ?? null;
  const currency = view.spec.initial_state.currency || "SYN";

  // Keep the selection in the URL so a comparison can be shared (no server round trip).
  useEffect(() => {
    const qs = new URLSearchParams();
    if (candidateId) qs.set("candidate", candidateId);
    if (targetKey) qs.set("target", targetKey);
    if (regressionId) qs.set("regression", regressionId);
    const next = `${window.location.pathname}${qs.size ? `?${qs.toString()}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", next);
  }, [candidateId, targetKey, regressionId]);

  const onStart = async () => {
    if (!candidateId || !targetKey) return;
    try {
      const reg = await create.mutateAsync({ candidate_id: candidateId, target: targetKey });
      setRegressionPick(reg.id);
    } catch {
      // shown below from create.error
    }
  };

  const selectedTarget = options.find((t) => t.key === targetKey) ?? null;
  const active = !!regression && isRegressionActive(regression.status);
  const relation: ReplayRelation | null = regression ? relationOf(regression, view) : null;
  const beforeActions = beforeQ.data?.candidate?.actions ?? candidateQ.data?.json.actions ?? null;
  const afterActions = afterQ.data?.candidate?.actions ?? null;

  return (
    <div className="space-y-8">
      <Section
        title={SNAPSHOT_MODE ? "Verified counterexample" : "Replay a verified counterexample"}
        description={
          !SNAPSHOT_MODE
            ? "The evaluator replays the identical action sequence in a fresh synthetic marketplace, with the same rules and initial state, against the version you choose. No reward is involved."
            : !regsQ.data
              ? "The evaluator's recorded replays of this counterexample. No reward is involved."
              : candidateRepairs.length > 0
                ? `The evaluator replayed the identical action sequence in a fresh synthetic marketplace, with the same rules and initial state, against another version of ${adapter}. Below is what it recorded. No reward is involved.`
                : `The verified action sequence and the original evaluation, as recorded. No repaired version had replayed it${regression ? "; the other replay shown is not a repair" : ", so the After column stays empty"}. No reward is involved.`
        }
      >
        {verified.length === 0 ? (
          <EmptyState
            icon={<ShieldQuestion />}
            title="No verified violation to compare yet"
            description={
              SNAPSHOT_MODE
                ? "A before / after comparison starts from a sequence the evaluator has independently verified; none had been verified for this challenge when the snapshot was recorded."
                : "A before / after comparison starts from a sequence the evaluator has independently verified. Run a search and submit a candidate on the challenge page first."
            }
            action={
              <ButtonLink href={`/challenges/${view.id}`} size="sm">
                Open the challenge
              </ButtonLink>
            }
          />
        ) : (
          <Card>
            <CardBody className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Select
                  label="Verified counterexample"
                  value={candidateId ?? ""}
                  onChange={(e) => {
                    setCandidatePick(e.target.value);
                    setRegressionPick(null);
                  }}
                  options={verified.map((c) => {
                    const s = finishedSummary(originalEvaluationFor(view, c.id));
                    return { value: c.id, label: `${c.claimed_rule}: ${s?.summary ?? c.digest} (${c.id})` };
                  })}
                  hint={
                    SNAPSHOT_MODE
                      ? "Shows the recorded comparison for this counterexample. Only candidates the evaluator verified as violations are listed (newest first)."
                      : "Only candidates the evaluator verified as violations are listed (newest first)."
                  }
                />
                {SNAPSHOT_MODE ? (
                  <ReadOnlyNote action="Replaying this counterexample against another version (a new regression)" className="self-start" />
                ) : targetsQ.isError ? (
                  <ErrorState error={targetsQ.error} title="Could not load target versions" onRetry={() => void targetsQ.refetch()} compact />
                ) : !targetsQ.isPending && options.length === 0 ? (
                  <Callout tone="neutral" icon={<ShieldQuestion />} title={`No repaired version of ${adapter} to replay against`} className="self-start">
                    This backend&apos;s catalogue has no version of <span className="font-mono text-xs">{adapter}</span> other than{" "}
                    <span className="font-mono text-xs">{originalKey}</span>, the original. A different agent (another adapter) is
                    not this agent&apos;s repair, so none is offered.
                  </Callout>
                ) : (
                  <Select
                    label={`Replay against a version of ${adapter}`}
                    value={targetKey ?? ""}
                    disabled={targetsQ.isPending}
                    onChange={(e) => setTargetPick(e.target.value)}
                    options={options.map((t) => ({ value: t.key, label: targetOptionLabel(t) }))}
                    placeholder={targetsQ.isPending ? "Loading versions" : undefined}
                    hint={
                      selectedTarget
                        ? `${selectedTarget.description} Only versions of the same agent (${adapter}) are offered; another adapter is not its repair.`
                        : `Only versions of the same agent (${adapter}) are offered; another adapter is not its repair.`
                    }
                  />
                )}
              </div>
              {SNAPSHOT_MODE || options.length === 0 ? null : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="primary"
                    icon={<Play />}
                    onClick={onStart}
                    disabled={!candidateId || !targetKey}
                    busy={create.isPending}
                    busyLabel="Queueing the replay"
                  >
                    Replay against {targetKey ?? "the chosen version"}
                  </Button>
                  {selectedTarget ? (
                    <ProvenanceBadge kind="target" value={selectedTarget.label} requiresModel={selectedTarget.requires_model} size="md" />
                  ) : null}
                </div>
              )}
              {!SNAPSHOT_MODE && selectedTarget && (isLiveModelLabel(selectedTarget.label) || selectedTarget.determinism === "stochastic") ? (
                <p className="text-xs text-warn">
                  This version is driven by a hosted language model: its replays are stochastic and need a configured model
                  provider, so a result may differ between runs.
                </p>
              ) : null}
              {create.isError ? <ErrorState error={create.error} title="The regression was not queued" compact /> : null}
            </CardBody>
          </Card>
        )}
      </Section>

      {verified.length > 0 || regression ? (
        <Section
          title="Comparison"
          description="Left: the original, independently verified result. Right: the same sequence on the replayed version; only another version of the same agent counts as a repair. Every value comes from the two evidence bundles."
        >
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,19rem)_minmax(0,1fr)]">
            <VersionColumn
              eyebrow="Before"
              title="Original evaluation"
              status={originalEval?.status ?? null}
              domain="evaluation"
              bundle={originalEval?.evidence_digest ? beforeQ : null}
              rule={rule}
              currency={currency}
              evidenceHref={originalEval ? `/evaluations/${originalEval.id}` : null}
              placeholder={originalEval ? undefined : <p className="text-sm text-muted">No evaluation found for this candidate.</p>}
            />
            <ActionSequence
              before={beforeActions}
              after={afterActions}
              candidateDigest={sourceCandidate?.digest ?? null}
              afterCandidateDigest={afterQ.data?.submission.candidate_digest ?? null}
              initialState={view.spec.initial_state}
            />
            <VersionColumn
              eyebrow={
                relation === "other-family" ? "Different agent family" : relation === "same-version" ? "Same version re-run, not a repair" : "After"
              }
              title={
                !regression
                  ? "Repaired version: none replayed"
                  : relation === "repair"
                    ? `Regression on ${regression.target_key}`
                    : relation === "same-version"
                      ? `${regression.target_key} again - the original version`
                      : `${regression.target_key} - not a version of ${adapter}`
              }
              status={regression?.status ?? null}
              domain="regression"
              bundle={regression?.evidence_digest ? afterQ : null}
              footer={<ModelProposalsSummary digest={regression?.model_proposals_digest} />}
              rule={rule}
              currency={currency}
              placeholder={
                !regression ? (
                  <EmptyState
                    compact
                    title="No repaired version of this agent has been replayed yet"
                    description={
                      SNAPSHOT_MODE
                        ? `No other version of ${adapter} had replayed this counterexample when the snapshot was taken. A replay against a different agent family would not show a repair.`
                        : options.length > 0
                          ? `Choose a version of ${adapter} above and start the replay; the result appears here.`
                          : `No other version of ${adapter} has replayed this counterexample. A replay against a different agent family would not show a repair.`
                    }
                  />
                ) : active ? (
                  <RegressionProgress regression={regression} />
                ) : regressionQ.isError ? (
                  <ErrorState error={regressionQ.error} onRetry={() => void regressionQ.refetch()} compact />
                ) : undefined
              }
            />
          </div>
          {regression && !active ? (
            <Verdict
              regression={regression}
              ruleId={ruleId}
              adapter={adapter}
              relation={relation ?? "repair"}
              label={afterQ.data?.target.label ?? targets.find((t) => t.key === regression.target_key)?.label ?? null}
              after={afterQ.data ?? null}
            />
          ) : null}
        </Section>
      ) : null}

      {regression ? (
        <Section title="Regression test" description="Keep the counterexample so the defect cannot quietly come back.">
          <ExportPanel regression={regression} />
        </Section>
      ) : null}

      <Section
        title="Previous regressions"
        description="Every recorded replay of this challenge's counterexamples, newest first. Only a replay on another version of the same agent counts as a repair; the others are marked."
      >
        <RegressionList
          query={regsQ}
          original={{ adapter, version: view.spec.target.version }}
          selectedId={regressionId}
          onSelect={(r) => {
            setRegressionPick(r.id);
            setCandidatePick(r.source_candidate_id);
          }}
        />
      </Section>
    </div>
  );
}

/**
 * The honest reading of the regression result. "The repaired version resisted" is said only
 * for a replay on ANOTHER version of the same agent family against a deterministic target; a
 * live model gets what was observed, with replay counts, as bounded statistical evidence; a
 * re-run of the original version and a different agent family are never called a repair.
 */
export function Verdict({
  regression,
  ruleId,
  adapter,
  relation,
  label,
  after,
}: {
  regression: Regression;
  ruleId: string | null;
  /** The challenge's own agent family (adapter). */
  adapter: string;
  /** How the replayed target relates to the challenge's target (see replayRelation). */
  relation: ReplayRelation;
  label: string | null;
  /** The regression's evidence bundle, for replay counts (null while it loads). */
  after: Pick<EvidenceBundle, "replays" | "reproducibility" | "target"> | null;
}) {
  const rule = ruleId ?? "the claimed rule";
  const key = regression.target_key;
  const n = after?.replays.length ?? 0;
  const violated = after ? after.replays.filter((r) => r.claimed_rule_violated).length : null;
  const stochastic = after?.target.determinism === "stochastic" || isLiveModelLabel(label);
  const outcomeText = statusMeta(regression.outcome ?? regression.status, "regression").label.toLowerCase();
  const counts =
    after && n > 0 ? (
      <>
        {rule} was violated in{" "}
        <span className="font-semibold tabular">
          {violated} of {n}
        </span>{" "}
        fresh {plural(n, "replay")} on {key} (the spec&apos;s policy needs {after.reproducibility.required_violations} of{" "}
        {after.reproducibility.replays}).
      </>
    ) : null;
  const statistical = stochastic
    ? " The decisions come from a hosted language model, so these counts are bounded statistical evidence about this model, this sequence and this date."
    : "";

  if (relation === "other-family") {
    return (
      <Callout tone="warn" icon={<ShieldQuestion />} title={`${key} is a different agent family, not a repair of ${adapter}`} className="mt-4" role="status">
        <p>
          This replay ran the same sequence against <span className="font-mono text-xs">{adapterOfKey(key)}</span>, another agent
          (adapter), not a version of <span className="font-mono text-xs">{adapter}</span>. Its outcome ({outcomeText}) says nothing
          about whether {adapter} was fixed. {counts}
        </p>
      </Callout>
    );
  }
  if (relation === "same-version") {
    return (
      <Callout tone="warn" icon={<ShieldQuestion />} title={`${key} is the original version re-run, not a repair`} className="mt-4" role="status">
        <p>
          This replay ran the same sequence against the original version again, not against a changed version of{" "}
          <span className="font-mono text-xs">{adapter}</span>. Its outcome ({outcomeText}) says nothing about a repair.
          {stochastic ? " A live model's decisions vary between runs, so a re-run of the unchanged agent can come out differently." : ""}{" "}
          {counts}
          {statistical}
        </p>
      </Callout>
    );
  }
  if (regression.outcome === "not_reproduced") {
    if (stochastic) {
      return (
        <div className="mt-4 space-y-2">
          <Callout tone="ok" icon={<ShieldQuestion />} title={`Observed on ${key}: ${rule} was not reproduced`} role="status">
            <p>
              {counts ?? "Replay counts are in the evidence bundle."} The decisions come from a hosted language model, so this is
              bounded statistical evidence about this model, this sequence and this date, not proof that the repair holds.{" "}
              {NOT_PROOF_OF_SAFETY}
            </p>
          </Callout>
        </div>
      );
    }
    return (
      <Callout tone="ok" icon={<ShieldQuestion />} title={`${key} resisted this sequence`} className="mt-4" role="status">
        <p>
          {isRepairedLabel(label) ? "The repaired version" : "This version"} resisted this sequence; this does not prove it is
          free of other defects. It was replayed with one action sequence, one initial state and the rules listed in the spec.{" "}
          {counts} {NOT_PROOF_OF_SAFETY}
        </p>
      </Callout>
    );
  }
  if (regression.outcome === "verified_violation") {
    if (stochastic) {
      return (
        <Callout tone="bad" icon={<ShieldAlert />} title={`Observed on ${key}: ${rule} was reproduced`} className="mt-4" role="status">
          <p>
            {counts ?? "Replay counts are in the evidence bundle."} The repair did not hold for this counterexample in these
            replays.{statistical}
          </p>
        </Callout>
      );
    }
    return (
      <Callout tone="bad" icon={<ShieldAlert />} title={`${key} still violates ${rule}`} className="mt-4" role="status">
        The same action sequence still breaks the rule on this version of {adapter}. The repair did not hold for this
        counterexample. {counts}
      </Callout>
    );
  }
  return (
    <div className="mt-4 space-y-2">
      <Callout tone="warn" icon={<ShieldQuestion />} title="No clear result for this version" role="status">
        {unclearRegressionText(regression)} {counts}
        {statistical}
      </Callout>
      <TrustStatement kind="not-proof" />
    </div>
  );
}
