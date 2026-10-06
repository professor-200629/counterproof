import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress } from "viem";
import { counterProofAbi } from "@/lib/abi";
import { normalizeDetail } from "@/lib/api";
import {
  bytes32ToDigest,
  createChallengeArgs,
  digestToBytes32,
  explorerTxUrl,
  explorerTxUrlForChainId,
  formatWei,
  networkLabel,
  parseMon,
  txNetworkPhrase,
} from "@/lib/chain";
import { formatCountdown, formatDuration, formatRelative, middleTruncate, truncateDigest } from "@/lib/format";
import { KNOWN_STATUSES, isChallengeActive, statusMeta } from "@/lib/status";
import type { AppConfig, ChallengeView } from "@/lib/api";

const D = "sha256:c70c529d7b1eefdd6b73f308051daaf650a2072edb373836d4554e5bd2466aa8";
const TX = "0x" + "ab".repeat(32);

function cfg(network: AppConfig["network"], template: string | null): Pick<AppConfig, "network" | "chain"> {
  return {
    network,
    chain: {
      network,
      label: "",
      chain_id: null,
      contract: null,
      rpc: null,
      reachable: false,
      explorer_tx_url: template,
    },
  };
}

describe("chain helpers", () => {
  it("converts digests to bytes32 and back", () => {
    const b = digestToBytes32(D);
    expect(b).toBe("0xc70c529d7b1eefdd6b73f308051daaf650a2072edb373836d4554e5bd2466aa8");
    expect(bytes32ToDigest(b)).toBe(D);
    expect(() => digestToBytes32("sha256:1234")).toThrow();
    expect(() => digestToBytes32("0x" + "00".repeat(32))).toThrow();
  });

  it("gives explorer links only on Monad testnet, on monadscan", () => {
    expect(explorerTxUrl(cfg("monad-testnet", "https://testnet.monadscan.com/tx/{hash}"), TX)).toBe(
      `https://testnet.monadscan.com/tx/${TX}`,
    );
    expect(explorerTxUrl(cfg("monad-testnet", null), TX)).toBe(`https://testnet.monadscan.com/tx/${TX}`);
    expect(explorerTxUrl(cfg("monad-testnet", "https://testnet.monadexplorer.com/tx/{hash}"), TX)).toBe(
      `https://testnet.monadscan.com/tx/${TX}`,
    );
    expect(explorerTxUrl(cfg("anvil-local", "https://testnet.monadscan.com/tx/{hash}"), TX)).toBeNull();
    expect(explorerTxUrl(cfg("offchain", null), TX)).toBeNull();
    expect(explorerTxUrl(null, TX)).toBeNull();
    expect(explorerTxUrlForChainId(31337, TX)).toBeNull();
    expect(explorerTxUrlForChainId(10143, TX)).toBe(`https://testnet.monadscan.com/tx/${TX}`);
  });

  it("never labels local anvil as Monad", () => {
    expect(networkLabel("anvil-local")).toBe("Local anvil (31337) - not Monad");
    expect(txNetworkPhrase(31337)).toBe("local anvil (31337)");
    expect(networkLabel("monad-testnet")).toBe("Monad Testnet (10143)");
    expect(networkLabel("offchain")).toBe("Off-chain only");
    expect(formatWei("1000000000000000000", "anvil-local")).not.toMatch(/MON/);
  });

  it("formats and parses MON amounts", () => {
    expect(formatWei("1500000000000000000", "monad-testnet")).toBe("1.5 MON");
    expect(formatWei("0")).toBe("0");
    expect(formatWei("not a number")).toBe("n/a");
    expect(formatWei(BigInt(1), "monad-testnet")).toBe("<0.000001 MON");
    expect(parseMon("1.5")).toBe(BigInt("1500000000000000000"));
    expect(parseMon(".25")).toBe(BigInt("250000000000000000"));
    expect(parseMon("-1")).toBeNull();
    expect(parseMon("1e18")).toBeNull();
    expect(parseMon("")).toBeNull();
    expect(parseMon("0.0000000000000000001")).toBeNull();
  });

  it("builds createChallenge arguments from a spec", () => {
    const { args, value } = createChallengeArgs(
      {
        evaluator: { address: "0x2222222222222222222222222222222222222222", name: "e" },
        deadlines: { submission_deadline: 100, settlement_deadline: 200 },
        reward: {
          amount_wei: "5",
          currency: "",
          eligible_outcomes: [],
          eligible_rules: [],
          policy: "",
          max_rewards: 1,
        },
      },
      D,
    );
    expect(args[0]).toBe(digestToBytes32(D));
    expect(args[1]).toBe(getAddress("0x2222222222222222222222222222222222222222"));
    expect(args[2]).toBe(BigInt(100));
    expect(args[3]).toBe(BigInt(200));
    expect(value).toBe(BigInt(5));
    // The arguments ABI-encode against the real contract ABI, and decode back to the same values.
    const data = encodeFunctionData({ abi: counterProofAbi, functionName: "createChallenge", args });
    const decoded = decodeFunctionData({ abi: counterProofAbi, data });
    expect(decoded.functionName).toBe("createChallenge");
    expect(decoded.args).toEqual(args);
  });
});

describe("status meta", () => {
  it("maps every documented status to a label and tone", () => {
    for (const [domain, list] of Object.entries(KNOWN_STATUSES)) {
      for (const s of list) {
        const m = statusMeta(s, domain as keyof typeof KNOWN_STATUSES);
        expect(m.label, `${domain}:${s}`).toBeTruthy();
        expect(m.description, `${domain}:${s}`).not.toMatch(/reported by the backend/);
      }
    }
  });

  it("uses the semantic colours", () => {
    expect(statusMeta("verified_violation").tone).toBe("bad");
    expect(statusMeta("not_reproduced").tone).toBe("ok");
    expect(statusMeta("inconclusive").tone).toBe("warn");
    expect(statusMeta("pending", "tx").tone).toBe("warn");
    expect(statusMeta("confirmed", "tx").tone).toBe("ok");
    expect(statusMeta("failed", "tx").tone).toBe("bad");
    expect(statusMeta("no_violation_found").description).toMatch(/not proof/);
  });

  it("renders unknown statuses neutrally", () => {
    expect(statusMeta("something_new")).toMatchObject({ label: "Something new", tone: "neutral" });
    expect(statusMeta(null).label).toBe("Unknown");
  });

  it("detects active challenges", () => {
    const base = { runs: [], evaluations: [], candidates: [] } as unknown as ChallengeView;
    expect(isChallengeActive(base)).toBe(false);
    expect(isChallengeActive({ ...base, runs: [{ status: "running" }] } as unknown as ChallengeView)).toBe(true);
    expect(isChallengeActive({ ...base, evaluations: [{ status: "replaying" }] } as unknown as ChallengeView)).toBe(true);
    expect(isChallengeActive({ ...base, runs: [{ status: "no_violation_found" }] } as unknown as ChallengeView)).toBe(false);
    expect(isChallengeActive(undefined)).toBe(false);
  });
});

describe("api error detail", () => {
  it("normalises FastAPI detail shapes", () => {
    expect(normalizeDetail("unknown challenge")).toBe("unknown challenge");
    expect(normalizeDetail([{ loc: ["body", "title"], msg: "Field required" }])).toBe("title: Field required");
    expect(normalizeDetail({ refused: ["a", "b"] })).toBe("refused: a; b");
    expect(normalizeDetail({ errors: ["bad action"] })).toBe("bad action");
    expect(normalizeDetail(null)).toBe("");
  });
});

describe("format", () => {
  it("truncates in the middle and keeps the digest prefix", () => {
    expect(middleTruncate("0x1234567890abcdef1234", 6, 4)).toBe("0x1234…1234");
    expect(truncateDigest(D)).toBe("sha256:c70c529d…466aa8");
    expect(middleTruncate("short")).toBe("short");
  });

  it("formats durations, relative times and countdowns", () => {
    expect(formatDuration(586)).toBe("586 ms");
    expect(formatDuration(12_400)).toBe("12.4 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatRelative(1000, 1000_000 + 180_000)).toBe("3 min ago");
    expect(formatRelative(2000, 1000_000)).toBe("in 16 min");
    expect(formatCountdown(3725)).toBe("1 h 02 min 05 s");
    expect(formatCountdown(-5)).toBe("0 s");
  });
});
