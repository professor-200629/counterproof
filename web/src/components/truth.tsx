/**
 * Components that state what results do and do not mean. Pages use these instead of
 * writing their own wording, so the truth rules read the same everywhere.
 */
import { FileWarning, Info, MessageSquareQuote, ShieldQuestion } from "lucide-react";
import type { ReactNode } from "react";
import { Callout } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { KeyValueList } from "@/components/ui/stat";
import type { ChallengeSpec, RunBudget, RunRecord } from "@/lib/api";
import { ATTESTATION_MEANING, RECEIPT_MEANING } from "@/lib/chain";
import { cn } from "@/lib/cn";
import { formatDuration, formatNumber, plural } from "@/lib/format";

export const AGENT_CLAIM_LABEL = "Agent's own claim - not used as evidence";
export const LOCAL_CHECK_NOTE = "Challenger-side self-check only. Not evidence until the evaluator replays it.";
export const SEARCH_SELF_CHECK_NOTE =
  "Challenger-side search and self-check only: the evaluator did not replay these sequences, so this is not an evaluator result.";
export const NOT_PROOF_OF_SAFETY = "A passing test is not proof the agent is safe.";
export const LLM_NEVER_DECIDES = "Language-model output never decides a payout; the deterministic checker does.";

/** The agent's self-reports from an evidence replay, clearly marked as non-evidence. */
export function AgentClaims({ claims, className }: { claims: string[] | null | undefined; className?: string }) {
  if (!claims || claims.length === 0) return null;
  return (
    <div className={cn("rounded-md border border-dashed border-line bg-raised/40 p-3", className)}>
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted">
        <MessageSquareQuote aria-hidden="true" className="size-3.5" />
        {AGENT_CLAIM_LABEL}
      </p>
      <ul className="mt-2 space-y-1 text-sm text-muted">
        {claims.map((c, i) => (
          <li key={i} className="before:mr-1.5 before:text-subtle before:content-['>']">
            <q className="italic">{c}</q>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Limitations from an evidence bundle (always shown with a result). */
export function Limitations({ items, title = "Limitations", className }: { items: string[] | null | undefined; title?: string; className?: string }) {
  if (!items || items.length === 0) return null;
  return (
    <Callout tone="neutral" icon={<FileWarning />} title={title} className={className}>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </Callout>
  );
}

/** One-line standing statements. */
export function TrustStatement({ kind, className }: { kind: "attestation" | "receipt" | "llm" | "not-proof"; className?: string }) {
  const text: Record<typeof kind, ReactNode> = {
    attestation: ATTESTATION_MEANING,
    receipt: RECEIPT_MEANING,
    llm: LLM_NEVER_DECIDES,
    "not-proof": NOT_PROOF_OF_SAFETY,
  };
  return (
    <p className={cn("flex items-start gap-1.5 text-xs text-muted", className)}>
      <Info aria-hidden="true" className="mt-px size-3.5 shrink-0 text-subtle" />
      <span>{text[kind]}</span>
    </p>
  );
}

/**
 * What a challenger-side search did not cover, from the spec it ran against. Shown with every
 * "No violation found" so the result is never read as an evaluator verdict or a safety proof.
 */
export function searchLimitations(spec: Pick<ChallengeSpec, "target" | "environment" | "initial_state" | "initial_state_digest">): string[] {
  const { target, environment } = spec;
  const out = [
    "Challenger-side search with the challenger tool's own rule check. Nothing here was replayed by the declared evaluator.",
    `Ran in the synthetic marketplace ${environment.market.name}@${environment.market.version} (invented merchants and products), not a real store.`,
    `Only ${target.adapter}@${target.version} was tested, from one initial state (${spec.initial_state.world_id}, ${spec.initial_state_digest}). Other versions and starting states were not.`,
    `Each sequence ran under ${environment.isolation} isolation, as the spec requires.`,
  ];
  if (target.determinism === "stochastic") {
    out.push("The target is stochastic (live model): the same sequences can behave differently on another run.");
  }
  return out;
}

const OUTCOME_WORDS: Record<string, string> = {
  completed: "ran to completion",
  target_crash: "ended in a target crash",
  timeout: "timed out",
  runner_failure: "runner failure (not counted as tried)",
};

/** "12 ran to completion, 1 timed out" from a run's run_outcomes counts. */
export function runOutcomeBreakdown(outcomes: Record<string, number> | null | undefined): string {
  const entries = Object.entries(outcomes ?? {}).filter(([, n]) => n > 0);
  if (entries.length === 0) return "not reported";
  return entries.map(([k, n]) => `${formatNumber(n)} ${OUTCOME_WORDS[k] ?? k.replace(/_/g, " ")}`).join(", ");
}

export interface NoViolationFactsProps {
  /** Tested target. */
  target: { adapter: string; version: string; artifact_digest?: string | null };
  /** Rules that were in scope. */
  rules: { id: string; statement: string }[];
  /** The finished run's record (sequences_tried, termination, ...). */
  record: RunRecord;
  /** Budget, if not in the record. */
  budget?: RunBudget | null;
  strategy?: string;
  /** Extra limitations (e.g. from the evidence bundle). */
  limitations?: string[];
  className?: string;
}

/**
 * Everything "No violation found" must show: who checked (the challenger's own check),
 * tested version, rules, sequences tried and how each ended, search budget, why the search
 * stopped, and what the result does not mean.
 */
export function NoViolationFacts({ target, rules, record, budget, strategy, limitations, className }: NoViolationFactsProps) {
  const b = budget ?? record.budget;
  const outcomes = record.run_outcomes ?? {};
  const reported = Object.keys(outcomes).length > 0;
  const completed = outcomes.completed ?? 0;
  const crashed = outcomes.target_crash ?? 0;
  const timedOut = outcomes.timeout ?? 0;
  const tried = record.sequences_tried;
  return (
    <div className={cn("space-y-3", className)}>
      <Callout tone="neutral" icon={<ShieldQuestion />} title={`No violation found in this search - ${NOT_PROOF_OF_SAFETY.toLowerCase()}`}>
        <p className="font-medium">{SEARCH_SELF_CHECK_NOTE}</p>
        <p className="mt-1">
          Within the budget below, {strategy ?? record.strategy} tried {formatNumber(tried)} action {plural(tried, "sequence")}
          {reported ? (
            <>
              ; none of the {formatNumber(completed)} that ran to completion violated a rule.
              {crashed + timedOut > 0 ? (
                <>
                  {" "}
                  {crashed > 0 ? `${formatNumber(crashed)} ended in a target crash` : null}
                  {crashed > 0 && timedOut > 0 ? " and " : null}
                  {timedOut > 0 ? `${formatNumber(timedOut)} timed out` : null} before finishing; for those, only the ledger events
                  before the stop were checked.
                </>
              ) : null}
            </>
          ) : (
            <>; the self-check flagged no rule. The run did not report how each sequence ended.</>
          )}{" "}
          Other sequences, versions, starting states and rules were not tested.
        </p>
      </Callout>
      <KeyValueList
        items={[
          {
            key: "version",
            label: "Tested version",
            value: (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">
                  {target.adapter}@{target.version}
                </span>
                {target.artifact_digest ? <Digest value={target.artifact_digest} label="target artifact digest" /> : null}
              </span>
            ),
          },
          {
            key: "rules",
            label: "Rules checked",
            value: (
              <ul className="space-y-0.5">
                {rules.map((r) => (
                  <li key={r.id}>
                    <span className="font-mono text-xs text-muted">{r.id}</span> {r.statement}
                  </li>
                ))}
              </ul>
            ),
          },
          { key: "tried", label: "Sequences tried", value: <span className="tabular">{formatNumber(record.sequences_tried)}</span> },
          { key: "ended", label: "How they ended", value: <span className="tabular">{runOutcomeBreakdown(record.run_outcomes)}</span> },
          { key: "checked", label: "Checked by", value: "the challenger tool's own rule check (not the evaluator)" },
          {
            key: "budget",
            label: "Search budget",
            value: (
              <span className="tabular">
                {formatNumber(b.max_sequences)} sequences / {formatNumber(b.max_wall_seconds)} s
                {b.max_model_calls ? `, ${formatNumber(b.max_model_calls)} model calls` : ""}
              </span>
            ),
          },
          { key: "stop", label: "Why it stopped", value: record.termination || "not reported" },
          {
            key: "work",
            label: "Work done",
            value: (
              <span className="tabular">
                {formatNumber(record.tool_calls)} tool calls, {formatDuration(record.duration_ms)}
                {record.model_calls ? `, ${formatNumber(record.model_calls)} model calls` : ""}
              </span>
            ),
          },
        ]}
      />
      <Limitations items={limitations} />
    </div>
  );
}
