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

describe.skipIf(!HAVE_SNAPSHOT)("snapshot mode, rendered from public/snapshot", () => {
  const manifest = HAVE_SNAPSHOT ? (JSON.parse(manifestText) as { taken_at: number; network_label: string; challenges_included: number[] }) : null;
  const id = String(manifest?.challenges_included[0] ?? 0);
  const config = HAVE_SNAPSHOT ? recorded("api/config.json") : null;
  const view = HAVE_SNAPSHOT ? recorded<View>(`api/challenges/${id}.json`) : (null as unknown as View);

  it("the shell carries the banner and the recorded network, and has no wallet button", async () => {
    const { AppShell } = await import("@/components/shell/app-shell");
    const { snapshotBannerText } = await import("@/lib/snapshot");
    const { formatUnix } = await import("@/lib/format");
    const { text } = render(createElement(AppShell, null, createElement("p", null, "page")), { data: [[qk.config, config]] });
    expect(text).toContain(snapshotBannerText(JSON.parse(manifestText)));
    expect(text).toContain(`Taken ${formatUnix(manifest!.taken_at, { utc: true })}`);
    expect(text).toContain(manifest!.network_label);
    expect(text).toContain("How to run it yourself");
    expect(text).toContain("Local anvil (31337) - not Monad");
    expect(text).not.toMatch(/Connect wallet/);
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
      expect(text).toContain("local anvil chain - not reachable from this hosted snapshot; values below are as recorded");
      expect(text).not.toContain("read live from the contract");
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
});

describe("normal mode", () => {
  it("has no snapshot banner and keeps the wallet button", async () => {
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "");
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", "");
    const { AppShell } = await import("@/components/shell/app-shell");
    const { text } = render(createElement(AppShell, null, createElement("p", null, "page")));
    expect(text).not.toContain("Recorded snapshot");
    expect(text).toContain("Connect wallet");
  });
});
