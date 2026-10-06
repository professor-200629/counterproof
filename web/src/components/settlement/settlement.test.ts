import { describe, expect, it } from "vitest";
import type { ActivityEntry, ChainTransaction, ChallengeView, Evaluation, SettlementAttestation } from "@/lib/api";
import { commitTxFor, currentAttestation, failedAttempts, isPayableVerdict, pickSettlementEvaluation, txsOfKind } from "./derive";
import { recoverAttestationSigner } from "./recover";

/**
 * Produced by the backend's own signer (counterproof.signer.sign_attestation) with anvil's
 * public dev key #1, so the browser-side recovery is checked against the Python encoding.
 */
const PY_SIGNED: Pick<SettlementAttestation, "typed_data" | "signature"> = {
  signature:
    "0xa63daf9bed30b9a0cca9a37389cbe77afc3d0b1c0fc0e5352ad0202978244ebb65f47d23a8efb817dfaec9b0246ddc08873fc402cb3214ac4863d5341a7a0a711c",
  typed_data: {
    domain: { name: "CounterProof", version: "1", chainId: 31337, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" },
    types: {
      Attestation: [
        { name: "challengeId", type: "uint256" },
        { name: "specDigest", type: "bytes32" },
        { name: "submissionId", type: "bytes32" },
        { name: "candidateDigest", type: "bytes32" },
        { name: "evidenceDigest", type: "bytes32" },
        { name: "challenger", type: "address" },
        { name: "recipient", type: "address" },
        { name: "verdict", type: "uint8" },
        { name: "expiry", type: "uint64" },
      ],
    },
    primaryType: "Attestation",
    message: {
      challengeId: 3,
      specDigest: `0x${"c7".repeat(32)}`,
      submissionId: `0x${"5a".repeat(32)}`,
      candidateDigest: `0x${"8e".repeat(32)}`,
      evidenceDigest: `0x${"11".repeat(32)}`,
      challenger: "0x000000000000000000000000000000000000c0de",
      recipient: "0x000000000000000000000000000000000000c0de",
      verdict: 1,
      expiry: 1791291836,
    },
  },
};

describe("recoverAttestationSigner", () => {
  it("recovers the backend signer's address from its typed data", async () => {
    expect(await recoverAttestationSigner(PY_SIGNED)).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });

  it("recovers a different address when any message field is changed", async () => {
    const tampered = {
      ...PY_SIGNED,
      typed_data: { ...PY_SIGNED.typed_data, message: { ...PY_SIGNED.typed_data.message, recipient: "0x00000000000000000000000000000000000000aa" } },
    };
    expect(await recoverAttestationSigner(tampered)).not.toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });
});

function ev(partial: Partial<Evaluation> & { id: string }): Evaluation {
  return {
    challenge_id: 1,
    submission_id: `0x${"5a".repeat(32)}`,
    job_id: null,
    status: "verified_violation",
    outcome: "verified_violation",
    evidence_digest: null,
    summary: null,
    created_at: 100,
    finished_at: 101,
    challenger: "0xc0de",
    recipient: "0xc0de",
    commit_tx: null,
    source: "chain",
    candidate_id: null,
    ...partial,
  };
}

function tx(partial: Partial<ChainTransaction> & { hash: string; kind: ChainTransaction["kind"] }): ChainTransaction {
  return {
    chain_id: 31337,
    status: "confirmed",
    challenge_id: 1,
    from_addr: null,
    detail: null,
    block_number: 1,
    error: null,
    created_at: 1,
    updated_at: 1,
    ...partial,
  };
}

const ATT = { ...PY_SIGNED, signer: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", expiry: 1791291836, evaluation_id: "eval_old" };

function view(partial: Partial<ChallengeView>): ChallengeView {
  return { evaluations: [], transactions: [], activity: [], attestation: null, candidates: [], ...partial } as unknown as ChallengeView;
}

describe("settlement derivations", () => {
  it("follows the attested evaluation, otherwise the latest committed verified violation", () => {
    const v = view({
      evaluations: [
        ev({ id: "eval_old", created_at: 10 }),
        ev({ id: "eval_new", created_at: 20 }),
        ev({ id: "eval_offchain", created_at: 30, source: "offchain" }),
      ],
    });
    expect(pickSettlementEvaluation(v, ATT)?.id).toBe("eval_old");
    expect(pickSettlementEvaluation(v, null)?.id).toBe("eval_new");
    expect(pickSettlementEvaluation(view({}), null)).toBeNull();
  });

  it("falls back to the challenge view's attestation row", () => {
    const row = { ...ATT, id: "att_1", challenge_id: 1, submission_id: "0x", created_at: 1 };
    const s = { challenge: {} as never, attestation: null, onchain: null, explorer_template: null };
    expect(currentAttestation(s, view({ attestation: row }))?.evaluation_id).toBe("eval_old");
    expect(currentAttestation(s, view({}))).toBeNull();
  });

  it("orders transactions newest first and finds the commit by submission id", () => {
    const txs = [
      tx({ hash: "0x1", kind: "settle", status: "failed", updated_at: 5 }),
      tx({ hash: "0x2", kind: "settle", updated_at: 9 }),
      tx({ hash: "0x3", kind: "commit", detail: { submission_id: `0x${"5a".repeat(32)}` } }),
    ];
    expect(txsOfKind(txs, "settle").map((t) => t.hash)).toEqual(["0x2", "0x1"]);
    expect(commitTxFor(view({ transactions: txs }), ev({ id: "e" }))?.hash).toBe("0x3");
  });

  it("only a verified, reward-eligible verdict is payable", () => {
    const summary = { outcome: "verified_violation" as const, reason: "", summary: null, rule: null, reward_eligible: true, replays: [] };
    expect(isPayableVerdict(ev({ id: "a", summary }))).toBe(true);
    expect(isPayableVerdict(ev({ id: "b", summary: { ...summary, reward_eligible: false } }))).toBe(false);
    expect(isPayableVerdict(ev({ id: "c", summary: { previous_attempts: [] } }))).toBe(false);
  });

  it("lists wallet attempts that never produced a transaction", () => {
    const entries: ActivityEntry[] = [
      { id: 1, challenge_id: 1, kind: "settle.failed", message: "settle not sent: user rejected", ref: null, created_at: 1 },
      { id: 2, challenge_id: 1, kind: "settle.confirmed", message: "Settled", ref: "0x", created_at: 2 },
      { id: 3, challenge_id: 1, kind: "withdraw.failed", message: "withdraw not sent: rpc down", ref: null, created_at: 3 },
    ];
    expect(failedAttempts(entries, ["settle"]).map((e) => e.id)).toEqual([1]);
  });

  it("does not list a mined-and-reverted transaction as 'not sent'", () => {
    const reverted = `0x${"ab".repeat(32)}`;
    const entries: ActivityEntry[] = [
      // backend verify_tx: the transaction was mined and reverted (the recorded tx list shows it with its block)
      { id: 4, challenge_id: 1, kind: "settle.failed", message: "settle transaction reverted on Local anvil (31337)", ref: reverted, created_at: 4 },
      // backend record_failed_tx: a wallet replacement cancelled the call (hash ref, but never executed)
      { id: 5, challenge_id: 1, kind: "settle.failed", message: "settle not sent: cancelled in wallet: replacement 0x1 took the nonce", ref: reverted, created_at: 5 },
    ];
    expect(failedAttempts(entries, ["settle"]).map((e) => e.id)).toEqual([5]);
  });
});
