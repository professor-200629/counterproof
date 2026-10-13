/**
 * "Renew attestation" is offered only outside snapshot mode.
 *
 * The recorded challenges are all settled or refunded, and server rendering has no clock
 * (useNow is null during SSR), so a test against the recording alone can never see a renew
 * control in either mode. Here the clock is pinned and the recorded live-model challenge is
 * turned back into a funded one whose attestation expired inside its settlement window. The
 * live console then offers renewal on both the settlement page and the evidence page; the
 * read-only snapshot shows the recorded expiry and offers nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChallengeView, Evaluation, Settlement } from "@/lib/api";
import { render } from "@/test/render";

const clock = vi.hoisted(() => ({ ms: null as number | null }));

vi.mock("@/components/ui/time", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/components/ui/time")>();
  return { ...mod, useNow: () => clock.ms };
});

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  notFound: () => {
    throw new Error("notFound");
  },
}));

const PUBLIC = new URL("../../../public/", import.meta.url);
const HAVE_SNAPSHOT = existsSync(new URL("./snapshot/manifest.json", PUBLIC));

function recorded<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(new URL(`./snapshot/${file}`, PUBLIC), "utf8")) as T;
}

/** Recorded challenge #3 as if it had not been settled, one minute after its attestation expired. */
function expiredButFunded() {
  const view = recorded<ChallengeView>("api/challenges/3.json");
  const settlement = recorded<Settlement>("api/challenges/3/settlement.json");
  const attestation = settlement.attestation!;
  const deadline = settlement.onchain!.settlement_deadline;
  const nowSec = attestation.expiry + 60;
  expect(nowSec).toBeLessThan(deadline); // still inside the settlement window
  clock.ms = nowSec * 1000;
  return {
    view: { ...view, status: "funded" } as ChallengeView,
    settlement: {
      ...settlement,
      challenge: { ...settlement.challenge, status: "funded" },
      onchain: { ...settlement.onchain!, status: "funded", settled_submission: `0x${"00".repeat(32)}` },
    } as Settlement,
  };
}

async function renderPages(snapshot: boolean) {
  vi.resetModules();
  if (snapshot) {
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "1");
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", readFileSync(new URL("./snapshot/manifest.json", PUBLIC), "utf8"));
  }
  const { view, settlement } = expiredButFunded();
  const { SettlementView } = await import("./settlement-view");
  const { EvidenceViewer } = await import("@/components/evidence/evidence-viewer");
  const { qk } = await import("@/lib/queries");
  const config = recorded("api/config.json");
  const settlementPage = render(createElement(SettlementView, { challengeId: "3" }), {
    data: [
      [qk.challenge("3"), view],
      [qk.settlement("3"), settlement],
      [qk.config, config],
    ],
  });
  const evaluationId = settlement.attestation!.evaluation_id;
  const ev = recorded<Evaluation>(`api/evaluations/${evaluationId}.json`);
  const evidencePage = render(createElement(EvidenceViewer, { id: ev.id }), {
    data: [
      [qk.evaluation(ev.id), ev],
      [qk.challenge("3"), view],
      [qk.evidence(ev.evidence_digest!), recorded(`api/evidence/${ev.evidence_digest!.replace(/:/g, "_")}.json`)],
      [qk.config, config],
    ],
  });
  return { settlementPage, evidencePage };
}

describe.skipIf(!HAVE_SNAPSHOT)("renewing an expired attestation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    clock.ms = null;
  });

  it("the live console offers Renew attestation on the settlement and evidence pages", async () => {
    const { settlementPage, evidencePage } = await renderPages(false);
    expect(settlementPage.text).toContain("Renew the attestation");
    expect(settlementPage.text).toContain("Renew attestation");
    expect(settlementPage.text).toContain("so it can be renewed below");
    expect(evidencePage.text).toContain("Renew attestation");
  });

  it("the read-only snapshot shows the recorded expiry and no renew control or prompt", async () => {
    const { settlementPage, evidencePage } = await renderPages(true);
    expect(settlementPage.text).toContain("The attestation expired before anyone relayed it.");
    for (const page of [settlementPage, evidencePage]) {
      expect(page.text).not.toContain("Renew attestation");
      expect(page.text).not.toContain("Renew the attestation");
      expect(page.text).not.toMatch(/can be renewed/);
      expect(page.text).not.toContain("Renewing an attestation");
    }
  });
});
