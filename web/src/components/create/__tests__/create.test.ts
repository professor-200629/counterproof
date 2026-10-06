import { describe, expect, it } from "vitest";
import { encodeErrorResult } from "viem";
import { counterProofAbi } from "@/lib/abi";
import type { RuleTemplate, SpecResponse, Target } from "@/lib/api";
import { canonicalJson, localDigest } from "../canonical";
import { decodeContractError, errorNameFromReason, explainCreateChallengeError } from "../contract-errors";
import {
  PLACEHOLDER_PUBLISHER,
  buildPreviewRequest,
  defaultRuleDraft,
  fromLocalInputValue,
  hasErrors,
  initialDraft,
  paramErrors,
  publisherPlan,
  ruleIdFor,
  termsErrors,
  toLocalInputValue,
  type Draft,
} from "../draft";
import fixtures from "./fixtures.json";

const targets = fixtures.targets as Target[];
const templates = fixtures.ruleTemplates as unknown as RuleTemplate[];
const preview = fixtures.specPreview as unknown as SpecResponse;
const fixture = targets.find((t) => t.label === "intentionally-vulnerable-fixture")!;
const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NOW = 1_791_288_000;

function draft(patch: Partial<Draft> = {}): Draft {
  return { ...initialDraft, targetKey: fixture.key, submissionDeadline: NOW + 1800, ...patch };
}

/** `connected: null` = no wallet connected. */
function build(d: Draft, offchain = false, connected: string | null = WALLET) {
  const publisher = publisherPlan(d, offchain, connected ?? undefined);
  const errors = termsErrors(d, { target: fixture, templates, offchain, publisher, nowSec: NOW });
  return { errors, req: buildPreviewRequest(d, { target: fixture, templates, offchain, publisher, termsValid: !hasErrors(errors) }) };
}

describe("canonical digest", () => {
  it("recomputes the backend's digest for a real spec preview", async () => {
    expect(await localDigest(preview.spec)).toBe(preview.digest);
  });
  it("sorts keys, drops whitespace and refuses floats", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
  });
});

describe("spec request", () => {
  it("defaults to all five templates with the documented parameters, on chain", () => {
    const { req, errors } = build(draft());
    expect(hasErrors(errors)).toBe(false);
    expect(req?.final).toBe(true);
    const body = req!.body;
    expect(body.target).toBe("ref-purchasing-agent@1.0.0");
    expect(body.rules.map((r) => r.template)).toEqual(templates.map((t) => t.id));
    expect(body.rules[0].params).toEqual({ budget: 25000 });
    expect(body.rules[1].params).toEqual({ merchants: ["m_acme", "m_bolt", "m_crate"] });
    expect(body.rules[4].params).toEqual({ tools: ["update_mandate", "add_payee"] });
    expect(body.eligible_rules).toEqual(["R1", "R2", "R3", "R4", "R5"]);
    expect(body.reward_wei).toBe("10000000000000000");
    expect(body.settlement_deadline - body.submission_deadline).toBe(30 * 60);
    expect(body.publisher).toBe(WALLET.toLowerCase());
    expect(body.offchain).toBe(false);
  });

  it("matches the fields of a real preview built from the same choices", () => {
    const d = draft({
      title: preview.spec.title,
      submissionDeadline: preview.spec.deadlines.submission_deadline,
      windowMinutes: (preview.spec.deadlines.settlement_deadline - preview.spec.deadlines.submission_deadline) / 60,
    });
    const { req } = build(d, true, preview.spec.publisher.address);
    const body = req!.body;
    expect(body.title).toBe(preview.spec.title);
    expect(body.rules.map((r) => r.params)).toEqual(preview.spec.rules.map((r) => r.params));
    expect(body.eligible_rules).toEqual(preview.spec.reward.eligible_rules);
    expect(body.settlement_deadline).toBe(preview.spec.deadlines.settlement_deadline);
    expect(body.reward_wei).toBe(preview.spec.reward.amount_wei);
  });

  it("never offers a stand-in publisher as final", () => {
    const { req, errors } = build(draft(), false, null);
    expect(errors.publisher).toBeTruthy();
    expect(req?.final).toBe(false);
    expect(req?.body.publisher).toBe(PLACEHOLDER_PUBLISHER);
  });

  it("off-chain sends a zero reward and accepts a typed publisher", () => {
    const { req, errors } = build(draft({ manualPublisher: WALLET.toLowerCase(), rewardMon: "" }), true, null);
    expect(hasErrors(errors)).toBe(false);
    expect(req?.final).toBe(true);
    expect(req?.body.reward_wei).toBe("0");
    expect(req?.body.offchain).toBe(true);
  });

  it("numbers rules by selection order", () => {
    const first = templates[0];
    const d = draft({ rules: { [first.id]: { ...defaultRuleDraft(first), enabled: false } } });
    expect(ruleIdFor(d, templates, templates[1].id)).toBe("R1");
    expect(build(d).req?.body.rules).toHaveLength(templates.length - 1);
  });
});

describe("validation", () => {
  it("rejects a zero on-chain reward, short windows, past deadlines and no eligible rule", () => {
    const allIneligible = Object.fromEntries(templates.map((t) => [t.id, { ...defaultRuleDraft(t), eligible: false }]));
    const { errors, req } = build(draft({ rewardMon: "0", windowMinutes: 4, submissionDeadline: NOW - 60, rules: allIneligible }));
    expect(errors.reward).toMatch(/ZeroReward/);
    expect(errors.window).toMatch(/5 minutes/);
    expect(errors.submissionDeadline).toMatch(/passed/);
    expect(errors.eligible).toBeTruthy();
    expect(req?.final).toBe(false);
  });

  it("rejects windows over 30 days and submission periods over 90 days on chain", () => {
    const { errors } = build(draft({ windowMinutes: 30 * 24 * 60 + 1, submissionDeadline: NOW + 91 * 86400 }));
    expect(errors.window).toMatch(/30 days/);
    expect(errors.submissionDeadline).toMatch(/90 days/);
  });

  it("checks rule parameters like the backend schema", () => {
    const cap = templates.find((t) => t.id === "spend.cumulative_cap")!;
    const allow = templates.find((t) => t.id === "payee.allowlist")!;
    expect(paramErrors(cap, { ...defaultRuleDraft(cap), params: { budget: 0 } }).budget).toBeTruthy();
    expect(paramErrors(cap, { ...defaultRuleDraft(cap), params: { budget: 1 } }).budget).toBeUndefined();
    expect(paramErrors(allow, { ...defaultRuleDraft(allow), params: { merchants: [] } }).merchants).toBeTruthy();
    const { req } = build(draft({ rules: { [allow.id]: { ...defaultRuleDraft(allow), params: { merchants: [] } } } }));
    expect(req).toBeNull();
  });
});

describe("contract errors", () => {
  it("decodes raw revert bytes with the CounterProof ABI", () => {
    const data = encodeErrorResult({ abi: counterProofAbi, errorName: "SettlementWindowTooShort", args: [BigInt(60), BigInt(300)] });
    const decoded = decodeContractError({ shortMessage: "reverted", cause: { data } });
    expect(decoded?.name).toBe("SettlementWindowTooShort");
    expect(explainCreateChallengeError(decoded!.name, decoded!.args)).toMatch(/1 min.*5-minute/);
  });
  it("reads viem's already-decoded error and errorReason text", () => {
    expect(decodeContractError({ cause: { data: { errorName: "ZeroReward", args: [] } } })?.name).toBe("ZeroReward");
    expect(errorNameFromReason("Contract reverted: SubmissionDeadlineNotInFuture")).toBe("SubmissionDeadlineNotInFuture");
    expect(errorNameFromReason("User rejected")).toBeNull();
  });
});

describe("deadline input", () => {
  it("round-trips local datetime values at minute precision", () => {
    const sec = 1_791_291_840; // whole minute
    expect(fromLocalInputValue(toLocalInputValue(sec))).toBe(sec);
    expect(fromLocalInputValue("")).toBeNull();
  });
});
