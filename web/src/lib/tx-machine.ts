/**
 * Pure wallet-transaction state machine (no React, no wagmi - unit tested).
 *
 *   idle -> awaiting_signature -> pending(hash) -> confirmed(hash, block)
 *                              |                -> pending(newHash)          (repriced / sped up in the wallet)
 *                              |                -> failed(hash, reverted | receipt_unknown | cancelled | replaced)
 *                              -> rejected(reason)                          (user said no in the wallet)
 *                              -> failed(not_sent)                          (could not send: no hash)
 *
 * `failed.failure` says *why* it failed, so callers never have to parse the reason text.
 *
 * Invariants:
 * - Only a receipt with status "success" for the *same* hash produces `confirmed`.
 * - `failed` and `rejected` are terminal until RESET / a new REQUEST_SIGNATURE; a late
 *   success receipt can never turn a failed transaction into a confirmed one.
 * - User rejection is kept apart from reverts and send errors.
 */
import type { Hex } from "viem";

/**
 * Why a transaction failed:
 * - not_sent        the wallet / RPC refused before a hash existed
 * - reverted        mined, receipt status "reverted" (nothing the call did happened)
 * - receipt_unknown a hash exists but no receipt could be read; it may still be mined
 * - cancelled       the wallet replaced it with a 0-value self-transfer on the same nonce
 * - replaced        the wallet replaced it with a different transaction on the same nonce
 */
export type TxFailure = "not_sent" | "reverted" | "receipt_unknown" | "cancelled" | "replaced";

export type TxState =
  | { status: "idle" }
  | { status: "awaiting_signature" }
  | { status: "pending"; hash: Hex }
  | { status: "confirmed"; hash: Hex; block: bigint }
  | { status: "failed"; hash?: Hex; reason: string; failure: TxFailure; replacedBy?: Hex }
  | { status: "rejected"; reason: string };

export type TxStatus = TxState["status"];

export type TxEvent =
  /** The UI asked the wallet to sign. Allowed from idle and from any terminal state (retry). */
  | { type: "REQUEST_SIGNATURE" }
  /** The wallet returned a transaction hash. */
  | { type: "SUBMITTED"; hash: Hex }
  /** The user rejected the request in the wallet. */
  | { type: "USER_REJECTED"; reason?: string }
  /** The request failed before a hash existed (simulation revert, RPC error, wrong chain...). */
  | { type: "SEND_FAILED"; reason: string }
  /** A receipt for `hash` was read from the chain. */
  | { type: "RECEIPT"; hash: Hex; status: "success" | "reverted"; block: bigint }
  /** Waiting for the receipt failed (timeout, dropped, RPC error). */
  | { type: "RECEIPT_ERROR"; hash: Hex; reason: string }
  /** The wallet replaced the pending transaction (same nonce) with `newHash`. */
  | { type: "REPLACED"; hash: Hex; newHash: Hex; reason: "repriced" | "cancelled" | "replaced" }
  | { type: "RESET" };

export const initialTxState: TxState = { status: "idle" };

const TERMINAL: readonly TxStatus[] = ["confirmed", "failed", "rejected"];

export function isTerminal(state: TxState): boolean {
  return TERMINAL.includes(state.status);
}

/** True only for a mined, successful receipt. */
export function isConfirmed(state: TxState): state is Extract<TxState, { status: "confirmed" }> {
  return state.status === "confirmed";
}

/** True while the user must wait (signature or inclusion). */
export function isBusy(state: TxState): boolean {
  return state.status === "awaiting_signature" || state.status === "pending";
}

/**
 * True when sending the same call again cannot double-execute it: nothing was sent, the user
 * rejected, or our transaction is known not to have taken effect (reverted, or replaced /
 * cancelled in the wallet). False while one is in flight or its receipt is unknown.
 */
export function canSendAgain(state: TxState): boolean {
  if (state.status === "idle" || state.status === "rejected") return true;
  return state.status === "failed" && state.failure !== "receipt_unknown";
}

/** The transaction hash if one exists in this state. */
export function txHash(state: TxState): Hex | undefined {
  return "hash" in state ? state.hash : undefined;
}

export function txReducer(state: TxState, event: TxEvent): TxState {
  switch (event.type) {
    case "RESET":
      return initialTxState;

    case "REQUEST_SIGNATURE":
      // Never start a second transaction while one is in flight.
      return state.status === "idle" || isTerminal(state) ? { status: "awaiting_signature" } : state;

    case "SUBMITTED":
      return state.status === "awaiting_signature" ? { status: "pending", hash: event.hash } : state;

    case "USER_REJECTED":
      return state.status === "awaiting_signature"
        ? { status: "rejected", reason: event.reason || "Rejected in the wallet. Nothing was sent." }
        : state;

    case "SEND_FAILED":
      return state.status === "awaiting_signature" ? { status: "failed", reason: event.reason, failure: "not_sent" } : state;

    case "RECEIPT":
      if (state.status !== "pending" || !sameHash(state.hash, event.hash)) return state;
      return event.status === "success"
        ? { status: "confirmed", hash: state.hash, block: event.block }
        : {
            status: "failed",
            hash: state.hash,
            failure: "reverted",
            reason: `Transaction reverted in block ${event.block.toString()}.`,
          };

    case "RECEIPT_ERROR":
      if (state.status !== "pending" || !sameHash(state.hash, event.hash)) return state;
      return {
        status: "failed",
        hash: state.hash,
        failure: "receipt_unknown",
        reason: `No receipt could be read: ${event.reason}. The transaction may still be mined; check the hash before retrying.`,
      };

    case "REPLACED":
      if (state.status !== "pending" || !sameHash(state.hash, event.hash)) return state;
      if (event.reason === "repriced") return { status: "pending", hash: event.newHash };
      return event.reason === "cancelled"
        ? {
            status: "failed",
            hash: state.hash,
            replacedBy: event.newHash,
            failure: "cancelled",
            reason: `Cancelled in the wallet: a 0-value replacement (${event.newHash}) took its nonce, so the contract was never called.`,
          }
        : {
            status: "failed",
            hash: state.hash,
            replacedBy: event.newHash,
            failure: "replaced",
            reason: `Replaced in the wallet by a different transaction (${event.newHash}); this call was never executed.`,
          };

    default:
      return state;
  }
}

function sameHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------------------- receipt -> events
/** The parts of a viem TransactionReceipt the state machine needs. */
export interface ReceiptLike {
  transactionHash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
}

/** What waiting for a receipt produced (viem's waitForTransactionReceipt, which returns reverted receipts). */
export type ReceiptOutcome =
  | {
      kind: "receipt";
      receipt: ReceiptLike;
      /** Set when viem's onReplaced fired: the receipt then belongs to the replacement. */
      replacement?: { reason: "repriced" | "cancelled" | "replaced"; transactionHash: Hex };
    }
  | { kind: "error"; error: unknown };

/**
 * Pure mapping from a receipt outcome to state-machine events, plus the hash whose receipt
 * the backend should verify (null when no transaction of ours was mined).
 */
export function receiptEvents(pendingHash: Hex, outcome: ReceiptOutcome): { events: TxEvent[]; reportHash: Hex | null } {
  if (outcome.kind === "error") {
    return { events: [{ type: "RECEIPT_ERROR", hash: pendingHash, reason: errorReason(outcome.error) }], reportHash: pendingHash };
  }
  const { receipt, replacement } = outcome;
  const mined = receipt.transactionHash;
  const receiptEvent: TxEvent = { type: "RECEIPT", hash: mined, status: receipt.status, block: receipt.blockNumber };
  if (replacement || !sameHash(mined, pendingHash)) {
    const reason = replacement?.reason ?? "replaced";
    const newHash = replacement?.transactionHash ?? mined;
    const replaced: TxEvent = { type: "REPLACED", hash: pendingHash, newHash, reason };
    // Repriced (sped up): same call, new hash - follow it. Otherwise our call never ran.
    return reason === "repriced" ? { events: [replaced, { ...receiptEvent, hash: newHash }], reportHash: newHash } : { events: [replaced], reportHash: null };
  }
  return { events: [receiptEvent], reportHash: mined };
}

// ---------------------------------------------------------------------------- error classification
interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  shortMessage?: unknown;
  details?: unknown;
  cause?: unknown;
  data?: unknown;
}

function* errorChain(err: unknown): Generator<ErrorLike> {
  let cur: unknown = err;
  for (let i = 0; i < 12 && cur && typeof cur === "object"; i++) {
    yield cur as ErrorLike;
    cur = (cur as ErrorLike).cause;
  }
}

const REJECTION_TEXT = /user (rejected|denied|cancel+ed)|rejected the request|request rejected|denied transaction signature/i;

/** EIP-1193 code 4001 / viem UserRejectedRequestError anywhere in the cause chain. */
export function isUserRejection(err: unknown): boolean {
  for (const e of errorChain(err)) {
    if (e.code === 4001 || e.code === "ACTION_REJECTED") return true;
    if (e.name === "UserRejectedRequestError") return true;
    const text = [e.shortMessage, e.details, e.message].filter((t) => typeof t === "string").join(" ");
    if (REJECTION_TEXT.test(text)) return true;
  }
  return false;
}

/**
 * Short human reason for a failed send. Prefers a decoded contract error name
 * ("Contract reverted: SettlementDeadlinePassed"), then viem's shortMessage.
 */
export function errorReason(err: unknown): string {
  for (const e of errorChain(err)) {
    const data = e.data as { errorName?: unknown; args?: unknown } | undefined;
    if (data && typeof data === "object" && typeof data.errorName === "string") {
      return `Contract reverted: ${data.errorName}`;
    }
  }
  for (const e of errorChain(err)) {
    if (typeof e.shortMessage === "string" && e.shortMessage) return e.shortMessage;
  }
  if (err instanceof Error && err.message) return err.message.split("\n")[0];
  if (typeof err === "string") return err;
  return "Unknown wallet error";
}
