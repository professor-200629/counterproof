"use client";

import { Callout } from "@/components/ui/card";
import { EmptyState, QueryState } from "@/components/ui/states";
import { Section } from "@/components/ui/section";
import type { AppConfig, ChallengeView, Strategy } from "@/lib/api";
import { formatNumber, plural } from "@/lib/format";
import { useStrategies } from "@/lib/queries";
import { isRunActive } from "@/lib/status";
import { ReadOnlyNote } from "@/components/snapshot";
import { SNAPSHOT_MODE } from "@/lib/snapshot";
import { RunCard } from "./run-card";
import { StrategyCard } from "./strategy-card";

/**
 * Why the backend would refuse a run right now, from the same facts it checks
 * (services.start_run): challenge status and the submission deadline.
 */
export function runBlockedReason(view: ChallengeView, nowMs: number | null): string | null {
  if (view.status === "awaiting_funding") return "Fund the challenge first.";
  if (view.status === "settled" || view.status === "refunded") return `The challenge is ${view.status}; no further testing.`;
  if (nowMs !== null && nowMs / 1000 > view.spec.deadlines.submission_deadline) return "The submission deadline has passed.";
  return null;
}

export interface TestingTabProps {
  view: ChallengeView;
  config: AppConfig | null;
  nowMs: number | null;
  onShowFindings: () => void;
}

/** Live testing: strategies with a Run button each, then every run with real progress. */
export function TestingTab({ view, config, nowMs, onShowFindings }: TestingTabProps) {
  const strategies = useStrategies();
  const blocked = runBlockedReason(view, nowMs);
  const requiredIso = view.spec.environment.isolation;
  const iso = config?.isolation?.[requiredIso] ?? null;
  const requiresModel = !!view.target_info?.requires_model;
  // Budget prefill only: when the catalogue does not know the target, a stochastic target is model-driven.
  const modelDrivenTarget = view.target_info ? view.target_info.requires_model : view.spec.target.determinism === "stochastic";
  const runs = [...view.runs].sort((a, b) => b.created_at - a.created_at);
  const activeCount = runs.filter((r) => isRunActive(r.status)).length;
  const titleOf = (id: string) => strategies.data?.find((s: Strategy) => s.id === id)?.title;

  return (
    <div className="space-y-8">
      {SNAPSHOT_MODE ? (
        <ReadOnlyNote action="Starting or cancelling a search run" />
      ) : (
        <div className="space-y-3">
          {blocked ? (
            <Callout tone="neutral" title="Runs are closed">
              {blocked} The backend refuses new search runs for this challenge.
            </Callout>
          ) : null}
          {iso && !iso.available ? (
            <Callout tone="warn" title={`Required isolation "${requiredIso}" is unavailable`}>
              {iso.detail}. Runs and replays for this spec fail closed until it is available.
            </Callout>
          ) : null}
          {requiresModel && !config?.live_model.provider ? (
            <Callout tone="warn" title="This target needs a live model">
              The backend has no live model provider configured (COUNTERPROOF_LLM_PROVIDER), so it will refuse runs against this target.
            </Callout>
          ) : null}
        </div>
      )}

      <Section
        title="Search strategies"
        description="A challenger tool searches for action sequences that break a rule. Whatever it finds is only a candidate until the evaluator replays it."
      >
        {strategies.data ? (
          strategies.data.length === 0 ? (
            <EmptyState title="The backend lists no strategies" compact />
          ) : (
            <ul className="grid gap-4 md:grid-cols-2">
              {strategies.data.map((s) => (
                <StrategyCard
                  key={s.id}
                  strategy={s}
                  challengeId={view.id}
                  rules={view.spec.rules}
                  config={config}
                  targetRequiresModel={modelDrivenTarget}
                  blockedReason={blocked}
                />
              ))}
            </ul>
          )
        ) : (
          <QueryState query={strategies} label="strategies" rows={4} card />
        )}
      </Section>

      <Section
        title="Runs"
        description={
          runs.length
            ? SNAPSHOT_MODE
              ? `${formatNumber(runs.length)} ${plural(runs.length, "run")}${activeCount ? `, ${activeCount} still active when recorded - progress as the worker last reported it` : ""}, as recorded.`
              : `${formatNumber(runs.length)} ${plural(runs.length, "run")}${activeCount ? `, ${activeCount} active - progress refreshes from the worker's own counts` : ""}.`
            : undefined
        }
      >
        {runs.length === 0 ? (
          <EmptyState
            title="No runs yet"
            description={
              SNAPSHOT_MODE
                ? "No search run had been started when this snapshot was recorded."
                : blocked
                  ? blocked
                  : "Start a strategy above. Progress comes only from the worker's reported counts."
            }
            compact
          />
        ) : (
          <ul className="space-y-4">
            {runs.map((r) => (
              <RunCard key={r.id} run={r} view={view} strategyTitle={titleOf(r.strategy)} onShowFindings={onShowFindings} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
