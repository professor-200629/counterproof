/**
 * Pieces of the judge-facing console that are pure: target label wording, the source and
 * REPRODUCE links, which transactions paid a finding, which finding the overview features,
 * and the witness rows of each replay (from the recorded challenge #3 bundle when present).
 */
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ChainTransaction, ChallengeListItem, EvidenceBundle, SpecRule } from "@/lib/api";
import { ProvenanceBadge } from "@/components/ui/provenance-badge";
import { replayWitness } from "@/components/evidence/replays";
import { everFunded, injectedContent, pickFeaturedChallenge, sameFamilyRegressions, truncateText, verifiedSplit } from "@/components/overview/featured-data";
import { settleTxForEvidence, withdrawalAfterSettle } from "@/lib/reward-facts";
import { DEFAULT_SOURCE_URL, reproduceDocUrl, sourceUrlFrom } from "@/lib/snapshot";
import { adapterOfKey, isLiveModelLabel, targetLabelText } from "@/lib/target-labels";
import { render } from "@/test/render";

describe("target label wording (stored values unchanged)", () => {
  it("never calls a team-written live-model agent independent", () => {
    expect(targetLabelText("independent-implementation")).toBe("Live-model agent (team-written, no planted defects)");
    expect(targetLabelText("repaired-live-model")).toBe("Repaired live-model agent (team-written)");
    expect(targetLabelText("intentionally-vulnerable-fixture")).toBe("Intentionally vulnerable fixture - planted defects");
    expect(targetLabelText("repaired-fixture")).toBe("Repaired fixture");
    expect(targetLabelText("something-new")).toBe("something-new");
    for (const label of ["independent-implementation", "repaired-live-model", "intentionally-vulnerable-fixture", "repaired-fixture"]) {
      const { text } = render(createElement(ProvenanceBadge, { kind: "target", value: label }));
      expect(text).toContain(targetLabelText(label));
      expect(text).not.toMatch(/Independent implementation/);
    }
    expect(isLiveModelLabel("independent-implementation")).toBe(true);
    expect(isLiveModelLabel("repaired-live-model")).toBe(true);
    expect(isLiveModelLabel("repaired-fixture")).toBe(false);
    expect(adapterOfKey("llm-purchasing-agent@0.1.1")).toBe("llm-purchasing-agent");
  });
});

describe("source and REPRODUCE links", () => {
  it("default to the public repository; an https override wins, anything else is ignored", () => {
    expect(sourceUrlFrom(undefined)).toBe(DEFAULT_SOURCE_URL);
    expect(sourceUrlFrom("")).toBe(DEFAULT_SOURCE_URL);
    expect(sourceUrlFrom("http://example.com/repo")).toBe(DEFAULT_SOURCE_URL);
    expect(sourceUrlFrom("javascript:alert(1)")).toBe(DEFAULT_SOURCE_URL);
    expect(sourceUrlFrom("https://github.com/someone/fork")).toBe("https://github.com/someone/fork");
    expect(reproduceDocUrl(DEFAULT_SOURCE_URL)).toBe("https://github.com/professor-200629/counterproof/blob/main/docs/REPRODUCE.md");
    expect(reproduceDocUrl("https://github.com/someone/fork/")).toBe("https://github.com/someone/fork/blob/main/docs/REPRODUCE.md");
    expect(reproduceDocUrl("https://example.org/docs")).toBe("https://github.com/professor-200629/counterproof/blob/main/docs/REPRODUCE.md");
  });
});

const tx = (kind: ChainTransaction["kind"], hash: string, block: number, detail: Record<string, string>, status: ChainTransaction["status"] = "confirmed"): ChainTransaction => ({
  hash,
  chain_id: 10143,
  kind,
  status,
  challenge_id: 3,
  from_addr: detail.account ?? null,
  detail,
  block_number: block,
  error: null,
  created_at: block,
  updated_at: block,
});

describe("which transactions paid a finding", () => {
  const R = "0x6bb82dec23d196ad5859932f33c1af293a02eb42";
  const txs = [
    tx("withdraw", "0xold", 5, { account: R, amount_wei: "1" }),
    tx("settle", "0xsettle", 10, { recipient: R, reward_wei: "10", evidence_digest: "sha256:aa" }),
    tx("withdraw", "0xother", 11, { account: "0x0000000000000000000000000000000000000001", amount_wei: "5" }),
    tx("withdraw", "0xfailed", 11, { account: R, amount_wei: "10" }, "failed"),
    tx("withdraw", "0xwithdraw", 12, { account: R.toUpperCase().replace("0X", "0x"), amount_wei: "10" }),
  ];
  it("matches the settle by evidence digest and the recipient's confirmed withdrawal after it", () => {
    const settle = settleTxForEvidence(txs, "sha256:AA");
    expect(settle?.hash).toBe("0xsettle");
    expect(settleTxForEvidence(txs, "sha256:bb")).toBeNull();
    expect(withdrawalAfterSettle(txs, settle, R)?.hash).toBe("0xwithdraw");
    expect(withdrawalAfterSettle(txs, settle, null)).toBeNull();
  });
});

const item = (id: number, label: string, verified: number, fund_tx: string | null = "0xf"): ChallengeListItem =>
  ({ id, created_at: id, fund_tx, status: "settled", target: { adapter: "a", version: "1", label, determinism: "deterministic" }, counts: { runs: 0, active_runs: 0, candidates: 0, verified, not_reproduced: 0 } }) as unknown as ChallengeListItem;

describe("featured finding selection and counts", () => {
  it("prefers the newest live-model finding, else falls back to any verified violation, else none", () => {
    const fixture = item(1, "intentionally-vulnerable-fixture", 1);
    const live = item(3, "independent-implementation", 1);
    const newerFixture = item(4, "intentionally-vulnerable-fixture", 2);
    expect(pickFeaturedChallenge([fixture, live, newerFixture])).toEqual({ item: live, liveModel: true });
    expect(pickFeaturedChallenge([fixture, newerFixture])).toEqual({ item: newerFixture, liveModel: false });
    expect(pickFeaturedChallenge([item(5, "independent-implementation", 0)])).toBeNull();
    expect(pickFeaturedChallenge([item(6, "repaired-live-model", 1), fixture])?.liveModel).toBe(true);
  });

  it("splits verified violations by kind of target and counts ever-funded challenges", () => {
    const list = [item(1, "intentionally-vulnerable-fixture", 1), item(2, "repaired-fixture", 0, null), item(3, "independent-implementation", 1)];
    expect(verifiedSplit(list)).toEqual({ liveModel: 1, plantedFixture: 1, other: 0, listed: 2 });
    expect(everFunded(list)).toBe(2);
  });

  it("only counts a replay on the same adapter (another version) as a repair", () => {
    const view = { id: 3, spec: { target: { adapter: "llm-purchasing-agent", version: "0.1.1" } } } as never;
    const reg = (key: string, created_at: number, cand = "c1") =>
      ({ id: key, target_key: key, source_challenge_id: 3, source_candidate_id: cand, created_at }) as never;
    const regs = [reg("ref-purchasing-agent@1.1.0", 9), reg("llm-purchasing-agent@0.1.1", 8), reg("llm-purchasing-agent@0.1.2", 5, "c2"), reg("llm-purchasing-agent@0.1.3", 4)];
    expect(sameFamilyRegressions(regs, view, "c1").map((r) => r.target_key)).toEqual(["llm-purchasing-agent@0.1.3", "llm-purchasing-agent@0.1.2"]);
    expect(sameFamilyRegressions([reg("ref-purchasing-agent@1.1.0", 9)], view)).toEqual([]);
  });

  it("quotes injected text and truncates it on a word boundary", () => {
    const products = [{ sku: "SKU-1", merchant: "m_bolt", name: "Cable", price: 1, description: "" }];
    expect(injectedContent([{ type: "merchant_content", sku: "SKU-1", text: "hello" }, { type: "user_request", sku: "SKU-1" }], products)).toEqual([
      { sku: "SKU-1", merchant: "m_bolt", text: "hello" },
    ]);
    const long = "word ".repeat(40).trim();
    const t = truncateText(long, 50);
    expect(t.cut).toBe(true);
    expect(t.head.length).toBeLessThanOrEqual(50);
    expect(t.head.endsWith("word")).toBe(true);
    expect(truncateText("short", 50)).toEqual({ head: "short", cut: false });
  });
});

// ---------------------------------------------------------------------------- recorded bundle
const BUNDLE = new URL("../../../public/snapshot/api/evidence/sha256_06419a1ee4486451c45bb8f43f779695acb9e722f753cffb21e35311fc78f5a5.json", import.meta.url);

describe.skipIf(!existsSync(BUNDLE))("witness rows per replay (recorded challenge #3 evidence)", () => {
  const bundle = existsSync(BUNDLE) ? (JSON.parse(readFileSync(BUNDLE, "utf8")) as EvidenceBundle) : (null as unknown as EvidenceBundle);
  const rule: Pick<SpecRule, "template" | "params"> = { template: "agent.no_privileged_calls", params: { tools: ["update_mandate", "add_payee"] } };

  it("uses the checker's list only for the replay it came from, and each other replay's own ledger", () => {
    const seqOf = (index: number, type: string) => bundle.replays[index].ledger.find((e) => e.type === type)?.seq;
    const w0 = replayWitness(bundle, bundle.replays[0], rule);
    expect(w0).toEqual({ seqs: bundle.verdict.witness_seqs, source: "checker" });
    expect(w0.seqs).toContain(seqOf(0, "privileged.attempt"));
    for (const i of [1, 2]) {
      const w = replayWitness(bundle, bundle.replays[i], rule);
      expect(w.source).toBe("derived");
      // This replay's own privileged.attempt is a witness; its order.created is not.
      expect(w.seqs).toContain(seqOf(i, "privileged.attempt"));
      expect(w.seqs).not.toContain(seqOf(i, "order.created"));
    }
    // Without the rule's parameters, other replays mark nothing rather than borrowing replay 0's seqs.
    expect(replayWitness(bundle, bundle.replays[1], null)).toEqual({ seqs: [], source: "unavailable" });
  });
});
