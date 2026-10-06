/**
 * Decoding CounterProof custom errors (createChallenge) into plain language.
 * viem usually decodes the revert itself (ContractFunctionRevertedError.data.errorName);
 * when only raw revert bytes are present we decode them with decodeErrorResult.
 */
import { decodeErrorResult, type Hex } from "viem";
import { counterProofAbi } from "@/lib/abi";
import { formatUnix } from "@/lib/format";

export interface DecodedContractError {
  name: string;
  args: readonly unknown[];
}

interface ErrorLike {
  cause?: unknown;
  data?: unknown;
  raw?: unknown;
}

function* chain(err: unknown): Generator<ErrorLike> {
  let cur: unknown = err;
  for (let i = 0; i < 12 && cur && typeof cur === "object"; i++) {
    yield cur as ErrorLike;
    cur = (cur as ErrorLike).cause;
  }
}

function isRevertBytes(v: unknown): v is Hex {
  return typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v);
}

/** The contract's custom error in an error thrown by viem / wagmi / the wallet, if any. */
export function decodeContractError(err: unknown): DecodedContractError | null {
  for (const e of chain(err)) {
    const data = e.data as { errorName?: unknown; args?: unknown } | undefined;
    if (data && typeof data === "object" && typeof data.errorName === "string") {
      return { name: data.errorName, args: Array.isArray(data.args) ? data.args : [] };
    }
  }
  for (const e of chain(err)) {
    for (const candidate of [e.raw, e.data]) {
      if (!isRevertBytes(candidate)) continue;
      try {
        const decoded = decodeErrorResult({ abi: counterProofAbi, data: candidate });
        return { name: decoded.errorName, args: (decoded.args ?? []) as readonly unknown[] };
      } catch {
        // not one of ours
      }
    }
  }
  return null;
}

/** "Contract reverted: Name" (from errorReason) -> "Name". */
export function errorNameFromReason(reason: string | null | undefined): string | null {
  const m = reason ? /Contract reverted: ([A-Za-z0-9_]+)/.exec(reason) : null;
  return m ? m[1] : null;
}

function seconds(v: unknown): string {
  try {
    const n = Number(typeof v === "bigint" ? v : BigInt(String(v)));
    return Number.isFinite(n) ? formatUnix(n, { utc: true, seconds: true }) : String(v);
  } catch {
    return String(v);
  }
}

function minutes(v: unknown): string {
  try {
    const n = Number(typeof v === "bigint" ? v : BigInt(String(v)));
    return `${Math.round(n / 60)} min`;
  } catch {
    return String(v);
  }
}

/** What a createChallenge custom error means and what to do about it. */
export function explainCreateChallengeError(name: string, args: readonly unknown[] = []): string {
  switch (name) {
    case "ZeroReward":
      return "The reward is zero. On-chain challenges need a positive reward; use the off-chain mode for evidence only.";
    case "ZeroSpecDigest":
      return "The spec digest is empty. Store the spec again.";
    case "ZeroEvaluator":
      return "The spec names no evaluator address. The backend must be configured with COUNTERPROOF_EVALUATOR_ADDRESS.";
    case "SubmissionDeadlineNotInFuture":
      return `The submission deadline${args[0] !== undefined ? ` (${seconds(args[0])})` : ""} is not in the future on chain${
        args[1] !== undefined ? ` (block time ${seconds(args[1])})` : ""
      }. Discard this challenge and choose a later deadline.`;
    case "SubmissionPeriodTooLong":
      return "The submission period is longer than the contract's 90-day maximum. Choose an earlier submission deadline.";
    case "SettlementDeadlineNotAfterSubmissionDeadline":
      return "The settlement deadline must come after the submission deadline.";
    case "SettlementWindowTooShort":
      return `The settlement window${args[0] !== undefined ? ` (${minutes(args[0])})` : ""} is shorter than the contract's 5-minute minimum.`;
    case "SettlementWindowTooLong":
      return `The settlement window${args[0] !== undefined ? ` (${minutes(args[0])})` : ""} is longer than the contract's 30-day maximum.`;
    default:
      return `The contract refused the call with ${name}.`;
  }
}
