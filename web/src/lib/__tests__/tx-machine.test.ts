import { describe, expect, it } from "vitest";
import {
  canSendAgain,
  errorReason,
  initialTxState,
  isBusy,
  isConfirmed,
  isUserRejection,
  receiptEvents,
  txReducer,
  type ReceiptOutcome,
  type TxEvent,
  type TxState,
} from "@/lib/tx-machine";

const HASH = "0xabcdef0000000000000000000000000000000000000000000000000000abcdef" as const;
const OTHER = "0x2222222222222222222222222222222222222222222222222222222222222222" as const;

function run(events: TxEvent[], from: TxState = initialTxState): TxState {
  return events.reduce(txReducer, from);
}

describe("txReducer", () => {
  it("starts idle and moves to awaiting_signature on request", () => {
    expect(initialTxState).toEqual({ status: "idle" });
    const s = run([{ type: "REQUEST_SIGNATURE" }]);
    expect(s).toEqual({ status: "awaiting_signature" });
    expect(isBusy(s)).toBe(true);
  });

  it("user rejection ends in `rejected`, distinct from failed, with no hash", () => {
    const s = run([{ type: "REQUEST_SIGNATURE" }, { type: "USER_REJECTED" }]);
    expect(s.status).toBe("rejected");
    expect("hash" in s).toBe(false);
    expect(isConfirmed(s)).toBe(false);
    expect(isBusy(s)).toBe(false);
  });

  it("a send error before any hash ends in `failed` without a hash", () => {
    const s = run([{ type: "REQUEST_SIGNATURE" }, { type: "SEND_FAILED", reason: "Contract reverted: ZeroReward" }]);
    expect(s).toEqual({ status: "failed", reason: "Contract reverted: ZeroReward", failure: "not_sent" });
  });

  it("confirms only on a success receipt for the pending hash", () => {
    const s = run([
      { type: "REQUEST_SIGNATURE" },
      { type: "SUBMITTED", hash: HASH },
      { type: "RECEIPT", hash: HASH, status: "success", block: BigInt(42) },
    ]);
    expect(s).toEqual({ status: "confirmed", hash: HASH, block: BigInt(42) });
    expect(isConfirmed(s)).toBe(true);
  });

  it("matches hashes case-insensitively", () => {
    const s = run([
      { type: "REQUEST_SIGNATURE" },
      { type: "SUBMITTED", hash: HASH },
      { type: "RECEIPT", hash: HASH.toUpperCase().replace("0X", "0x") as `0x${string}`, status: "success", block: BigInt(1) },
    ]);
    expect(s.status).toBe("confirmed");
  });

  it("a revert after pending ends in `failed` and keeps the hash", () => {
    const s = run([
      { type: "REQUEST_SIGNATURE" },
      { type: "SUBMITTED", hash: HASH },
      { type: "RECEIPT", hash: HASH, status: "reverted", block: BigInt(7) },
    ]);
    expect(s.status).toBe("failed");
    expect(s).toMatchObject({ hash: HASH, failure: "reverted" });
    expect(isConfirmed(s)).toBe(false);
  });

  it("a receipt error after pending is a failure, never a confirmation", () => {
    const s = run([
      { type: "REQUEST_SIGNATURE" },
      { type: "SUBMITTED", hash: HASH },
      { type: "RECEIPT_ERROR", hash: HASH, reason: "timeout" },
    ]);
    expect(s.status).toBe("failed");
    expect(s).toMatchObject({ failure: "receipt_unknown" });
    expect(isConfirmed(s)).toBe(false);
  });

  it("a failed transaction is never shown as confirmed, even if a success receipt arrives later", () => {
    const failed = run([
      { type: "REQUEST_SIGNATURE" },
      { type: "SUBMITTED", hash: HASH },
      { type: "RECEIPT", hash: HASH, status: "reverted", block: BigInt(7) },
    ]);
    const after = run(
      [
        { type: "RECEIPT", hash: HASH, status: "success", block: BigInt(8) },
        { type: "SUBMITTED", hash: HASH },
        { type: "RECEIPT", hash: HASH, status: "success", block: BigInt(9) },
      ],
      failed,
    );
    expect(after).toBe(failed);
    expect(isConfirmed(after)).toBe(false);

    const sendFailed = run([{ type: "REQUEST_SIGNATURE" }, { type: "SEND_FAILED", reason: "rpc down" }]);
    expect(run([{ type: "RECEIPT", hash: HASH, status: "success", block: BigInt(1) }], sendFailed)).toBe(sendFailed);
  });

  it("a rejected transaction cannot become pending or confirmed without a new request", () => {
    const rejected = run([{ type: "REQUEST_SIGNATURE" }, { type: "USER_REJECTED" }]);
    const after = run(
      [
        { type: "SUBMITTED", hash: HASH },
        { type: "RECEIPT", hash: HASH, status: "success", block: BigInt(3) },
      ],
      rejected,
    );
    expect(after).toBe(rejected);
  });

  it("ignores receipts for a different hash", () => {
    const pending = run([{ type: "REQUEST_SIGNATURE" }, { type: "SUBMITTED", hash: HASH }]);
    expect(run([{ type: "RECEIPT", hash: OTHER, status: "success", block: BigInt(1) }], pending)).toBe(pending);
  });

  it("does not accept a receipt before a hash exists", () => {
    const awaiting = run([{ type: "REQUEST_SIGNATURE" }]);
    expect(run([{ type: "RECEIPT", hash: HASH, status: "success", block: BigInt(1) }], awaiting)).toBe(awaiting);
  });

  it("does not start a second transaction while one is pending", () => {
    const pending = run([{ type: "REQUEST_SIGNATURE" }, { type: "SUBMITTED", hash: HASH }]);
    expect(txReducer(pending, { type: "REQUEST_SIGNATURE" })).toBe(pending);
  });

  it("allows a retry from a terminal state and RESET returns to idle", () => {
    const failed = run([{ type: "REQUEST_SIGNATURE" }, { type: "SEND_FAILED", reason: "x" }]);
    expect(txReducer(failed, { type: "REQUEST_SIGNATURE" })).toEqual({ status: "awaiting_signature" });
    expect(txReducer(failed, { type: "RESET" })).toEqual({ status: "idle" });
  });
});

describe("isUserRejection", () => {
  it("detects EIP-1193 code 4001 anywhere in the cause chain", () => {
    expect(isUserRejection({ message: "outer", cause: { code: 4001, message: "nope" } })).toBe(true);
  });

  it("detects viem's UserRejectedRequestError by name and message", () => {
    expect(isUserRejection({ name: "UserRejectedRequestError" })).toBe(true);
    expect(isUserRejection(new Error("MetaMask Tx Signature: User denied transaction signature."))).toBe(true);
  });

  it("does not treat reverts or RPC errors as rejections", () => {
    expect(isUserRejection({ shortMessage: "Execution reverted", cause: { data: { errorName: "ZeroReward" } } })).toBe(false);
    expect(isUserRejection(new Error("fetch failed"))).toBe(false);
  });
});

describe("errorReason", () => {
  it("prefers a decoded contract error name", () => {
    expect(
      errorReason({ shortMessage: "The contract function reverted.", cause: { data: { errorName: "SettlementDeadlinePassed" } } }),
    ).toBe("Contract reverted: SettlementDeadlinePassed");
  });

  it("falls back to shortMessage and then the first line of message", () => {
    expect(errorReason({ shortMessage: "insufficient funds" })).toBe("insufficient funds");
    expect(errorReason(new Error("first line\nsecond line"))).toBe("first line");
  });
});

describe("receiptEvents (viem waitForTransactionReceipt outcomes)", () => {
  const pending = run([{ type: "REQUEST_SIGNATURE" }, { type: "SUBMITTED", hash: HASH }]);
  const apply = (outcome: ReceiptOutcome) => {
    const { events, reportHash } = receiptEvents(HASH, outcome);
    return { state: run(events, pending), reportHash };
  };

  it("a reverted receipt (returned, not thrown) ends in failed/reverted and is still reported", () => {
    const { state, reportHash } = apply({
      kind: "receipt",
      receipt: { transactionHash: HASH, status: "reverted", blockNumber: BigInt(12) },
    });
    expect(state).toMatchObject({ status: "failed", failure: "reverted", hash: HASH });
    expect(canSendAgain(state)).toBe(true);
    expect(reportHash).toBe(HASH);
  });

  it("a success receipt confirms and is reported", () => {
    const { state, reportHash } = apply({ kind: "receipt", receipt: { transactionHash: HASH, status: "success", blockNumber: BigInt(3) } });
    expect(state).toEqual({ status: "confirmed", hash: HASH, block: BigInt(3) });
    expect(reportHash).toBe(HASH);
  });

  it("a wait error (e.g. Error('unknown reason') or a timeout) is receipt_unknown and blocks a resend", () => {
    const { state, reportHash } = apply({ kind: "error", error: new Error("unknown reason") });
    expect(state).toMatchObject({ status: "failed", failure: "receipt_unknown", hash: HASH });
    expect(canSendAgain(state)).toBe(false);
    expect(reportHash).toBe(HASH);
  });

  it("a cancelled replacement is never shown as confirmed, even though its own receipt succeeded", () => {
    const { state, reportHash } = apply({
      kind: "receipt",
      receipt: { transactionHash: OTHER, status: "success", blockNumber: BigInt(5) },
      replacement: { reason: "cancelled", transactionHash: OTHER },
    });
    expect(state).toMatchObject({ status: "failed", failure: "cancelled", hash: HASH, replacedBy: OTHER });
    expect(isConfirmed(state)).toBe(false);
    expect(canSendAgain(state)).toBe(true);
    expect(reportHash).toBeNull();
  });

  it("a different replacement transaction is 'replaced', not confirmed", () => {
    const { state } = apply({
      kind: "receipt",
      receipt: { transactionHash: OTHER, status: "success", blockNumber: BigInt(5) },
      replacement: { reason: "replaced", transactionHash: OTHER },
    });
    expect(state).toMatchObject({ status: "failed", failure: "replaced" });
  });

  it("a receipt for another hash without replacement info is treated as replaced", () => {
    const { state, reportHash } = apply({ kind: "receipt", receipt: { transactionHash: OTHER, status: "success", blockNumber: BigInt(5) } });
    expect(state).toMatchObject({ status: "failed", failure: "replaced" });
    expect(reportHash).toBeNull();
  });

  it("a repriced (sped-up) transaction follows the new hash, confirms it and reports the new hash", () => {
    const { state, reportHash } = apply({
      kind: "receipt",
      receipt: { transactionHash: OTHER, status: "success", blockNumber: BigInt(9) },
      replacement: { reason: "repriced", transactionHash: OTHER },
    });
    expect(state).toEqual({ status: "confirmed", hash: OTHER, block: BigInt(9) });
    expect(reportHash).toBe(OTHER);
  });

  it("a repriced transaction that reverted fails with the new hash", () => {
    const { state } = apply({
      kind: "receipt",
      receipt: { transactionHash: OTHER, status: "reverted", blockNumber: BigInt(9) },
      replacement: { reason: "repriced", transactionHash: OTHER },
    });
    expect(state).toMatchObject({ status: "failed", failure: "reverted", hash: OTHER });
  });
});

describe("canSendAgain", () => {
  it("allows a resend only when no transaction of ours can still take effect", () => {
    expect(canSendAgain(initialTxState)).toBe(true);
    expect(canSendAgain(run([{ type: "REQUEST_SIGNATURE" }, { type: "USER_REJECTED" }]))).toBe(true);
    expect(canSendAgain(run([{ type: "REQUEST_SIGNATURE" }, { type: "SEND_FAILED", reason: "x" }]))).toBe(true);
    expect(canSendAgain(run([{ type: "REQUEST_SIGNATURE" }]))).toBe(false);
    expect(canSendAgain(run([{ type: "REQUEST_SIGNATURE" }, { type: "SUBMITTED", hash: HASH }]))).toBe(false);
    const confirmed = run([
      { type: "REQUEST_SIGNATURE" },
      { type: "SUBMITTED", hash: HASH },
      { type: "RECEIPT", hash: HASH, status: "success", block: BigInt(1) },
    ]);
    expect(canSendAgain(confirmed)).toBe(false);
  });
});
