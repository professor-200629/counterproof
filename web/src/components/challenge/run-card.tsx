"use client";

import { Search, Square } from "lucide-react";
import { RunProgress } from "@/components/run-progress";
import { LOCAL_CHECK_NOTE, NoViolationFacts, searchLimitations } from "@/components/truth";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardBody, CardHeader } from "@/components/ui/card";
import { JsonView } from "@/components/ui/json-view";
import { ErrorState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { TimeAgo } from "@/components/ui/time";
import type { ChallengeView, RunSummary } from "@/lib/api";
import { formatNumber, plural } from "@/lib/format";
import { useCancelRun } from "@/lib/queries";
import { isRunActive } from "@/lib/status";
import { Mono } from "@/components/ui/text-link";
import { Disclosure } from "@/components/ui/disclosure";
import { ReadOnlyNote } from "@/components/snapshot";
import { SNAPSHOT_MODE } from "@/lib/snapshot";

/** What each search-generator mode means (the strategy's mode, not the target's). */
const GENERATOR_WORDS: Record<string, string> = {
  deterministic: "a fixed strategy enumerates sequences; no model proposes them",
  "model-assisted": "a language model proposes sequences",
};

export interface RunCardProps {
  run: RunSummary;
  view: ChallengeView;
  strategyTitle?: string;
  /** Switches the page to the Findings tab. */
  onShowFindings?: () => void;
}

/** One search run: real progress, why it stopped, errors, and what its result does and does not mean. */
export function RunCard({ run, view, strategyTitle, onShowFindings }: RunCardProps) {
  const cancel = useCancelRun(view.id);
  const rec = run.record;
  const active = isRunActive(run.status);
  const prov = rec?.provenance;
  const candidateCount = rec?.candidate_ids?.length ?? rec?.candidates.length ?? 0;
  const outcomes = rec ? Object.entries(rec.run_outcomes) : [];
  // run.error is usually the search errors joined; list them separately only when they add something.
  const extraErrors = rec ? rec.errors.filter((e) => !run.error || !run.error.includes(e)) : [];
  // The run's mode is the search generator's; the target's own nature is separate.
  const liveTarget =
    prov?.target_determinism === "stochastic" || view.spec.target.determinism === "stochastic" || view.target_info?.requires_model === true;
  const configModel = view.spec.target.config.model;
  const targetModel = prov?.target_model ?? (typeof configModel === "string" ? configModel : null);

  return (
    <Card as="li">
      <CardHeader
        level={3}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {strategyTitle ?? run.strategy}
            <span className="font-mono text-xs font-normal text-muted">{run.id}</span>
          </span>
        }
        description={
          <span className="text-xs">
            Search generator: <span className="font-medium text-fg">{run.mode}</span>
            {GENERATOR_WORDS[run.mode] ? ` (${GENERATOR_WORDS[run.mode]})` : ""} - started <TimeAgo ts={run.created_at} />
            {rec?.strategy_version ? ` - strategy v${rec.strategy_version}` : ""}
          </span>
        }
        actions={
          <>
            <StatusBadge status={run.status} domain="run" />
            {active && !SNAPSHOT_MODE ? (
              <Button
                size="sm"
                variant="danger"
                icon={<Square />}
                busy={cancel.isPending}
                busyLabel="Cancelling..."
                onClick={() => cancel.mutate(run.id)}
              >
                Cancel
              </Button>
            ) : null}
          </>
        }
      />
      <CardBody className="space-y-3">
        {liveTarget ? (
          <p className="rounded-md border border-line bg-inset px-3 py-2 text-xs text-muted">
            <span className="font-medium text-fg">Search generator is not the target.</span> &quot;{run.mode}&quot; describes how this
            search produced action sequences. The agent under test is a live model
            {targetModel ? (
              <>
                {" "}
                (<span className="font-mono text-fg">{targetModel}</span>)
              </>
            ) : null}
            : its replies are stochastic, so the same sequence can behave differently on another run.
          </p>
        ) : null}
        <RunProgress status={run.status} record={rec} />

        {active && SNAPSHOT_MODE ? (
          <ReadOnlyNote action="This run was still active when the snapshot was recorded; its progress above is the last the worker reported, and cancelling it" />
        ) : null}

        {cancel.isError ? <ErrorState error={cancel.error} title="Cancel refused" compact /> : null}

        {run.error ? (
          <Callout tone="warn" title="The run failed - no conclusion about the agent">
            <span className="break-words font-mono text-xs">{run.error}</span>
          </Callout>
        ) : null}

        {extraErrors.length > 0 ? (
          <Callout tone="warn" title={`Errors reported during the search (${extraErrors.length})`}>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono text-xs">
              {extraErrors.slice(0, 10).map((e, i) => (
                <li key={i} className="break-words">
                  {e}
                </li>
              ))}
            </ul>
            {extraErrors.length > 10 ? <p className="mt-1 text-xs">{extraErrors.length - 10} more in the run record.</p> : null}
          </Callout>
        ) : null}

        {prov?.provider_errors && prov.provider_errors.length > 0 ? (
          <Callout tone="warn" title="Model provider errors (the provider failed, not the agent)">
            <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono text-xs">
              {prov.provider_errors.map((e, i) => (
                <li key={i} className="break-words">
                  {e}
                </li>
              ))}
            </ul>
          </Callout>
        ) : null}

        {rec ? (
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            {prov ? (
              <div className="flex gap-1">
                <dt className="text-muted">Target inference</dt>
                <dd className="text-fg">{prov.inference}</dd>
              </div>
            ) : null}
            {prov?.generator ? (
              <div className="flex gap-1">
                <dt className="text-muted">Generator model</dt>
                <dd className="font-mono text-fg">
                  {prov.generator.model} ({formatNumber(prov.generator.calls)} calls)
                </dd>
              </div>
            ) : null}
            {prov?.target_model ? (
              <div className="flex gap-1">
                <dt className="text-muted">Target model</dt>
                <dd className="font-mono text-fg">{prov.target_model}</dd>
              </div>
            ) : null}
            {outcomes.length > 0 ? (
              <div className="flex gap-1">
                <dt className="text-muted">Target run outcomes</dt>
                <dd className="font-mono text-fg">{outcomes.map(([k, n]) => `${k} ${formatNumber(n)}`).join(", ")}</dd>
              </div>
            ) : null}
            {rec.rules_violated.length > 0 ? (
              <div className="flex gap-1">
                <dt className="text-muted">Self-check flagged</dt>
                <dd className="flex gap-1">
                  {rec.rules_violated.map((r) => (
                    <Mono key={r}>{r}</Mono>
                  ))}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {run.status === "candidate_found" ? (
          <Callout tone="warn" icon={<Search />} title={`${candidateCount} unverified ${plural(candidateCount, "candidate")}`}>
            <p>{LOCAL_CHECK_NOTE}</p>
            {onShowFindings ? (
              <Button size="sm" className="mt-2" onClick={onShowFindings}>
                Review in Findings
              </Button>
            ) : null}
          </Callout>
        ) : null}

        {run.status === "no_violation_found" && rec ? (
          <NoViolationFacts
            target={view.spec.target}
            rules={view.spec.rules}
            record={rec}
            strategy={strategyTitle ?? run.strategy}
            limitations={searchLimitations(view.spec)}
          />
        ) : null}

        {run.status === "cancelled" ? (
          <p className="text-sm text-muted">Cancelled before completion; nothing can be concluded from a cancelled run.</p>
        ) : null}

        {rec && rec.samples.length > 0 ? (
          <Disclosure
            summary={
              <>
                Sample sequences from this run{" "}
                <span className="text-muted">
                  ({rec.samples.length} kept of {formatNumber(rec.sequences_tried)} tried)
                </span>
              </>
            }
          >
            <JsonView value={rec.samples} label="Samples recorded by the search" collapsedDepth={1} maxHeight="20rem" />
          </Disclosure>
        ) : null}
      </CardBody>
    </Card>
  );
}
