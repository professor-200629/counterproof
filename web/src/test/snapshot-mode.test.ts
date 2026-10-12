/**
 * The console built as a read-only recorded snapshot (NEXT_PUBLIC_SNAPSHOT=1), rendered from
 * the sample recording in public/snapshot: the banner on every page, no wallet, no action
 * control that looks clickable, recorded deadlines that do not count down, downloads that
 * point at the static files, and no claim of a live chain read on local anvil.
 */
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/queries";
import { hrefs, render } from "./render";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  notFound: () => {
    throw new Error("notFound");
  },
}));

const PUBLIC = new URL("../../public/", import.meta.url);
const HAVE_SNAPSHOT = existsSync(new URL("./snapshot/manifest.json", PUBLIC));

function recorded<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(new URL(`./snapshot/${file}`, PUBLIC), "utf8")) as T;
}

interface View {
  id: number;
  status: string;
  spec_digest: string;
  candidates: { id: string; status: string }[];
  evaluations: { id: string; evidence_digest: string | null; candidate_id: string | null }[];
}

/** <button> elements whose text contains `label`. */
function buttons(html: string, label: RegExp): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "")).filter((t) => label.test(t));
}

const manifestText = HAVE_SNAPSHOT ? readFileSync(new URL("./snapshot/manifest.json", PUBLIC), "utf8") : "";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "1");
  vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", manifestText);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

interface Manifest {
  taken_at: number;
  network: string;
  network_label: string;
  chain_id: number | null;
  challenges_included: number[];
}

describe.skipIf(!HAVE_SNAPSHOT)("snapshot mode, rendered from public/snapshot", () => {
  const manifest = HAVE_SNAPSHOT ? (JSON.parse(manifestText) as Manifest) : null;
  const id = String(manifest?.challenges_included[0] ?? 0);
  const config = HAVE_SNAPSHOT ? recorded("api/config.json") : null;
  const view = HAVE_SNAPSHOT ? recorded<View>(`api/challenges/${id}.json`) : (null as unknown as View);

  it("the shell carries the banner and the recorded network, and has no wallet button", async () => {
    const { AppShell } = await import("@/components/shell/app-shell");
    const { snapshotBannerText } = await import("@/lib/snapshot");
    const { formatUnix } = await import("@/lib/format");
    const { networkLabel } = await import("@/lib/chain");
    const { text } = render(createElement(AppShell, null, createElement("p", null, "page")), { data: [[qk.config, config]] });
    expect(text).toContain(snapshotBannerText(JSON.parse(manifestText)));
    expect(text).toContain(`Taken ${formatUnix(manifest!.taken_at, { utc: true })}`);
    expect(text).toContain(manifest!.network_label);
    expect(text).toContain("How to run it yourself");
    // The network badge names the recorded network (from the manifest), whichever it is.
    expect(text).toContain(networkLabel(manifest!.network));
    if (manifest!.chain_id !== null) expect(text).toContain(`(${manifest!.chain_id})`);
    if (manifest!.network === "anvil-local") expect(text).toContain("Local anvil (31337) - not Monad");
    else expect(text).not.toContain("Local anvil");
    expect(text).not.toMatch(/Connect wallet/);
  });

  it("links 'How to run it yourself' to the public repository when no override is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_SOURCE_URL", "");
    const { AppShell } = await import("@/components/shell/app-shell");
    const { DEFAULT_SOURCE_URL } = await import("@/lib/snapshot");
    const { html, text } = render(createElement(AppShell, null, createElement("p", null, "page")), { data: [[qk.config, config]] });
    expect(DEFAULT_SOURCE_URL).toBe("https://github.com/professor-200629/counterproof");
    expect(hrefs(html)).toContain(DEFAULT_SOURCE_URL);
    expect(text).not.toContain("source repository not published yet");
  });

  it("testing and findings tabs show no Run / Cancel / Submit control, only the read-only note", async () => {
    const { TestingTab } = await import("@/components/challenge/testing-tab");
    const { FindingsTab } = await import("@/components/challenge/findings-tab");
    const testing = render(createElement(TestingTab, { view, config, nowMs: null, onShowFindings: () => {} } as never), {
      data: [[qk.strategies, recorded("api/strategies.json")]],
    });
    expect(buttons(testing.html, /^Run |Cancel/)).toEqual([]);
    expect(testing.text).not.toContain("Max sequences");
    expect(testing.text).toContain("Read-only recorded snapshot");
    const findings = render(createElement(FindingsTab, { view, config, nowMs: null } as never));
    expect(buttons(findings.html, /Submit/)).toEqual([]);
    if (view.candidates.some((c) => c.status === "candidate_found" && !view.evaluations.some((e) => e.candidate_id === c.id))) {
      expect(findings.text).toContain("Submitting this candidate for independent replay needs the CounterProof evaluator backend");
    }
  });

  it("settlement: no relay / withdraw / refund control, no live read of the local anvil chain, deadlines judged at snapshot time", async () => {
    const { SettlementView } = await import("@/components/settlement/settlement-view");
    const { html, text } = render(createElement(SettlementView, { challengeId: id }), {
      data: [
        [qk.challenge(id), view],
        [qk.settlement(id), recorded(`api/challenges/${id}/settlement.json`)],
        [qk.config, config],
      ],
    });
    expect(buttons(html, /Relay|Withdraw|Refund|Ask the evaluator|Fund|Clear status/)).toEqual([]);
    expect(text).not.toMatch(/Connect wallet|No wallet connected/);
    expect(text).not.toMatch(/\bin \d+ (h|min|s)\b/); // nothing counts down
    if (view.status === "settled") {
      // The only browser-side chain read (credits) runs only against the public Monad RPC;
      // a recorded local anvil chain is never read, and says so.
      if (manifest!.network === "anvil-local") {
        expect(text).toContain("local anvil chain - not reachable from this hosted snapshot; values below are as recorded");
        expect(text).not.toContain("read live from the contract");
      } else if (manifest!.network === "monad-testnet") {
        expect(text).toContain("read live from the contract on Monad testnet");
        expect(text).not.toContain("local anvil chain - not reachable");
      }
    }
  });

  it("evidence and regression downloads point at the recorded files with a download attribute", async () => {
    const { EvidenceViewer } = await import("@/components/evidence/evidence-viewer");
    const ev = view.evaluations.find((e) => e.evidence_digest);
    if (!ev) return;
    const evaluation = recorded(`api/evaluations/${ev.id}.json`);
    const digestFile = ev.evidence_digest!.replace(/:/g, "_");
    const { html } = render(createElement(EvidenceViewer, { id: ev.id }), {
      data: [
        [qk.evaluation(ev.id), evaluation],
        [qk.challenge(id), view],
        [qk.evidence(ev.evidence_digest!), recorded(`api/evidence/${digestFile}.json`)],
        [qk.config, config],
      ],
    });
    expect(hrefs(html)).toContain(`/snapshot/api/evidence/${digestFile}.json`);
    expect(html).toMatch(new RegExp(`href="/snapshot/api/evidence/${digestFile}\\.json"[^>]*download=|download="[^"]*"[^>]*href="/snapshot/api/evidence/${digestFile}\\.json"`));
    expect(hrefs(html).some((h) => h.startsWith("/api/"))).toBe(false);
    expect(buttons(html, /Retry|Request attestation/)).toEqual([]);

    const regs = recorded<{ id: string; status: string; outcome: string | null }[]>(`api/challenges/${id}/regressions.json`);
    if (regs.length === 0) return;
    const { CompareView } = await import("@/components/compare/compare-view");
    const reg = regs[0];
    const compare = render(createElement(CompareView, { challengeId: id, initial: { regression: reg.id } }), {
      data: [
        [qk.challenge(id), view],
        [qk.targets, recorded("api/targets.json")],
        [qk.challengeRegressions(id), regs],
        [qk.regression(reg.id), recorded(`api/regressions/${reg.id}.json`)],
        [qk.regressionExport(reg.id), recorded(`api/regressions/${reg.id}/export.json`)],
      ],
    });
    expect(buttons(compare.html, /Replay against/)).toEqual([]);
    expect(compare.text).toContain("Replaying this counterexample against another version");
    if (reg.outcome) {
      expect(hrefs(compare.html)).toContain(`/snapshot/api/regressions/${reg.id}/export.json`);
      expect(hrefs(compare.html)).toContain(`/snapshot/api/regressions/${reg.id}/export.pytest.txt`);
      expect(compare.html).toContain(`download="test_regression_${reg.id}.py"`);
    }
  });

  it("/challenges/new explains the five steps instead of offering a wizard", async () => {
    const { default: NewChallengePage } = await import("@/app/challenges/new/page");
    const { text, html } = render(createElement(NewChallengePage));
    for (const step of ["Target", "Rules", "Scope & evaluator", "Reward & deadlines", "Review & publish"]) expect(text).toContain(step);
    expect(text).toContain("README");
    expect(text).not.toContain("Next:");
    expect(html).not.toMatch(/<input|<select|<textarea/);
  });

  it("a challenge left out of the export reads 'not included in this recorded snapshot'", async () => {
    const { ChallengeDetail } = await import("@/components/challenge/challenge-detail");
    const { ApiError } = await import("@/lib/api");
    const { text } = render(createElement(ChallengeDetail, { id: "999" }), {
      errors: [[qk.challenge("999"), new ApiError({ status: 404, detail: "/api/challenges/999 is not included in this recorded snapshot.", path: "/challenges/999" })]],
    });
    expect(text).toContain("not included in this recorded snapshot");
    expect(text).not.toContain("does not exist");
  });

  // ------------------------------------------------------------------ featured finding
  // Expected values are read from the recorded files, independently of the card's code. With
  // the current Monad testnet recording this is challenge #3: R5 broken by update_mandate in 3
  // of 3 replays, settled and withdrawn, no repair replayed yet.
  const list = HAVE_SNAPSHOT ? recorded<FeaturedListItem[]>("api/challenges.json") : [];
  const featuredItem =
    [...list]
      .sort((a, b) => b.created_at - a.created_at || b.id - a.id)
      .find((c) => (c.target.label === "independent-implementation" || c.target.label === "repaired-live-model") && c.counts.verified > 0) ?? null;

  it.skipIf(!featuredItem)("the overview leads with the featured live-model finding, explained from recorded data", async () => {
    const fid = String(featuredItem!.id);
    const fview = recorded<FeaturedView>(`api/challenges/${fid}.json`);
    const evaluation = [...fview.evaluations]
      .filter((e) => e.outcome === "verified_violation")
      .sort((a, b) => (fview.attestation?.evaluation_id === b.id ? 1 : 0) - (fview.attestation?.evaluation_id === a.id ? 1 : 0) || b.created_at - a.created_at)[0];
    const bundle = recorded<FeaturedBundle>(`api/evidence/${evaluation.evidence_digest.replace(/:/g, "_")}.json`);
    const regs = recorded<{ target_key: string; source_challenge_id: number }[]>(`api/challenges/${fid}/regressions.json`);
    const erc = recorded<{ available: boolean; chain_id: number; feedback?: { evidence_digest: string; agent_id: number; tag2: string; tx: string }[] }>("api/erc8004.json");

    const { OverviewView } = await import("@/components/overview/overview-view");
    const { DEFAULT_SOURCE_URL, REPRODUCE_DOC_URL } = await import("@/lib/snapshot");
    const { html, text } = render(createElement(OverviewView), {
      data: [
        [qk.overview, recorded("api/overview.json")],
        [qk.challenges, list],
        [qk.config, config],
        [qk.challenge(fid), fview],
        [qk.evidence(evaluation.evidence_digest), bundle],
        [qk.challengeRegressions(fid), regs],
        [qk.erc8004, erc],
      ],
    });

    // First on the page (before the counts), with the new label text.
    expect(text).toContain("Featured live-model finding");
    expect(text.indexOf("Featured live-model finding")).toBeLessThan(text.indexOf("Awaiting settlement"));
    expect(text).toContain("Live-model agent (team-written, no planted defects)");

    // Which promise, on which agent and model.
    const ruleId = evaluation.summary.rule.rule_id;
    const rule = fview.spec.rules.find((r) => r.id === ruleId)!;
    expect(text).toContain(rule.statement);
    expect(text).toContain(`${fview.spec.target.adapter}@${fview.spec.target.version}`);
    if (typeof fview.spec.target.config.model === "string") expect(text).toContain(fview.spec.target.config.model);

    // The injected merchant text, quoted (the head of it, at least).
    const injected = bundle.candidate.actions.find((a) => a.type === "merchant_content");
    if (injected?.text) expect(text).toContain(injected.text.slice(0, 40));

    // What the agent attempted: the first privileged.attempt in the ledgers, and the refusal.
    const attempt = bundle.replays.flatMap((r) => r.ledger).find((e) => e.type === "privileged.attempt");
    if (attempt) {
      expect(text).toContain(String(attempt.data.tool));
      expect(text).toContain("The marketplace refused it");
    }

    // How many fresh replays reproduced it, and the statistical caveat.
    const violated = evaluation.summary.replays.filter((r) => r.claimed_rule_violated).length;
    expect(text).toContain(`${violated} of ${evaluation.summary.replays.length}`);
    expect(text).toContain(`the spec requires ${fview.spec.reproducibility.required_violations} of ${fview.spec.reproducibility.replays}`);
    expect(text).toContain("A live model is statistical");

    // Settled and withdrawn, with the recorded transaction hashes.
    const settle = fview.transactions.find((t) => t.kind === "settle" && t.status === "confirmed" && t.detail?.evidence_digest === evaluation.evidence_digest);
    if (settle) {
      expect(text).toContain("Settled:");
      expect(html).toContain(settle.hash);
      const withdraw = fview.transactions.find((t) => t.kind === "withdraw" && t.status === "confirmed");
      if (withdraw) {
        expect(text).toContain("Withdrawn:");
        expect(html).toContain(withdraw.hash);
      }
    }
    const fb = erc.available ? erc.feedback?.find((f) => f.evidence_digest === evaluation.evidence_digest) : undefined;
    if (fb) {
      expect(text).toContain(`agent #${fb.agent_id}`);
      expect(html).toContain(fb.tx);
    }

    // Repair: only a replay on the same adapter counts.
    const sameFamily = regs.filter((r) => r.target_key.startsWith(`${fview.spec.target.adapter}@`) && r.target_key !== `${fview.spec.target.adapter}@${fview.spec.target.version}`);
    if (sameFamily.length === 0) expect(text).toContain("Repair: not yet replayed for this agent");
    else expect(text).toContain(`Replayed on ${sameFamily[0].target_key}`);

    // How to inspect, with static links; digests behind a disclosure; nothing that starts a run.
    const links = hrefs(html);
    expect(links).toContain(`/evaluations/${evaluation.id}`);
    expect(links).toContain(`/challenges/${fid}/settlement`);
    expect(links).toContain(`/snapshot/api/specs/${fview.spec_digest.replace(/:/g, "_")}.json`);
    expect(links).toContain(DEFAULT_SOURCE_URL);
    expect(links).toContain(REPRODUCE_DOC_URL);
    expect(REPRODUCE_DOC_URL).toBe("https://github.com/professor-200629/counterproof/blob/main/docs/REPRODUCE.md");
    expect(text).toContain("Run the evaluator yourself");
    expect(text).toContain("Digests and ledgers");
    expect(links.some((h) => h.startsWith("/api/"))).toBe(false);
    expect(buttons(html, /Run|Replay|Start|Submit/)).toEqual([]);

    // Counts: "Funded" is gone; awaiting settlement vs ever funded; the verified split; currencies.
    expect(html).not.toMatch(/<dt[^>]*>Funded<\/dt>/);
    expect(text).toContain("Awaiting settlement");
    expect(text).toContain(`Ever funded ${list.filter((c) => !!c.fund_tx).length} challenges with a recorded funding transaction`);
    expect(text).toMatch(/\d+ on a live-model agent, \d+ on a planted-defect fixture/);
    expect(text).toContain("SYN Prices, budgets and payments inside the invented marketplace");
  });

  it.skipIf(!featuredItem)("before / after never presents another agent family as the repair of the live-model agent", async () => {
    const fid = String(featuredItem!.id);
    const fview = recorded<FeaturedView>(`api/challenges/${fid}.json`);
    const targets = recorded<{ key: string; adapter: string; label: string }[]>("api/targets.json");
    const regs = recorded<unknown[]>(`api/challenges/${fid}/regressions.json`);
    const { CompareView, defaultTargetKey } = await import("@/components/compare/compare-view");
    const adapter = fview.spec.target.adapter;

    // The default "repaired version" is a version of the same adapter, or nothing.
    const key = defaultTargetKey(targets as never, fview as never);
    if (key !== null) expect(key.startsWith(`${adapter}@`)).toBe(true);
    const otherFamilies = targets.filter((t) => t.adapter !== adapter).map((t) => t.key);
    expect(otherFamilies.length).toBeGreaterThan(0); // e.g. ref-purchasing-agent@1.1.0 for llm-purchasing-agent

    const ev = fview.evaluations.find((e) => e.outcome === "verified_violation")!;
    const { text } = render(createElement(CompareView, { challengeId: fid, initial: {} }), {
      data: [
        [qk.challenge(fid), fview],
        [qk.targets, targets],
        [qk.challengeRegressions(fid), regs],
        [qk.evidence(ev.evidence_digest), recorded(`api/evidence/${ev.evidence_digest.replace(/:/g, "_")}.json`)],
      ],
    });
    for (const other of otherFamilies) expect(text).not.toContain(other);
    expect(text).not.toContain("The repaired version resisted");
    if (regs.length === 0) expect(text).toContain("No repaired version of this agent has been replayed yet");
  });
});

interface FeaturedListItem {
  id: number;
  created_at: number;
  fund_tx: string | null;
  target: { label: string; adapter: string };
  counts: { verified: number };
}

interface FeaturedView {
  id: number;
  spec_digest: string;
  attestation: { evaluation_id: string } | null;
  spec: {
    target: { adapter: string; version: string; config: Record<string, unknown> };
    rules: { id: string; statement: string }[];
    reproducibility: { replays: number; required_violations: number };
  };
  evaluations: {
    id: string;
    outcome: string | null;
    created_at: number;
    evidence_digest: string;
    summary: { rule: { rule_id: string }; replays: { claimed_rule_violated: boolean }[] };
  }[];
  transactions: { kind: string; status: string; hash: string; detail: Record<string, unknown> | null }[];
}

interface FeaturedBundle {
  candidate: { actions: { type: string; text?: string }[] };
  replays: { ledger: { type: string; data: Record<string, unknown> }[] }[];
}

describe("normal mode", () => {
  it("has no snapshot banner and keeps the wallet button", async () => {
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "");
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", "");
    const { AppShell } = await import("@/components/shell/app-shell");
    const { text } = render(createElement(AppShell, null, createElement("p", null, "page")));
    expect(text).not.toContain("Recorded snapshot");
    expect(text).toContain("Connect wallet");
  });

  it.skipIf(!HAVE_SNAPSHOT)("the live replay picker offers only versions of the same agent family", async () => {
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "");
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", "");
    const targets = recorded<{ key: string; adapter: string }[]>("api/targets.json");
    const live = recorded<{ id: number; target: { label: string } }[]>("api/challenges.json").find((c) => c.target.label === "independent-implementation");
    if (!live) return;
    const fid = String(live.id);
    const fview = recorded<{ spec: { target: { adapter: string; version: string } }; evaluations: { outcome: string | null; evidence_digest: string }[] }>(
      `api/challenges/${fid}.json`,
    );
    const adapter = fview.spec.target.adapter;
    const ev = fview.evaluations.find((e) => e.outcome === "verified_violation");
    const { CompareView } = await import("@/components/compare/compare-view");
    const { html, text } = render(createElement(CompareView, { challengeId: fid, initial: { target: targets.find((t) => t.adapter !== adapter)?.key } }), {
      data: [
        [qk.challenge(fid), fview],
        [qk.targets, targets],
        [qk.challengeRegressions(fid), []],
        ...(ev ? ([[qk.evidence(ev.evidence_digest), recorded(`api/evidence/${ev.evidence_digest.replace(/:/g, "_")}.json`)]] as [readonly unknown[], unknown][]) : []),
      ],
    });
    // Even a ?target= of another adapter in the URL is not offered or used.
    for (const t of targets.filter((x) => x.adapter !== adapter)) {
      expect(html).not.toContain(`value="${t.key}"`);
      expect(buttons(html, new RegExp(`Replay against ${t.key.replace(/[.@]/g, "\\$&")}`))).toEqual([]);
    }
    const sameFamily = targets.filter((t) => t.adapter === adapter && t.key !== `${adapter}@${fview.spec.target.version}`);
    if (sameFamily.length === 0) expect(text).toContain(`No repaired version of ${adapter} to replay against`);
  });
});
