/**
 * Pure helpers for the settlement page: pick the evaluation being settled, find recorded
 * transactions, and work out what the next step is. Everything here reads backend / chain
 * values; nothing is estimated.
 */
import {
  finishedSummary,
  type ActivityEntry,
  type AttestationRow,
  type ChainTransaction,
  type ChainTxKind,
  type ChallengeView,
  type Digest,
  type Evaluation,
  type Job,
  type JsonValue,
  type OnchainChallenge,
  type Settlement,
  type SettlementAttestation,
  type SignerVerification,
} from "@/lib/api";
import { sameHex } from "@/lib/format";
import { isJobActive } from "@/lib/status";

/** The backend renews an attestation only once it has less than this left (chain.ATTESTATION_MARGIN). */
export const RENEW_MARGIN_S = 300;

/** Recorded transactions of one kind, newest first. */
export function txsOfKind(txs: ChainTransaction[], kind: ChainTxKind): ChainTransaction[] {
  return txs
    .filter((t) => t.kind === kind)
    .sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at);
}

export function confirmedTx(txs: ChainTransaction[], kind: ChainTxKind): ChainTransaction | null {
  return txsOfKind(txs, kind).find((t) => t.status === "confirmed") ?? null;
}

/** A string field of a transaction's backend-verified `detail`, or null. */
export function detailString(tx: ChainTransaction | null | undefined, key: string): string | null {
  const v: JsonValue | undefined = tx?.detail?.[key];
  return typeof v === "string" && v ? v : null;
}

/** Same address, ignoring checksum case; false when either is missing (see sameHex for the three-way form). */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return sameHex(a, b) === true;
}

/** The attestation as the settlement endpoint returns it, or the challenge view's row. */
export function currentAttestation(settlement: Settlement, view: ChallengeView): SettlementAttestation | null {
  if (settlement.attestation) return settlement.attestation;
  const row: AttestationRow | null = view.attestation;
  if (!row) return null;
  return {
    typed_data: row.typed_data,
    signature: row.signature,
    signer: row.signer,
    expiry: row.expiry,
    evaluation_id: row.evaluation_id,
    id: row.id,
    evidence_digest: row.evidence_digest ?? null,
    verification: row.verification ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
  };
}

/**
 * What the attested `evidenceDigest` should be compared with. Attestations from the current
 * signer carry the digest of the signer's OWN verification bundle (its fresh replays of the
 * committed candidate); older ones (e.g. the recorded testnet run) signed the worker's
 * evaluation digest, so they are compared with that.
 */
export function attestedEvidence(
  attestation: Pick<SettlementAttestation, "evidence_digest"> | null | undefined,
  evaluationDigest: Digest | null | undefined,
): { digest: Digest | null; source: "signer" | "evaluation" } {
  if (attestation?.evidence_digest) return { digest: attestation.evidence_digest, source: "signer" };
  return { digest: evaluationDigest ?? null, source: "evaluation" };
}

/** "2 of 3 fresh replays by the signer violated the rule (2 required)". */
export function verificationSummary(v: SignerVerification | null | undefined): string | null {
  if (!v || v.replays == null) return null;
  const kind = v.mode === "stochastic" ? "fresh live-model" : "fresh";
  if (v.status === "verifying") {
    return `the signer is running ${v.replays} ${kind} replay${v.replays === 1 ? "" : "s"} of its own${
      v.replays_done ? ` (${v.replays_done} done)` : ""
    }; at least ${v.required ?? "?"} must violate the rule`;
  }
  if (v.violated == null) return null;
  return `${v.violated} of ${v.replays} ${kind} replay${v.replays === 1 ? "" : "s"} by the signer violated the rule (${v.required ?? "?"} required)`;
}

/** True while an attestation job is queued or running (the signer may be replaying). */
export function isAttestationJobActive(job: Job | null | undefined): boolean {
  return isJobActive(job);
}

/** What the latest attestation job last heard from the signer (the job records it as it polls). */
export function attestationJobOutcome(job: Job | null | undefined): {
  status: string | null;
  verification: SignerVerification | null;
  detail: string | null;
} {
  const r = (job?.result ?? null) as Record<string, unknown> | null;
  const status = r && typeof r.status === "string" ? r.status : null;
  const verification = r && r.verification && typeof r.verification === "object" ? (r.verification as unknown as SignerVerification) : null;
  const refused = r && Array.isArray(r.refused) ? (r.refused as unknown[]).map(String).join("; ") : null;
  const detail = refused || (r && typeof r.detail === "string" ? r.detail : null);
  return { status, verification, detail };
}

/**
 * An expired (or nearly expired) attestation can be renewed while the challenge is still
 * funded and its settlement deadline has not passed: the signer re-signs the same message
 * with a later expiry, capped at the deadline (so one already ending at the deadline cannot
 * be extended).
 */
export function canRenewAttestation(
  view: Pick<ChallengeView, "status" | "spec">,
  attestation: Pick<SettlementAttestation, "expiry"> | null,
  onchain: Pick<OnchainChallenge, "status" | "settlement_deadline"> | null,
  nowSec: number | null,
): boolean {
  if (!attestation || nowSec === null || view.status !== "funded") return false;
  if (onchain && onchain.status !== "funded") return false;
  const deadline = onchain?.settlement_deadline ?? view.spec.deadlines.settlement_deadline;
  return nowSec <= deadline && attestation.expiry < deadline && attestation.expiry - nowSec <= RENEW_MARGIN_S;
}

/**
 * The evaluation this settlement is about: the attested one if there is an attestation,
 * otherwise the latest committed verified violation, otherwise the latest committed
 * evaluation, otherwise the latest evaluation of any kind.
 */
export function pickSettlementEvaluation(view: ChallengeView, attestation: SettlementAttestation | null): Evaluation | null {
  const evs = [...view.evaluations].sort((a, b) => b.created_at - a.created_at);
  if (attestation) {
    const attested = evs.find((e) => e.id === attestation.evaluation_id);
    if (attested) return attested;
  }
  return (
    evs.find((e) => e.outcome === "verified_violation" && e.source === "chain") ??
    evs.find((e) => e.source === "chain") ??
    evs[0] ??
    null
  );
}

/** Commit transaction recorded for a submission (kind "commit"), if any. */
export function commitTxFor(view: ChallengeView, evaluation: Evaluation | null): ChainTransaction | null {
  if (!evaluation) return null;
  const commits = txsOfKind(view.transactions, "commit");
  return (
    commits.find((t) => sameHex(t.hash, evaluation.commit_tx) === true) ??
    commits.find((t) => sameHex(detailString(t, "submission_id"), evaluation.submission_id) === true) ??
    null
  );
}

/** True when the evaluation's verdict can be attested for a reward. */
export function isPayableVerdict(evaluation: Evaluation | null): boolean {
  const s = finishedSummary(evaluation);
  return !!s && s.outcome === "verified_violation" && s.reward_eligible;
}

const SETTLEMENT_ACTIVITY = ["challenge.", "fund.", "commit.", "submission.", "attestation.", "settle.", "refund.", "withdraw."];

/** Activity entries about funding, commitment, attestation and payouts (including wallet rejections). */
export function settlementActivity(entries: ActivityEntry[]): ActivityEntry[] {
  return entries.filter((e) => SETTLEMENT_ACTIVITY.some((p) => e.kind.startsWith(p)));
}

const ATTESTATION_NOTES = ["attestation.pending", "attestation.refused", "attestation.failed"];

/** Latest backend note about an attestation that could not be obtained (pending, refused or failed). */
export function latestAttestationNote(entries: ActivityEntry[], evaluationId: string | undefined): ActivityEntry | null {
  return (
    [...entries]
      .filter((e) => ATTESTATION_NOTES.includes(e.kind) && (!evaluationId || e.ref === evaluationId))
      .sort((a, b) => b.created_at - a.created_at || b.id - a.id)[0] ?? null
  );
}

/**
 * Wallet attempts that never executed the call (rejections, send errors, cancelled in the
 * wallet) for these kinds: the backend logs them as "<kind> not sent: ...". Its other
 * "<kind>.failed" entries are mined-and-reverted transactions, which the recorded
 * transaction list already shows with their block.
 */
export function failedAttempts(entries: ActivityEntry[], kinds: readonly string[]): ActivityEntry[] {
  return entries
    .filter((e) => kinds.some((k) => e.kind === `${k}.failed` && e.message.startsWith(`${k} not sent:`)))
    .sort((a, b) => b.created_at - a.created_at || b.id - a.id);
}
