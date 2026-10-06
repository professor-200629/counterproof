/**
 * Chain helpers: digests <-> bytes32, explorer links, MON/wei formatting, network labels,
 * and argument builders for the CounterProof contract.
 *
 * Rules enforced here:
 * - Only Monad testnet has an explorer link (testnet.monadscan.com). Local anvil and
 *   off-chain never get one.
 * - Local anvil is always labelled "local anvil (31337)", never "Monad".
 */
import { formatEther, getAddress, isAddress, parseEther, type Address, type Hex } from "viem";
import type { AppConfig, AttestationTypedData, ChallengeSpec, Digest, NetworkKind } from "./api";

export const MONAD_TESTNET_ID = 10143;
export const ANVIL_CHAIN_ID = 31337;
export const MONADSCAN_TX_BASE = "https://testnet.monadscan.com/tx/";

/** Shown on the funding step when the network is Monad testnet. */
export const MONAD_RESERVE_HINT =
  "Monad testnet keeps a 10 MON reserve: a transaction that sends value reverts if your balance would end below 10 MON. Monad also bills the full gas limit you sign for, not only the gas used.";

/** Shown next to any blockchain receipt. */
export const RECEIPT_MEANING =
  "A blockchain receipt proves that a transaction was recorded. It does not prove the AI agent is correct or incorrect.";

/** Shown next to attestations and signatures. */
export const ATTESTATION_MEANING =
  "The evaluator is a declared trusted party. Its EIP-712 signature is an attestation about its own replay, not a zero-knowledge proof; the contract cannot re-check the replay.";

// ---------------------------------------------------------------------------- digests
const DIGEST_RE = /^sha256:([0-9a-fA-F]{64})$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_RE.test(value);
}

/** "sha256:<hex>" -> "0x<hex>" (the contract's bytes32). Throws on anything else. */
export function digestToBytes32(digest: Digest): Hex {
  const m = DIGEST_RE.exec(digest);
  if (!m) throw new Error(`not a sha256 digest: ${digest}`);
  return `0x${m[1].toLowerCase()}`;
}

/** "0x<hex>" -> "sha256:<hex>". Throws on anything else. */
export function bytes32ToDigest(value: string): Digest {
  if (!BYTES32_RE.test(value)) throw new Error(`not a bytes32 value: ${value}`);
  return `sha256:${value.slice(2).toLowerCase()}`;
}

/**
 * Does a bytes32 value from a signed message equal a "sha256:" digest? Null when the
 * digest is missing (nothing to compare); false when either value is malformed.
 */
export function digestMatchesBytes32(bytes32: string | null | undefined, digest: string | null | undefined): boolean | null {
  if (!bytes32 || !digest) return null;
  if (!isDigest(digest) || !BYTES32_RE.test(bytes32)) return false;
  return digestToBytes32(digest) === bytes32.toLowerCase();
}

export function isTxHash(value: unknown): value is Hex {
  return typeof value === "string" && BYTES32_RE.test(value);
}

// ---------------------------------------------------------------------------- networks
export function chainIdForNetwork(network: NetworkKind | null | undefined): number | null {
  if (network === "monad-testnet") return MONAD_TESTNET_ID;
  if (network === "anvil-local") return ANVIL_CHAIN_ID;
  return null;
}

export function networkForChainId(chainId: number | null | undefined): NetworkKind | null {
  if (chainId === MONAD_TESTNET_ID) return "monad-testnet";
  if (chainId === ANVIL_CHAIN_ID) return "anvil-local";
  return null;
}

/** Badge text for the configured network. */
export function networkLabel(network: NetworkKind | string | null | undefined): string {
  switch (network) {
    case "monad-testnet":
      return "Monad Testnet (10143)";
    case "anvil-local":
      return "Local anvil (31337) - not Monad";
    case "offchain":
      return "Off-chain only";
    default:
      return network ? `Unknown network (${network})` : "Network unknown";
  }
}

/** Phrase for describing where a transaction happened ("confirmed on local anvil (31337)"). */
export function txNetworkPhrase(chainId: number | null | undefined): string {
  if (chainId === MONAD_TESTNET_ID) return "Monad Testnet (10143)";
  if (chainId === ANVIL_CHAIN_ID) return "local anvil (31337)";
  return chainId ? `chain ${chainId}` : "an unknown chain";
}

export function isMonadTestnet(config: Pick<AppConfig, "network"> | null | undefined): boolean {
  return config?.network === "monad-testnet";
}

export function isLocalAnvil(config: Pick<AppConfig, "network"> | null | undefined): boolean {
  return config?.network === "anvil-local";
}

export function isOffchain(config: Pick<AppConfig, "network"> | null | undefined): boolean {
  return !config || config.network === "offchain";
}

/**
 * Explorer link for a transaction, or null. Only Monad testnet has one; local anvil and
 * off-chain always return null even if a template is somehow present.
 */
export function explorerTxUrl(
  config: Pick<AppConfig, "network" | "chain"> | null | undefined,
  hash: string | null | undefined,
): string | null {
  if (!config || !hash || config.network !== "monad-testnet") return null;
  const template = config.chain?.explorer_tx_url;
  if (template && template.includes("{hash}") && template.startsWith("https://testnet.monadscan.com/")) {
    return template.replace("{hash}", hash);
  }
  return `${MONADSCAN_TX_BASE}${hash}`;
}

/** Explorer link from a transaction's own chain id (for rows in ChallengeView.transactions). */
export function explorerTxUrlForChainId(chainId: number | null | undefined, hash: string | null | undefined): string | null {
  return chainId === MONAD_TESTNET_ID && hash ? `${MONADSCAN_TX_BASE}${hash}` : null;
}

// ---------------------------------------------------------------------------- amounts
/** Currency word for the native token on a network. */
export function nativeSymbol(network: NetworkKind | string | null | undefined): string {
  if (network === "monad-testnet") return "MON";
  if (network === "anvil-local") return "ETH (local anvil test value)";
  return "";
}

/**
 * wei (decimal string or bigint) -> "1.5 MON". Without a network only the number is
 * returned. Invalid input -> "n/a".
 */
export function formatWei(
  wei: string | bigint | null | undefined,
  network?: NetworkKind | string | null,
  opts: { maxDecimals?: number } = {},
): string {
  if (wei === null || wei === undefined || wei === "") return "n/a";
  let value: bigint;
  try {
    value = typeof wei === "bigint" ? wei : BigInt(wei);
  } catch {
    return "n/a";
  }
  const max = opts.maxDecimals ?? 6;
  let text = formatEther(value);
  const [whole, frac] = text.split(".");
  if (frac && frac.length > max) {
    const trimmed = frac.slice(0, max).replace(/0+$/, "");
    text = trimmed ? `${whole}.${trimmed}` : whole;
    if (value > BigInt(0) && text === "0") text = `<0.${"0".repeat(max - 1)}1`;
  }
  const symbol = nativeSymbol(network ?? null);
  return symbol ? `${text} ${symbol}` : text;
}

/**
 * Parse a user-typed amount ("1.5") into wei. Returns null for empty, negative, malformed
 * or over-precise (> 18 decimals) input.
 */
export function parseMon(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s) && !/^\.\d{1,18}$/.test(s)) return null;
  try {
    return parseEther(s.startsWith(".") ? `0${s}` : s);
  } catch {
    return null;
  }
}

export function toChecksumAddress(value: string): Address | null {
  return isAddress(value, { strict: false }) ? getAddress(value) : null;
}

// ---------------------------------------------------------------------------- contract args
/** Arguments and value for `createChallenge(specDigest, evaluator, submissionDeadline, settlementDeadline)`. */
export function createChallengeArgs(spec: Pick<ChallengeSpec, "evaluator" | "deadlines" | "reward">, specDigest: Digest) {
  const evaluator = toChecksumAddress(spec.evaluator.address);
  if (!evaluator) throw new Error(`invalid evaluator address in spec: ${spec.evaluator.address}`);
  return {
    args: [
      digestToBytes32(specDigest),
      evaluator,
      BigInt(spec.deadlines.submission_deadline),
      BigInt(spec.deadlines.settlement_deadline),
    ] as const,
    value: BigInt(spec.reward.amount_wei),
  };
}

export interface SettleAttestationArg {
  challengeId: bigint;
  specDigest: Hex;
  submissionId: Hex;
  candidateDigest: Hex;
  evidenceDigest: Hex;
  challenger: Address;
  recipient: Address;
  verdict: number;
  expiry: bigint;
}

/**
 * Arguments for `settle(a, signature)` from the backend's typed data. Anyone may relay
 * it; the contract pays only the recipient bound when the submission was committed.
 */
export function settleArgs(typed: AttestationTypedData, signature: Hex): readonly [SettleAttestationArg, Hex] {
  const m = typed.message;
  const challenger = toChecksumAddress(m.challenger);
  const recipient = toChecksumAddress(m.recipient);
  if (!challenger || !recipient) throw new Error("attestation has an invalid challenger or recipient address");
  return [
    {
      challengeId: BigInt(m.challengeId),
      specDigest: m.specDigest,
      submissionId: m.submissionId,
      candidateDigest: m.candidateDigest,
      evidenceDigest: m.evidenceDigest,
      challenger,
      recipient,
      verdict: Number(m.verdict),
      expiry: BigInt(m.expiry),
    },
    signature,
  ] as const;
}
