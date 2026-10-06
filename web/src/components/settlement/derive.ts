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
  type Evaluation,
  type JsonValue,
  type Settlement,
  type SettlementAttestation,
} from "@/lib/api";
import { sameHex } from "@/lib/format";

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
  };
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

/** Latest backend note about an attestation that could not be obtained yet. */
export function latestAttestationNote(entries: ActivityEntry[], evaluationId: string | undefined): ActivityEntry | null {
  return (
    [...entries]
      .filter((e) => e.kind === "attestation.pending" && (!evaluationId || e.ref === evaluationId))
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
