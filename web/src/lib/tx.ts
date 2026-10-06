/**
 * Wallet transactions, tracked end to end:
 *
 *   send(vars) -> wallet signature -> hash --(at once)--> backend, which waits for and reads the receipt itself
 *                                           -> receipt read in this browser (viem waitForTransactionReceipt)
 *
 * The hash goes to the backend as soon as the wallet returns it, so it is not lost if the
 * page is left or closed while the transaction is pending (it is also kept in localStorage
 * until the backend has verified it). Reverted receipts are read as receipts, not errors,
 * and wallet replacements (speed up / cancel) are followed via onReplaced.
 *
 * The pure state machine lives in ./tx-machine (re-exported here). This module adds the
 * React hook `useTrackedTx`. Import it only from client components.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection, usePublicClient, useSwitchChain, useWriteContract, type ResolvedRegister } from "wagmi";
import type { Abi, ContractFunctionArgs, ContractFunctionName, Hex } from "viem";
import type { WriteContractVariables } from "wagmi/query";
import { ApiError, api, type FundingResult, type TxVerifyResult } from "./api";
import { explorerTxUrlForChainId } from "./chain";
import { qk } from "./queries";
import {
  errorReason,
  initialTxState,
  isBusy as isBusyState,
  isUserRejection,
  receiptEvents,
  txHash,
  txReducer,
  type ReceiptOutcome,
  type TxEvent,
  type TxState,
} from "./tx-machine";
import type { SupportedChainId } from "./wagmi";

export * from "./tx-machine";

/** Contract actions the UI sends. `fund` = createChallenge (reported to /funding). */
export type TrackedTxKind = "fund" | "settle" | "refund" | "withdraw";

/** What the backend said about the transaction (it never trusts values from the UI). */
export type BackendReport =
  | { status: "idle" }
  | { status: "reporting" }
  /** The backend read the receipt from chain. For settle/refund/withdraw, `result.status` may still be "failed". */
  | { status: "verified"; result: FundingResult | TxVerifyResult }
  /** A rejection / send error was logged via /transactions/failed. */
  | { status: "failure_recorded" }
  /** The backend could not verify or record it; `error` is its `detail`. */
  | { status: "error"; error: string }
  /** Reporting disabled (no challenge id). */
  | { status: "skipped" };

// ---------------------------------------------------------------------------- sent-but-unverified hashes
const sentKey = (challengeId: number | string, kind: TrackedTxKind) => `counterproof:sent-tx:${challengeId}:${kind}`;
const SENT_EVENT = "counterproof:sent-tx";

/**
 * The last hash this browser sent for (challenge, kind) that the backend has not verified
 * yet, or null. A per-browser convenience only: the backend is the record.
 */
export function readSentTxHash(challengeId: number | string, kind: TrackedTxKind): Hex | null {
  try {
    const v = window.localStorage.getItem(sentKey(challengeId, kind));
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : null;
  } catch {
    return null;
  }
}

function writeSentTxHash(challengeId: number | string, kind: TrackedTxKind, hash: Hex | null): void {
  try {
    if (hash) window.localStorage.setItem(sentKey(challengeId, kind), hash);
    else window.localStorage.removeItem(sentKey(challengeId, kind));
    window.dispatchEvent(new Event(SENT_EVENT));
  } catch {
    // Storage unavailable (private window, blocked site data): the backend already has the hash.
  }
}

/** Subscribe to changes of the sent-hash store (this tab and others), for useSyncExternalStore. */
export function subscribeSentTxHash(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(SENT_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(SENT_EVENT, onChange);
  };
}

type WagmiConfig = ResolvedRegister["config"];
type WriteHook = ReturnType<typeof useWriteContract<WagmiConfig>>;
/** Loose variables object of wagmi's writeContract (any abi / function). */
export type WriteVariables = Parameters<WriteHook["mutateAsync"]>[0];

/**
 * Typed like wagmi's `writeContract`: `send({ address, abi: counterProofAbi, functionName, args, value })`
 * checks functionName / args / value against the ABI.
 */
export type SendFn = <
  const abi extends Abi | readonly unknown[],
  functionName extends ContractFunctionName<abi, "nonpayable" | "payable">,
  args extends ContractFunctionArgs<abi, "nonpayable" | "payable", functionName>,
  chainId extends SupportedChainId = SupportedChainId,
>(
  vars: WriteContractVariables<abi, functionName, args, WagmiConfig, chainId>,
) => Promise<SendResult>;

export interface UseTrackedTxOptions {
  kind: TrackedTxKind;
  /** Backend challenge id (not the on-chain id). When null/undefined nothing is reported. */
  challengeId: number | string | null | undefined;
  /** Chain the transaction must be sent on (from /api/config chain.chain_id). The wallet is asked to switch if needed. */
  chainId?: SupportedChainId;
  /** Called once when a success receipt arrives. */
  onConfirmed?: (hash: Hex, block: bigint) => void;
}

export type SendResult = { ok: true; hash: Hex } | { ok: false; rejected: boolean; reason: string };

export interface UseTrackedTxResult {
  state: TxState;
  report: BackendReport;
  /** Ask the wallet to sign and send `vars` (same shape as wagmi writeContract variables). */
  send: SendFn;
  reset: () => void;
  hash: Hex | undefined;
  isBusy: boolean;
  /** Chain the transaction was sent on. */
  chainId: number | undefined;
  /** MonadScan link on Monad testnet; always null on local anvil. */
  explorerUrl: string | null;
}

interface HookState {
  tx: TxState;
  report: BackendReport;
  chainId: number | undefined;
}

type HookAction =
  | { type: "tx"; event: TxEvent }
  | { type: "report"; report: BackendReport }
  | { type: "start"; chainId: number | undefined }
  | { type: "reset" };

function hookReducer(state: HookState, action: HookAction): HookState {
  switch (action.type) {
    case "tx": {
      const tx = txReducer(state.tx, action.event);
      return tx === state.tx ? state : { ...state, tx };
    }
    case "report":
      return { ...state, report: action.report };
    case "start": {
      const tx = txReducer(state.tx, { type: "REQUEST_SIGNATURE" });
      if (tx === state.tx) return state; // already in flight
      return { tx, report: { status: "idle" }, chainId: action.chainId };
    }
    case "reset":
      return { tx: initialTxState, report: { status: "idle" }, chainId: undefined };
  }
}

export function useTrackedTx(options: UseTrackedTxOptions): UseTrackedTxResult {
  const { kind, challengeId, chainId: targetChainId } = options;
  const [state, dispatch] = useReducer(hookReducer, {
    tx: initialTxState,
    report: { status: "idle" },
    chainId: undefined,
  });
  const write = useWriteContract();
  const switchChain = useSwitchChain();
  const connection = useConnection();
  const qc = useQueryClient();

  const onConfirmedRef = useRef(options.onConfirmed);
  useEffect(() => {
    onConfirmedRef.current = options.onConfirmed;
  }, [options.onConfirmed]);

  const inFlight = useRef(false);
  /** Hash whose receipt this browser is already waiting for. */
  const watchedHash = useRef<string | null>(null);
  /** Bumped on every report, new send and reset; a report result lands only if it is still the latest. */
  const reportSeq = useRef(0);
  /** Hash of the latest report and how it ended ("pending" while in flight). */
  const lastReport = useRef<{ hash: string; result: "pending" | "verified" | "error" } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const pendingHash = state.tx.status === "pending" ? state.tx.hash : undefined;
  const publicClient = usePublicClient({ chainId: state.chainId as SupportedChainId | undefined });

  const invalidate = useCallback(() => {
    if (challengeId === null || challengeId === undefined) return;
    void qc.invalidateQueries({ queryKey: qk.challenge(challengeId) });
    void qc.invalidateQueries({ queryKey: qk.settlement(challengeId) });
    void qc.invalidateQueries({ queryKey: qk.challenges });
    void qc.invalidateQueries({ queryKey: qk.overview });
  }, [challengeId, qc]);

  /** Give the backend the hash; it waits for the receipt and reads it and its events from chain itself. */
  const reportHash = useCallback(
    async (hash: Hex) => {
      if (challengeId === null || challengeId === undefined) {
        dispatch({ type: "report", report: { status: "skipped" } });
        return;
      }
      const seq = ++reportSeq.current;
      lastReport.current = { hash: hash.toLowerCase(), result: "pending" };
      dispatch({ type: "report", report: { status: "reporting" } });
      try {
        const result =
          kind === "fund"
            ? await api.recordFunding(challengeId, { tx_hash: hash })
            : await api.recordTransaction(challengeId, { tx_hash: hash, kind });
        // The backend has it on record now (confirmed, or reverted for settle/refund/withdraw).
        writeSentTxHash(challengeId, kind, null);
        if (seq !== reportSeq.current) return;
        lastReport.current = { hash: hash.toLowerCase(), result: "verified" };
        dispatch({ type: "report", report: { status: "verified", result } });
      } catch (e) {
        if (seq !== reportSeq.current) return;
        lastReport.current = { hash: hash.toLowerCase(), result: "error" };
        dispatch({ type: "report", report: { status: "error", error: e instanceof ApiError ? e.detail : errorReason(e) } });
      } finally {
        invalidate();
      }
    },
    [challengeId, kind, invalidate],
  );

  /** No transaction of ours was mined (rejection, send error, cancelled in the wallet): log it via /transactions/failed. */
  const reportFailure = useCallback(
    async (error: string, hash?: Hex) => {
      if (challengeId === null || challengeId === undefined) {
        dispatch({ type: "report", report: { status: "skipped" } });
        return;
      }
      const seq = ++reportSeq.current;
      lastReport.current = null;
      dispatch({ type: "report", report: { status: "reporting" } });
      try {
        await api.recordFailedTransaction(challengeId, { kind, error, tx_hash: hash ?? null });
        if (hash) writeSentTxHash(challengeId, kind, null);
        if (seq !== reportSeq.current) return;
        dispatch({ type: "report", report: { status: "failure_recorded" } });
      } catch (e) {
        if (seq !== reportSeq.current) return;
        dispatch({ type: "report", report: { status: "error", error: e instanceof ApiError ? e.detail : errorReason(e) } });
      } finally {
        invalidate();
      }
    },
    [challengeId, kind, invalidate],
  );

  /** Apply a receipt outcome: state machine first, then the backend unless it already has this hash. */
  const applyOutcome = useCallback(
    (sent: Hex, outcome: ReceiptOutcome) => {
      const { events, reportHash: verifyHash } = receiptEvents(sent, outcome);
      for (const event of events) dispatch({ type: "tx", event });
      const replaced = events.find((e): e is Extract<TxEvent, { type: "REPLACED" }> => e.type === "REPLACED");
      if (replaced && replaced.reason !== "repriced") {
        void reportFailure(`${replaced.reason} in wallet: replacement ${replaced.newHash} took the nonce; the contract was not called`, sent);
        return;
      }
      if (outcome.kind === "receipt" && outcome.receipt.status === "reverted" && challengeId !== null && challengeId !== undefined) {
        // Final on chain and nothing escrowed or paid: no hash left to hand over later.
        writeSentTxHash(challengeId, kind, null);
      }
      if (verifyHash) {
        const last = lastReport.current;
        // The report sent with the hash is still in flight or verified it: nothing to add.
        const covered = last !== null && last.hash === verifyHash.toLowerCase() && last.result !== "error";
        if (!covered) void reportHash(verifyHash);
      }
      if (outcome.kind === "receipt" && verifyHash && outcome.receipt.status === "success") {
        onConfirmedRef.current?.(verifyHash, outcome.receipt.blockNumber);
      }
    },
    [challengeId, kind, reportFailure, reportHash],
  );

  // Wait for the receipt with viem directly: unlike wagmi's action it returns a reverted
  // receipt instead of throwing, and onReplaced reports speed-ups and cancellations.
  useEffect(() => {
    if (!pendingHash || !publicClient || watchedHash.current === pendingHash) return;
    watchedHash.current = pendingHash;
    const sent = pendingHash;
    void (async () => {
      let replacement: Extract<ReceiptOutcome, { kind: "receipt" }>["replacement"];
      let outcome: ReceiptOutcome;
      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: sent,
          onReplaced: (r) => {
            replacement = { reason: r.reason, transactionHash: r.transaction.hash };
          },
        });
        outcome = { kind: "receipt", receipt, replacement };
      } catch (e) {
        // Timeout or RPC hiccup: one direct read before calling the receipt unknown.
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash: sent });
          outcome = { kind: "receipt", receipt };
        } catch {
          outcome = { kind: "error", error: e };
        }
      }
      if (mounted.current) applyOutcome(sent, outcome);
    })();
  }, [pendingHash, publicClient, applyOutcome]);

  const sendImpl = useCallback(
    async (vars: WriteVariables): Promise<SendResult> => {
      if (inFlight.current || isBusyState(state.tx)) {
        return { ok: false, rejected: false, reason: "A transaction is already in progress." };
      }
      inFlight.current = true;
      const chainId = (vars.chainId as number | undefined) ?? targetChainId ?? connection.chainId;
      reportSeq.current++;
      lastReport.current = null;
      watchedHash.current = null;
      dispatch({ type: "start", chainId });
      try {
        if (chainId !== undefined && connection.chainId !== undefined && connection.chainId !== chainId) {
          await switchChain.mutateAsync({ chainId: chainId as SupportedChainId });
        }
        const hash = await write.mutateAsync({ ...vars, chainId: chainId as SupportedChainId } as unknown as WriteVariables);
        dispatch({ type: "tx", event: { type: "SUBMITTED", hash } });
        // Hand the hash over at once: the backend waits for the receipt itself, so leaving or
        // closing this page can no longer lose a transaction that is already on its way.
        if (challengeId !== null && challengeId !== undefined) writeSentTxHash(challengeId, kind, hash);
        void reportHash(hash);
        return { ok: true, hash };
      } catch (e) {
        const rejected = isUserRejection(e);
        const reason = rejected ? "Rejected in the wallet. Nothing was sent." : errorReason(e);
        dispatch({ type: "tx", event: rejected ? { type: "USER_REJECTED", reason } : { type: "SEND_FAILED", reason } });
        void reportFailure(rejected ? `user rejected in wallet: ${errorReason(e)}` : reason);
        return { ok: false, rejected, reason };
      } finally {
        inFlight.current = false;
      }
    },
    [challengeId, connection.chainId, kind, reportFailure, reportHash, state.tx, switchChain, targetChainId, write],
  );

  const reset = useCallback(() => {
    watchedHash.current = null;
    reportSeq.current++;
    lastReport.current = null;
    dispatch({ type: "reset" });
  }, []);

  const hash = txHash(state.tx);
  return {
    state: state.tx,
    report: state.report,
    send: sendImpl as unknown as SendFn,
    reset,
    hash,
    isBusy: isBusyState(state.tx),
    chainId: state.chainId,
    explorerUrl: explorerTxUrlForChainId(state.chainId, hash),
  };
}
