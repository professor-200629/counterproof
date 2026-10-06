import type { ReactNode } from "react";
import { StatusBadge, StatusIconGlyph } from "@/components/ui/status-badge";
import { toneSurface, type Tone } from "@/components/ui/tone";
import type { EvidenceBundle } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { statusMeta } from "@/lib/status";
import { Mono } from "@/components/ui/text-link";

/**
 * Verdict colour: red only for a verified violation, green only for "not reproduced", amber
 * for every outcome that is not a verdict about the rule (inconclusive, timeout, target
 * crash, runner failure, malformed submission). Same mapping as StatusBadge (lib/status.ts),
 * so an outcome has one colour on every page.
 */
export function verdictTone(outcome: string | null | undefined): Tone {
  return outcome ? statusMeta(outcome, "evaluation").tone : "neutral";
}

/** Evaluation outcome pill (StatusBadge in the evaluation domain). */
export function VerdictBadge({ outcome, size = "md" }: { outcome: string | null | undefined; size?: "sm" | "md" | "lg" }) {
  return <StatusBadge status={outcome} domain="evaluation" size={size} />;
}

const HEADLINE: Record<string, string> = {
  verified_violation: "The evaluator reproduced the violation",
  not_reproduced: "The evaluator could not reproduce the violation - the rule held",
  inconclusive: "No verdict either way",
  target_crash: "The agent crashed during replay - not a verified violation",
  timeout: "The replay ran out of time - not a verified violation",
  malformed_submission: "The submission was rejected before replay",
  runner_failure: "The evaluator's runner failed - nothing is known about the agent",
  cancelled: "The evaluation was cancelled",
};

export interface VerdictBannerProps {
  bundle: EvidenceBundle;
  /** Extra controls (download, links). */
  actions?: ReactNode;
}

/** The evidence page's first block: outcome, the checker's reason, and the replay count. */
export function VerdictBanner({ bundle, actions }: VerdictBannerProps) {
  const v = bundle.verdict;
  const tone = verdictTone(v.outcome);
  const meta = statusMeta(v.outcome, "evaluation");
  const violated = bundle.replays.filter((r) => r.claimed_rule_violated).length;
  return (
    <section
      aria-labelledby="verdict-heading"
      className={cn("rounded-lg border-2 px-4 py-4 sm:px-5", toneSurface[tone])}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 gap-3">
          <span aria-hidden="true" className="mt-0.5 shrink-0 [&>svg]:size-7">
            <StatusIconGlyph icon={meta.icon} />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide">Verdict: {meta.label}</p>
            <h2 id="verdict-heading" className="mt-0.5 text-lg font-semibold text-fg sm:text-xl">
              {HEADLINE[v.outcome] ?? meta.label}
            </h2>
            {v.summary ? <p className="mt-1 text-sm text-fg">{v.summary}</p> : null}
            <p className="mt-1 text-sm text-fg/90">
              <span className="text-muted">Checker&apos;s reason: </span>
              {v.reason}
            </p>
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 border-t border-current/20 pt-3 text-sm">
        <div className="flex gap-1.5">
          <dt className="text-muted">Claimed rule</dt>
          <dd>{bundle.claimed_rule ? <Mono>{bundle.claimed_rule}</Mono> : <span className="text-subtle">none</span>}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted">Replays violating it</dt>
          <dd className="font-semibold tabular text-fg">
            {violated} of {bundle.replays.length}
            <span className="font-normal text-muted"> (required {bundle.reproducibility.required_violations})</span>
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted">Reward-eligible</dt>
          <dd className="font-medium text-fg">{v.reward_eligible ? "yes" : "no"}</dd>
        </div>
        {v.other_rules_violated.length > 0 ? (
          <div className="flex gap-1.5">
            <dt className="text-muted">Other rules also violated</dt>
            <dd className="flex flex-wrap gap-1">
              {v.other_rules_violated.map((r) => (
                <Mono key={r}>{r}</Mono>
              ))}
            </dd>
          </div>
        ) : null}
        <div className="flex gap-1.5">
          <dt className="text-muted">Evaluation took</dt>
          <dd className="tabular text-fg">{formatDuration(bundle.timing.duration_ms)}</dd>
        </div>
      </dl>
      {v.validation_errors.length > 0 ? (
        <div className="mt-3">
          <p className="text-sm font-semibold text-fg">Validation errors</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-xs text-fg">
            {v.validation_errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
