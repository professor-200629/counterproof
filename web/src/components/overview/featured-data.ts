/**
 * Pure derivations for the overview's featured finding and its counts. Everything comes from
 * recorded API responses (challenge list, challenge view, evidence bundle, regressions,
 * /api/erc8004); nothing is estimated or invented, and a missing value stays missing.
 */
import {
  finishedSummary,
  type CandidateAction,
  type ChallengeListItem,
  type ChallengeView,
  type Erc8004Feedback,
  type Erc8004Record,
  type Evaluation,
  type EvidenceBundle,
  type JsonObject,
  type Product,
  type Regression,
  type SpecRule,
} from "@/lib/api";
import { sameHex } from "@/lib/format";
import { isLiveModelLabel, isPlantedFixtureLabel, replayRelation } from "@/lib/target-labels";
import { privilegedAttempts, refusedCalls, type RefusedCall } from "@/components/compare/ledger-facts";
import { sortNewest } from "./shared";

// ---------------------------------------------------------------------------- which finding
export interface FeaturedPick {
  item: ChallengeListItem;
  /** True when the target is a live-model agent; false for the fallback (any verified violation). */
  liveModel: boolean;
}

/**
 * The finding the overview leads with: the most recent challenge against a live-model agent
 * with a verified violation; otherwise the most recent challenge with any verified violation
 * (then its fixture label stays prominent); otherwise none.
 */
export function pickFeaturedChallenge(items: ChallengeListItem[] | null | undefined): FeaturedPick | null {
  const sorted = sortNewest(items ?? []);
  const live = sorted.find((c) => isLiveModelLabel(c.target.label) && c.counts.verified > 0);
  if (live) return { item: live, liveModel: true };
  const any = sorted.find((c) => c.counts.verified > 0);
  return any ? { item: any, liveModel: false } : null;
}

/** The verified-violation evaluation to show: the attested one if any, else the newest. */
export function pickFeaturedEvaluation(view: Pick<ChallengeView, "evaluations" | "attestation">): Evaluation | null {
  const verified = view.evaluations
    .filter((e) => e.outcome === "verified_violation")
    .sort((a, b) => (b.finished_at ?? b.created_at) - (a.finished_at ?? a.created_at));
  const attestedId = view.attestation?.evaluation_id;
  return (attestedId ? verified.find((e) => e.id === attestedId) : undefined) ?? verified[0] ?? null;
}

// ---------------------------------------------------------------------------- injected text
export interface InjectedText {
  sku: string | null;
  /** Merchant id that sells the SKU in the spec's synthetic initial state. */
  merchant: string | null;
  text: string;
}

/** Merchant text the counterexample injected (its merchant_content actions), in order. */
export function injectedContent(actions: CandidateAction[] | null | undefined, products?: Product[] | null): InjectedText[] {
  const bySku = new Map((products ?? []).map((p) => [p.sku, p]));
  return (actions ?? [])
    .filter((a) => a.type === "merchant_content" && typeof a.text === "string")
    .map((a) => {
      const sku = typeof a.sku === "string" ? a.sku : null;
      return { sku, merchant: (sku && bySku.get(sku)?.merchant) || null, text: a.text as string };
    });
}

/** The first `max` characters on a word boundary, and whether anything was cut. */
export function truncateText(text: string, max = 120): { head: string; cut: boolean } {
  if (text.length <= max) return { head: text, cut: false };
  const slice = text.slice(0, max);
  const space = slice.lastIndexOf(" ");
  return { head: (space > max * 0.6 ? slice.slice(0, space) : slice).trimEnd(), cut: true };
}

// ---------------------------------------------------------------------------- attempts
export interface AttemptSummary {
  tool: string;
  args: JsonObject;
  /** Replays whose ledger records an attempt of this tool. */
  replaysWithAttempt: number;
  /** Replays whose trace shows the market refusing a call of this tool. */
  replaysRefused: number;
  /** The first recorded refusal (error code and message from the market). */
  refusal: RefusedCall | null;
  /** Other privileged tools attempted in any replay. */
  otherTools: string[];
  replays: number;
}

/**
 * What the agent attempted, from the evaluator's ledgers (privileged.attempt events for the
 * rule's tools) and whether the market refused it (the tool-call trace). The headline attempt
 * is the first one in the first violating replay.
 */
export function attemptSummary(
  bundle: Pick<EvidenceBundle, "replays">,
  rule: Pick<SpecRule, "template" | "params"> | null,
): AttemptSummary | null {
  if (rule?.template !== "agent.no_privileged_calls") return null;
  const ordered = [...bundle.replays].sort((a, b) => Number(b.claimed_rule_violated) - Number(a.claimed_rule_violated) || a.index - b.index);
  const first = ordered.map((r) => privilegedAttempts(r.ledger, rule)[0]).find(Boolean);
  if (!first) return null;
  const tool = typeof first.data.tool === "string" ? first.data.tool : "?";
  const args = first.data.args && typeof first.data.args === "object" && !Array.isArray(first.data.args) ? (first.data.args as JsonObject) : {};
  let withAttempt = 0;
  let refused = 0;
  let refusal: RefusedCall | null = null;
  const others = new Set<string>();
  for (const r of bundle.replays) {
    const attempts = privilegedAttempts(r.ledger, rule);
    if (attempts.some((e) => e.data.tool === tool)) withAttempt++;
    for (const e of attempts) if (typeof e.data.tool === "string" && e.data.tool !== tool) others.add(e.data.tool);
    const calls = refusedCalls(r, tool);
    if (calls.length > 0) {
      refused++;
      refusal = refusal ?? calls[0];
    }
  }
  return { tool, args, replaysWithAttempt: withAttempt, replaysRefused: refused, refusal, otherTools: [...others], replays: bundle.replays.length };
}

// ---------------------------------------------------------------------------- repair
/**
 * Regression replays of this challenge on the SAME agent family (adapter), other versions
 * only, newest first; those of `candidateId` come first. A replay against another adapter is
 * a different agent, never this agent's repair.
 */
export function sameFamilyRegressions(
  regs: Regression[] | null | undefined,
  view: Pick<ChallengeView, "id" | "spec">,
  candidateId?: string | null,
): Regression[] {
  return (regs ?? [])
    .filter((r) => r.source_challenge_id === view.id && replayRelation(r.target_key, view.spec.target) === "repair")
    .sort(
      (a, b) =>
        Number(b.source_candidate_id === candidateId) - Number(a.source_candidate_id === candidateId) || b.created_at - a.created_at,
    );
}

// ---------------------------------------------------------------------------- ERC-8004
/** The ERC-8004 feedback posted for this finding: same evidence digest, else same on-chain challenge and target. */
export function feedbackFor(
  record: Erc8004Record | null | undefined,
  evidenceDigest: string | null | undefined,
  onchainId: string | null | undefined,
  targetKey: string,
): Erc8004Feedback | null {
  const list = record?.available ? (record.feedback ?? []) : [];
  return (
    (evidenceDigest ? list.find((f) => sameHex(f.evidence_digest, evidenceDigest) === true) : undefined) ??
    (onchainId ? list.find((f) => String(f.challenge_onchain_id) === onchainId && f.target === targetKey) : undefined) ??
    null
  );
}

// ---------------------------------------------------------------------------- counts
export interface VerifiedSplit {
  liveModel: number;
  plantedFixture: number;
  other: number;
  /** Sum over the listed challenges (may be below the overview's total when the list is partial). */
  listed: number;
}

/** Verified-violation evaluations of the listed challenges, by kind of target. */
export function verifiedSplit(items: ChallengeListItem[] | null | undefined): VerifiedSplit {
  const out: VerifiedSplit = { liveModel: 0, plantedFixture: 0, other: 0, listed: 0 };
  for (const c of items ?? []) {
    const n = c.counts.verified;
    if (!n) continue;
    out.listed += n;
    if (isLiveModelLabel(c.target.label)) out.liveModel += n;
    else if (isPlantedFixtureLabel(c.target.label)) out.plantedFixture += n;
    else out.other += n;
  }
  return out;
}

/** Listed challenges that were ever funded (a funding transaction is recorded), whatever their status now. */
export function everFunded(items: ChallengeListItem[] | null | undefined): number {
  return (items ?? []).filter((c) => !!c.fund_tx).length;
}

/** Violated / total replays of an evaluation's summary, or null before a verdict. */
export function replayTally(evaluation: Evaluation | null | undefined): { violated: number; total: number } | null {
  const s = finishedSummary(evaluation);
  if (!s) return null;
  return { violated: s.replays.filter((r) => r.claimed_rule_violated).length, total: s.replays.length };
}
