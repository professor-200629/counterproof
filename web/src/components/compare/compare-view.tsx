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
  type Regression,
  type Target,
  type TargetLabel,
} from "@/lib/api";
import {
  useCandidate,
  useChallenge,
  useChallengeRegressions,
  useCreateRegression,
  useEvidence,
  useRegression,
  useTargets,
} from "@/lib/queries";
import { isRegressionActive } from "@/lib/status";
import { ActionSequence } from "./action-sequence";
import { ExportPanel, RegressionList, RegressionProgress } from "./regression-parts";
import { unclearRegressionText } from "./regression-reading";
import { ReadOnlyNote } from "@/components/snapshot";
import { SNAPSHOT_MODE } from "@/lib/snapshot";
import { VersionColumn } from "./version-column";

export interface CompareInitial {
  candidate?: string;
  target?: string;
  regression?: string;
}

const LABEL_WORDS: Record<TargetLabel, string> = {
  "intentionally-vulnerable-fixture": "intentionally vulnerable fixture",
  "repaired-fixture": "repaired fixture",
  "independent-implementation": "independent implementation, live model",
};

function targetOptionLabel(t: Target, originalKey: string): string {
  const word = LABEL_WORDS[t.label as TargetLabel] ?? t.label;
  return `${t.key} - ${word}${t.key === originalKey ? " (the original version)" : ""}`;
}

/** Latest verified-violation evaluation for a candidate (else its latest evaluation). */
function originalEvaluationFor(view: ChallengeView, candidateId: string | null): Evaluation | null {
  if (!candidateId) return null;
  const evs = view.evaluations.filter((e) => e.candidate_id === candidateId).sort((a, b) => b.created_at - a.created_at);
  return evs.find((e) => e.outcome === "verified_violation") ?? evs[0] ?? null;
}

function defaultTargetKey(targets: Target[], view: ChallengeView): string | null {
  const originalKey = `${view.spec.target.adapter}@${view.spec.target.version}`;
  return (
    targets.find((t) => t.label === "repaired-fixture" && t.adapter === view.spec.target.adapter)?.key ??
    targets.find((t) => t.label === "repaired-fixture")?.key ??
    targets.find((t) => t.key !== originalKey)?.key ??
    targets[0]?.key ??
    null
  );
}

export function CompareView({ challengeId, initial }: { challengeId: string; initial: CompareInitial }) {
  const viewQ = useChallenge(challengeId);
  const view = viewQ.data;
  const breadcrumb = <Breadcrumbs items={challengeCrumbs(challengeId, view?.spec.title, "Before / after")} />;
  const header = (
    <PageHeader
      title="Before / after"
      breadcrumb={breadcrumb}
      description="The exact action sequence that broke the original version, replayed by the same evaluator against a new version, then exported as a regression test."
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

  const verified: CandidateSummary[] = view.candidates
    .filter((c) => c.status === "verified_violation")
    .sort((a, b) => b.created_at - a.created_at);
  const candidateId = candidatePick && verified.some((c) => c.id === candidatePick) ? candidatePick : (verified[0]?.id ?? null);

  const targets = targetsQ.data ?? [];
  const targetKey = targetPick && targets.some((t) => t.key === targetPick) ? targetPick : defaultTargetKey(targets, view);
  const originalKey = `${view.spec.target.adapter}@${view.spec.target.version}`;

  const regs = regsQ.data ?? [];
  const regressionId = regressionPick ?? regs.find((r) => r.source_candidate_id === candidateId)?.id ?? null;
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

  const selectedTarget = targets.find((t) => t.key === targetKey) ?? null;
  const active = !!regression && isRegressionActive(regression.status);
  const beforeActions = beforeQ.data?.candidate?.actions ?? candidateQ.data?.json.actions ?? null;
  const afterActions = afterQ.data?.candidate?.actions ?? null;

  return (
    <div className="space-y-8">
      <Section
        title={SNAPSHOT_MODE ? "Verified counterexample" : "Replay a verified counterexample"}
        description={
          SNAPSHOT_MODE
            ? "The evaluator replayed the identical action sequence in a fresh synthetic marketplace, with the same rules and initial state, against another version. Below is what it recorded. No reward is involved."
            : "The evaluator replays the identical action sequence in a fresh synthetic marketplace, with the same rules and initial state, against the version you choose. No reward is involved."
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
                ) : (
                  <Select
                    label="Replay against version"
                    value={targetKey ?? ""}
                    disabled={targetsQ.isPending}
                    onChange={(e) => setTargetPick(e.target.value)}
                    options={targets.map((t) => ({ value: t.key, label: targetOptionLabel(t, originalKey) }))}
                    placeholder={targetsQ.isPending ? "Loading versions" : undefined}
                    hint={selectedTarget ? selectedTarget.description : "Default: the repaired fixture."}
                  />
                )}
              </div>
              {SNAPSHOT_MODE ? null : (
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
              {!SNAPSHOT_MODE && selectedTarget?.label === "independent-implementation" ? (
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
          description="Left: the original, independently verified result. Right: the same sequence on the new version. Every value comes from the two evidence bundles."
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
              eyebrow="After"
              title={regression ? `Regression on ${regression.target_key}` : "New version"}
              status={regression?.status ?? null}
              domain="regression"
              bundle={regression?.evidence_digest ? afterQ : null}
              rule={rule}
              currency={currency}
              placeholder={
                !regression ? (
                  <EmptyState
                    compact
                    title="Not replayed against a new version yet"
                    description={
                      SNAPSHOT_MODE
                        ? "No regression of this counterexample had been recorded when the snapshot was taken."
                        : "Choose a version above and start the replay; the result appears here."
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
          {regression && !active ? <Verdict regression={regression} ruleId={ruleId} label={afterQ.data?.target.label ?? targets.find((t) => t.key === regression.target_key)?.label ?? null} /> : null}
        </Section>
      ) : null}

      {regression ? (
        <Section title="Regression test" description="Keep the counterexample so the defect cannot quietly come back.">
          <ExportPanel regression={regression} />
        </Section>
      ) : null}

      <Section title="Previous regressions" description="Every replay of this challenge's counterexamples against another version, newest first.">
        <RegressionList
          query={regsQ}
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

/** The honest reading of the regression result. */
function Verdict({ regression, ruleId, label }: { regression: Regression; ruleId: string | null; label: string | null }) {
  const rule = ruleId ?? "the claimed rule";
  if (regression.outcome === "not_reproduced") {
    return (
      <Callout tone="ok" icon={<ShieldQuestion />} title={`${regression.target_key} resisted this sequence`} className="mt-4" role="status">
        <p>
          {label === "repaired-fixture" ? "The repaired version" : "This version"} resisted this sequence; this does not prove it is
          free of other defects. It was replayed with
          one action sequence, one initial state and the rules listed in the spec. {NOT_PROOF_OF_SAFETY}
        </p>
      </Callout>
    );
  }
  if (regression.outcome === "verified_violation") {
    return (
      <Callout tone="bad" icon={<ShieldAlert />} title={`${regression.target_key} still violates ${rule}`} className="mt-4" role="status">
        The same action sequence still breaks the rule on this version. The repair did not hold for this counterexample.
      </Callout>
    );
  }
  return (
    <div className="mt-4 space-y-2">
      <Callout tone="warn" icon={<ShieldQuestion />} title="No clear result for this version" role="status">
        {unclearRegressionText(regression)}
      </Callout>
      <TrustStatement kind="not-proof" />
    </div>
  );
}
