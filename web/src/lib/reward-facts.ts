/**
 * Which recorded transactions paid a given finding. Pure lookups over the backend's
 * receipt-verified transaction rows (ChallengeView.transactions); nothing is estimated.
 */
import type { ChainTransaction, JsonValue } from "./api";
import { sameHex } from "./format";

function detailText(tx: ChainTransaction | null | undefined, key: string): string | null {
  const v: JsonValue | undefined = tx?.detail?.[key];
  return typeof v === "string" && v ? v : null;
}

/** The confirmed settle transaction whose ChallengeSettled event names this evidence digest. */
export function settleTxForEvidence(txs: ChainTransaction[], evidenceDigest: string | null | undefined): ChainTransaction | null {
  if (!evidenceDigest) return null;
  return (
    txs.find(
      (t) => t.kind === "settle" && t.status === "confirmed" && sameHex(detailText(t, "evidence_digest"), evidenceDigest) === true,
    ) ?? null
  );
}

/** The recipient a settle transaction credited (from its verified event), or null. */
export function settledRecipient(settle: ChainTransaction | null | undefined): string | null {
  return detailText(settle, "recipient");
}

/** The reward a settle transaction credited, in wei (decimal string), or null. */
export function settledRewardWei(settle: ChainTransaction | null | undefined): string | null {
  return detailText(settle, "reward_wei");
}

/**
 * A confirmed withdrawal by `recipient` at or after the settlement's block. withdraw() pays
 * out the account's whole credit, so it includes the settled reward; it is the moment the
 * reward left the contract.
 */
export function withdrawalAfterSettle(
  txs: ChainTransaction[],
  settle: ChainTransaction | null | undefined,
  recipient: string | null | undefined,
): ChainTransaction | null {
  if (!settle || !recipient) return null;
  return (
    txs
      .filter((t) => t.kind === "withdraw" && t.status === "confirmed")
      .sort((a, b) => (a.block_number ?? 0) - (b.block_number ?? 0) || a.created_at - b.created_at)
      .find(
        (t) =>
          sameHex(detailText(t, "account") ?? t.from_addr, recipient) === true &&
          (settle.block_number == null || t.block_number == null || t.block_number >= settle.block_number),
      ) ?? null
  );
}

/** The amount a withdrawal paid out, in wei (decimal string), or null. */
export function withdrawnWei(withdraw: ChainTransaction | null | undefined): string | null {
  return detailText(withdraw, "amount_wei");
}
