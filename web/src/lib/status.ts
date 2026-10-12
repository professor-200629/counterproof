/**
 * One place that maps every backend status / outcome to a label, a semantic tone and an
 * icon key. Components (StatusBadge) render from this; pages should never invent their
 * own wording for a status.
 *
 * Tones: ok = observed passing check / not reproduced / confirmed tx;
 *        warn = uncertainty, inconclusive, pending, awaiting - and every evaluation outcome
 *               that is not a verdict about the rule (crash, timeout, malformed, runner failure);
 *        bad = verified violation / failed tx / failed job;
 *        neutral = informational (cancelled, off-chain, refunded).
 */
import type { ChallengeView, EvaluationStatus, RegressionStatus, RunStatus } from "./api";

export type Tone = "ok" | "warn" | "bad" | "neutral" | "accent";

export type StatusIcon =
  | "clock"
  | "activity"
  | "search"
  | "check"
  | "x"
  | "alert"
  | "shield-alert"
  | "shield-check"
  | "help"
  | "ban"
  | "lock"
  | "undo"
  | "file"
  | "pen"
  | "send"
  | "timer"
  | "bug"
  | "dot";

export interface StatusMeta {
  label: string;
  tone: Tone;
  icon: StatusIcon;
  /** One sentence for tooltips / screen readers. */
  description: string;
}

/** Which state machine a status belongs to; resolves words like "failed" or "pending". */
export type StatusDomain = "challenge" | "run" | "candidate" | "evaluation" | "regression" | "job" | "tx" | "onchain";

const BASE: Record<string, StatusMeta> = {
  // challenge
  awaiting_funding: {
    label: "Awaiting funding",
    tone: "warn",
    icon: "clock",
    description: "The reward has not been escrowed on chain yet; challengers cannot run against it.",
  },
  funded: {
    label: "Funded",
    tone: "ok",
    icon: "lock",
    description: "A confirmed transaction escrowed the reward in the contract.",
  },
  settled: {
    label: "Settled - reward credited",
    tone: "ok",
    icon: "check",
    description: "The contract accepted the evaluator's attestation and credited the bound recipient.",
  },
  refunded: {
    label: "Refunded",
    tone: "neutral",
    icon: "undo",
    description: "No eligible settlement before the deadline; the reward returned to the publisher's credit.",
  },
  offchain: {
    label: "Off-chain - evidence only",
    tone: "neutral",
    icon: "file",
    description: "No reward and no settlement: results are evidence bundles only.",
  },

  // run
  queued: { label: "Queued", tone: "warn", icon: "clock", description: "Waiting for a worker; nothing has run yet." },
  running: { label: "Running", tone: "warn", icon: "activity", description: "The search is in progress." },
  candidate_found: {
    label: "Candidate found - unverified",
    tone: "warn",
    icon: "search",
    description: "The challenger's own check flagged a violation. It is not evidence until the evaluator replays it.",
  },
  no_violation_found: {
    label: "No violation found",
    tone: "ok",
    icon: "shield-check",
    description:
      "No sequence tried within the search budget violated a rule. This is not proof the agent is safe.",
  },
  failed: { label: "Failed", tone: "bad", icon: "x", description: "The job failed before producing a result." },
  cancelled: { label: "Cancelled", tone: "neutral", icon: "ban", description: "Cancelled before completion." },

  // candidate
  submitted: {
    label: "Submitted",
    tone: "warn",
    icon: "send",
    description: "Submitted to the evaluator and waiting for an independent replay.",
  },
  replaying: {
    label: "Replaying",
    tone: "warn",
    icon: "activity",
    description: "The evaluator is replaying the sequence in a fresh synthetic marketplace.",
  },

  // evaluation outcomes
  verified_violation: {
    label: "Verified violation",
    tone: "bad",
    icon: "shield-alert",
    description: "The evaluator's independent replays reproduced the rule violation the required number of times.",
  },
  not_reproduced: {
    label: "Not reproduced",
    tone: "ok",
    icon: "shield-check",
    description: "The evaluator replayed the sequence and the claimed rule held.",
  },
  inconclusive: {
    label: "Inconclusive",
    tone: "warn",
    icon: "help",
    description: "Replays disagreed or fell short of the required violations; no verdict either way.",
  },
  target_crash: {
    label: "Target crashed",
    tone: "warn",
    icon: "bug",
    description: "The agent under test crashed during replay; this is not a verified rule violation.",
  },
  timeout: { label: "Timed out", tone: "warn", icon: "timer", description: "The replay exceeded its time limit." },
  malformed_submission: {
    label: "Malformed submission",
    tone: "warn",
    icon: "alert",
    description: "The candidate did not validate against the challenge scope; nothing was replayed.",
  },
  runner_failure: {
    label: "Runner failure",
    tone: "warn",
    icon: "alert",
    description: "The evaluator's runner failed (isolation or integrity problem); no verdict about the agent.",
  },

  // jobs
  done: { label: "Done", tone: "neutral", icon: "check", description: "The job finished." },

  // transactions (backend rows and the wallet state machine)
  idle: { label: "Not sent", tone: "neutral", icon: "dot", description: "No transaction has been requested." },
  awaiting_signature: {
    label: "Awaiting wallet signature",
    tone: "warn",
    icon: "pen",
    description: "Confirm or reject the transaction in your wallet.",
  },
  pending: {
    label: "Pending",
    tone: "warn",
    icon: "clock",
    description: "Sent; waiting for the transaction to be included in a block.",
  },
  confirmed: {
    label: "Confirmed",
    tone: "ok",
    icon: "check",
    description: "Included in a block with a success status. This proves a recorded transaction, not AI correctness.",
  },
  rejected: {
    label: "Rejected in wallet",
    tone: "neutral",
    icon: "ban",
    description: "You rejected the request in your wallet; nothing was sent.",
  },

  // contract view
  none: { label: "Not on chain", tone: "neutral", icon: "dot", description: "The contract has no such challenge." },
};

const DOMAIN_OVERRIDES: Partial<Record<StatusDomain, Record<string, Partial<StatusMeta>>>> = {
  run: {
    failed: { label: "Run failed", description: "The search failed (for example isolation unavailable); no conclusion." },
  },
  candidate: {
    failed: { label: "Evaluation failed", description: "The evaluator could not reach a verdict for this candidate." },
    candidate_found: { label: "Unverified candidate" },
  },
  regression: {
    not_reproduced: {
      label: "Not reproduced on new version",
      description: "The same action sequence replayed against the new version did not violate the rule.",
    },
    verified_violation: {
      label: "Still violates",
      description: "The same action sequence still violates the rule on the new version.",
    },
  },
  job: {
    running: { description: "A worker picked up the job." },
    failed: { label: "Job failed" },
  },
  tx: {
    failed: {
      label: "Transaction failed",
      description: "The transaction reverted or could not be sent. A failed transaction is never shown as confirmed.",
    },
  },
  onchain: {
    funded: { label: "Funded on chain" },
    settled: { label: "Settled on chain" },
    refunded: { label: "Refunded on chain" },
  },
};

/** Meta for any status string. Unknown values render neutrally with the raw text, never crash. */
export function statusMeta(status: string | null | undefined, domain?: StatusDomain): StatusMeta {
  if (!status) {
    return { label: "Unknown", tone: "neutral", icon: "dot", description: "No status reported." };
  }
  const base = BASE[status] ?? {
    label: humanize(status),
    tone: "neutral" as Tone,
    icon: "dot" as StatusIcon,
    description: `Status "${status}" reported by the backend.`,
  };
  const over = domain ? DOMAIN_OVERRIDES[domain]?.[status] : undefined;
  return over ? { ...base, ...over } : base;
}

/** "no_violation_found" -> "No violation found". */
export function humanize(value: string): string {
  const s = value.replace(/[_.-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Every status value the backend documents, by domain (used in tests and docs). */
export const KNOWN_STATUSES = {
  challenge: ["awaiting_funding", "funded", "settled", "refunded", "offchain"],
  run: ["queued", "running", "candidate_found", "no_violation_found", "failed", "cancelled"],
  candidate: [
    "candidate_found",
    "submitted",
    "replaying",
    "verified_violation",
    "not_reproduced",
    "inconclusive",
    "failed",
    "cancelled",
  ],
  evaluation: [
    "queued",
    "replaying",
    "verified_violation",
    "not_reproduced",
    "inconclusive",
    "target_crash",
    "timeout",
    "malformed_submission",
    "runner_failure",
    "cancelled",
  ],
  job: ["queued", "running", "done", "failed", "cancelled"],
  tx: ["idle", "awaiting_signature", "pending", "confirmed", "failed", "rejected"],
  onchain: ["none", "funded", "settled", "refunded"],
} as const satisfies Partial<Record<StatusDomain, readonly string[]>>;

// ---------------------------------------------------------------------------- activity predicates
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "running"];
export const ACTIVE_EVALUATION_STATUSES: readonly EvaluationStatus[] = ["queued", "replaying"];
export const ACTIVE_CANDIDATE_STATUSES: readonly string[] = ["submitted", "replaying"];
export const ACTIVE_REGRESSION_STATUSES: readonly RegressionStatus[] = ["queued", "replaying"];

export function isRunActive(status: string | null | undefined): boolean {
  return !!status && (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

export function isEvaluationActive(status: string | null | undefined): boolean {
  return !!status && (ACTIVE_EVALUATION_STATUSES as readonly string[]).includes(status);
}

/** A background job that is still queued or running (e.g. a request to the evaluator's signer). */
export function isJobActive(job: { status: string } | null | undefined): boolean {
  return !!job && (job.status === "queued" || job.status === "running");
}

export function isRegressionActive(status: string | null | undefined): boolean {
  return !!status && ((ACTIVE_REGRESSION_STATUSES as readonly string[]).includes(status) || status === "running");
}

/** True while any run, evaluation or submitted candidate of the challenge is still moving. */
export function isChallengeActive(view: Pick<ChallengeView, "runs" | "evaluations" | "candidates"> | null | undefined): boolean {
  if (!view) return false;
  return (
    view.runs.some((r) => isRunActive(r.status)) ||
    view.evaluations.some((e) => isEvaluationActive(e.status)) ||
    view.candidates.some((c) => ACTIVE_CANDIDATE_STATUSES.includes(c.status))
  );
}
