/**
 * The attestation as the console shows it now that the evaluator's signer replays every
 * submission itself and signs the digest of its OWN evidence bundle: which digest the signed
 * evidenceDigest is compared with, the signer's k-of-n summary, the asynchronous request
 * (202 queued / verifying), renewal of an expired attestation, and older recorded
 * attestations (the Monad testnet run), which signed the worker's evaluation digest and must
 * still display as matching.
 */
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEntry, ChallengeView, Evaluation, Job, SettlementAttestation, SignerVerification } from "@/lib/api";
import { isAttestQueued } from "@/lib/api";
import { render } from "@/test/render";
import {
  attestationJobOutcome,
  attestedEvidence,
  canRenewAttestation,
  latestAttestationNote,
  verificationSummary,
} from "./derive";

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

const VERIFIED: SignerVerification = {
  by: "evaluator signer",
  status: "verified",
  outcome: "verified_violation",
  reason: "claimed rule violated in 2 of 3 replays",
  mode: "stochastic",
  replays: 3,
  replays_done: 3,
  violated: 2,
  required: 2,
  evidence_digest: `sha256:${"ab".repeat(32)}`,
  attempt: 1,
  started_at: 1000,
  finished_at: 1240,
  worker_evaluation_id: "eval_worker",
  worker_evidence_digest: `sha256:${"cd".repeat(32)}`,
};

function job(partial: Partial<Job>): Job {
  return {
    id: "job_att",
    kind: "attestation",
    status: "running",
    params: { evaluation_id: "eval_1", challenge_id: 3 },
    result: null,
    error: null,
    attempts: 1,
    max_attempts: 2,
    cancel_requested: 0,
    worker: "w",
    heartbeat_at: 100,
    created_at: 100,
    started_at: 100,
    finished_at: null,
    ...partial,
  };
}

const funded = { status: "funded", spec: { deadlines: { submission_deadline: 5_000, settlement_deadline: 10_000 } } } as unknown as ChallengeView;

describe("attested evidence and renewal (pure)", () => {
  it("compares with the signer's own bundle when the attestation names one, else with the evaluation (older attestations)", () => {
    expect(attestedEvidence({ evidence_digest: VERIFIED.evidence_digest }, "sha256:worker")).toEqual({
      digest: VERIFIED.evidence_digest,
      source: "signer",
    });
    expect(attestedEvidence({}, "sha256:worker")).toEqual({ digest: "sha256:worker", source: "evaluation" });
    expect(attestedEvidence({ evidence_digest: null }, null)).toEqual({ digest: null, source: "evaluation" });
  });

  it("summarises the signer's own k-of-n replays", () => {
    expect(verificationSummary(VERIFIED)).toBe("2 of 3 fresh live-model replays by the signer violated the rule (2 required)");
    expect(verificationSummary({ ...VERIFIED, status: "verifying", violated: null, replays_done: 1 })).toBe(
      "the signer is running 3 fresh live-model replays of its own (1 done); at least 2 must violate the rule",
    );
    expect(verificationSummary({ ...VERIFIED, mode: "deterministic", replays: 2, violated: 2 })).toContain("2 of 2 fresh replays");
    expect(verificationSummary(null)).toBeNull();
  });

  it("offers renewal only for an expired or expiring attestation of a funded challenge inside its window", () => {
    expect(canRenewAttestation(funded, { expiry: 3_600 }, null, 3_700)).toBe(true); // expired, window open
    expect(canRenewAttestation(funded, { expiry: 3_600 }, null, 3_400)).toBe(true); // 200 s left < 300 s margin
    expect(canRenewAttestation(funded, { expiry: 3_600 }, null, 1_000)).toBe(false); // plenty of time left
    expect(canRenewAttestation(funded, { expiry: 3_600 }, null, 10_001)).toBe(false); // settlement deadline passed
    expect(canRenewAttestation(funded, { expiry: 10_000 }, null, 9_900)).toBe(false); // already ends at the deadline
    expect(canRenewAttestation({ ...funded, status: "settled" } as ChallengeView, { expiry: 3_600 }, null, 3_700)).toBe(false);
    expect(
      canRenewAttestation(funded, { expiry: 3_600 }, { status: "refunded", settlement_deadline: 10_000 }, 3_700),
    ).toBe(false);
    expect(canRenewAttestation(funded, { expiry: 3_600 }, { status: "funded", settlement_deadline: 3_650 }, 3_700)).toBe(false);
    expect(canRenewAttestation(funded, { expiry: 3_600 }, null, null)).toBe(false); // server render: unknown time
    expect(canRenewAttestation(funded, null, null, 3_700)).toBe(false);
  });

  it("reads what the attestation job last heard from the signer", () => {
    expect(attestationJobOutcome(job({ status: "done", result: { status: "refused", refused: ["not reproduced", "x"] } }))).toEqual({
      status: "refused",
      verification: null,
      detail: "not reproduced; x",
    });
    const pending = attestationJobOutcome(job({ result: { status: "pending", verification: VERIFIED as never } }));
    expect(pending.status).toBe("pending");
    expect(pending.verification?.replays).toBe(3);
    expect(attestationJobOutcome(null)).toEqual({ status: null, verification: null, detail: null });
  });

  it("tells a queued (202) answer from an attestation (200)", () => {
    expect(isAttestQueued({ status: "queued", job_id: "j", evaluation_id: "e", job: null, attestation: null })).toBe(true);
    expect(isAttestQueued({ id: "att_1" } as never)).toBe(false);
  });

  it("surfaces refused and failed signer requests as the latest attestation note", () => {
    const entries = [
      { id: 1, kind: "attestation.pending", message: "old", ref: "eval_1", created_at: 10, challenge_id: 3 },
      { id: 2, kind: "attestation.refused", message: "The evaluator's signer refused: not reproduced", ref: "eval_1", created_at: 20, challenge_id: 3 },
      { id: 3, kind: "attestation.failed", message: "other evaluation", ref: "eval_2", created_at: 30, challenge_id: 3 },
    ] as ActivityEntry[];
    expect(latestAttestationNote(entries, "eval_1")?.kind).toBe("attestation.refused");
  });
});

describe("the signer's request, rendered", () => {
  it("shows that the signer is independently replaying while the request runs", async () => {
    const { SignerJobStatus } = await import("./attestation-request");
    const live = render(createElement(SignerJobStatus, { job: job({ result: { status: "pending", verification: { ...VERIFIED, status: "verifying", violated: null, replays_done: 1 } as never } }), liveModel: true }));
    expect(live.text).toContain("The evaluator's signer is independently replaying");
    expect(live.text).toContain("several minutes");
    expect(live.text).toContain("1 done");
    const refused = render(createElement(SignerJobStatus, { job: job({ status: "done", finished_at: 200, result: { status: "refused", refused: ["the signer's own replays did not verify the violation: not_reproduced"] } }), liveModel: true }));
    expect(refused.text).toContain("The signer refused to attest");
    expect(refused.text).toContain("did not verify the violation");
    const failed = render(createElement(SignerJobStatus, { job: job({ status: "done", result: { status: "failed", detail: "model provider unavailable" } }), liveModel: true }));
    expect(failed.text).toContain("not a verdict about the agent");
    expect(render(createElement(SignerJobStatus, { job: job({ status: "done", result: { status: "signed" } }), liveModel: true })).text).toBe("");
  });

  it("offers Renew attestation, disabled while a request is already running", async () => {
    const { AttestationRequestButton } = await import("./attestation-request");
    const idle = render(createElement(AttestationRequestButton, { challengeId: 3, evaluationId: "eval_1", job: null, renew: true, liveModel: true }));
    expect(idle.text).toContain("Renew attestation");
    const busy = render(createElement(AttestationRequestButton, { challengeId: 3, evaluationId: "eval_1", job: job({}), renew: true, liveModel: true }));
    expect(busy.html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*Renew attestation/);
  });
});

describe.skipIf(!HAVE_SNAPSHOT)("attestation details against the recorded live-model challenge", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const view = HAVE_SNAPSHOT ? recorded<ChallengeView>("api/challenges/3.json") : (null as unknown as ChallengeView);
  const legacy = HAVE_SNAPSHOT ? recorded<{ attestation: SettlementAttestation }>("api/challenges/3/settlement.json").attestation : null;
  const evaluation = HAVE_SNAPSHOT ? (view.evaluations.find((e) => e.id === legacy?.evaluation_id) as Evaluation) : null;

  async function details(attestation: SettlementAttestation) {
    const { AttestationDetails } = await import("./attestation-details");
    return render(createElement(AttestationDetails, { attestation, view, evaluation, onchain: null, configEvaluator: null }));
  }

  it("an older attestation (signed over the worker's evaluation digest) still displays as matching", async () => {
    const { text } = await details(legacy!);
    expect(text).toContain("evidenceDigest bytes32");
    expect(text).toMatch(/evidenceDigest bytes32 0x06419a1e…78f5a5 matches the evidence bundle/);
    expect(text).not.toContain("Signer's own replay");
  });

  it("a current attestation is compared with the signer's own bundle and shows its k-of-n", async () => {
    const own = `sha256:${legacy!.typed_data.message.evidenceDigest.slice(2)}`;
    const current = { ...legacy!, evidence_digest: own, verification: { ...VERIFIED, evidence_digest: own } };
    const { text, html } = await details(current);
    expect(text).toContain("matches the signer's own verification bundle");
    expect(text).toContain("2 of 3 fresh live-model replays by the signer violated the rule (2 required)");
    expect(html).toContain(`/api/evidence/${encodeURIComponent(own)}?download=true`);
    const forged = { ...current, evidence_digest: `sha256:${"ef".repeat(32)}` };
    expect((await details(forged)).text).toContain("differs from the signer's own verification bundle");
  });

  it("snapshot mode renders the recorded settlement and evidence unchanged: legacy match, no renew control", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "1");
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", readFileSync(new URL("./snapshot/manifest.json", PUBLIC), "utf8"));
    const { SettlementView } = await import("./settlement-view");
    const { qk: snapQk } = await import("@/lib/queries");
    const settlement = render(createElement(SettlementView, { challengeId: "3" }), {
      data: [
        [snapQk.challenge("3"), view],
        [snapQk.settlement("3"), recorded("api/challenges/3/settlement.json")],
        [snapQk.config, recorded("api/config.json")],
      ],
    });
    expect(settlement.text).toContain("matches the evidence bundle");
    expect(settlement.text).not.toContain("Renew attestation");
    expect(settlement.text).not.toContain("independently replaying");

    const { EvidenceViewer } = await import("@/components/evidence/evidence-viewer");
    const ev = recorded<Evaluation>(`api/evaluations/${evaluation!.id}.json`);
    const digestFile = ev.evidence_digest!.replace(/:/g, "_");
    const evidence = render(createElement(EvidenceViewer, { id: ev.id }), {
      data: [
        [snapQk.evaluation(ev.id), ev],
        [snapQk.challenge("3"), view],
        [snapQk.evidence(ev.evidence_digest!), recorded(`api/evidence/${digestFile}.json`)],
        [snapQk.config, recorded("api/config.json")],
      ],
    });
    expect(evidence.text).toContain("matches this evidence bundle");
    expect(evidence.text).not.toContain("Renew attestation");
    expect(evidence.text).toContain("credited"); // the recorded settle event still answers "Was the reward paid?"
  });
});
