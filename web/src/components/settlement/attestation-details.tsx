"use client";

import { ShieldQuestion } from "lucide-react";
import type { ReactNode } from "react";
import { Address } from "@/components/ui/address";
import { Callout } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { MatchMark } from "@/components/ui/match-mark";
import { Countdown, DateTime } from "@/components/ui/time";
import { TrustStatement } from "@/components/truth";
import type { ChallengeView, Evaluation, OnchainChallenge, SettlementAttestation } from "@/lib/api";
import { digestMatchesBytes32, txNetworkPhrase } from "@/lib/chain";
import { sameHex } from "@/lib/format";
import { useRecoveredSigner } from "./use-recovered-signer";

export interface AttestationDetailsProps {
  attestation: SettlementAttestation;
  view: ChallengeView;
  evaluation: Evaluation | null;
  onchain: OnchainChallenge | null;
  /** Evaluator address from /api/config (what the shell's trust note shows). */
  configEvaluator: string | null | undefined;
}

/** Signer, expiry, signature and the full typed-data message, each compared with what it should bind. */
export function AttestationDetails({ attestation, view, evaluation, onchain, configEvaluator }: AttestationDetailsProps) {
  const td = attestation.typed_data;
  const m = td.message;
  const declared = view.spec.evaluator.address;
  const signerCheck = sameHex(attestation.signer, declared);
  const recovered = useRecoveredSigner(attestation);
  const candidateDigest =
    evaluation?.candidate_digest ?? view.candidates.find((c) => c.id === evaluation?.candidate_id)?.digest ?? null;

  const rows: { name: string; type: string; value: ReactNode; check: ReactNode }[] = [
    {
      name: "challengeId",
      type: "uint256",
      value: <span className="font-mono text-xs tabular">{String(m.challengeId)}</span>,
      check: (
        <MatchMark
          ok={view.onchain_id ? String(m.challengeId) === view.onchain_id : null}
          subject={view.onchain_id ? `on-chain challenge #${view.onchain_id}` : "the on-chain challenge id"}
        />
      ),
    },
    {
      name: "specDigest",
      type: "bytes32",
      value: <Digest value={m.specDigest} label="attested spec digest" />,
      check: <MatchMark ok={digestMatchesBytes32(m.specDigest, view.spec_digest)} subject={"this challenge's spec digest"} />,
    },
    {
      name: "submissionId",
      type: "bytes32",
      value: <Digest value={m.submissionId} label="attested submission id" />,
      check: <MatchMark ok={sameHex(m.submissionId, evaluation?.submission_id)} subject="the committed submission" />,
    },
    {
      name: "candidateDigest",
      type: "bytes32",
      value: <Digest value={m.candidateDigest} label="attested candidate digest" />,
      check: <MatchMark ok={digestMatchesBytes32(m.candidateDigest, candidateDigest)} subject="the replayed candidate" />,
    },
    {
      name: "evidenceDigest",
      type: "bytes32",
      value: <Digest value={m.evidenceDigest} label="attested evidence digest" />,
      check: <MatchMark ok={digestMatchesBytes32(m.evidenceDigest, evaluation?.evidence_digest)} subject="the evidence bundle" />,
    },
    {
      name: "challenger",
      type: "address",
      value: <Address value={m.challenger} label="challenger" />,
      check: <MatchMark ok={sameHex(m.challenger, evaluation?.challenger)} subject="the committed challenger" />,
    },
    {
      name: "recipient",
      type: "address",
      value: <Address value={m.recipient} label="recipient" />,
      check: <MatchMark ok={sameHex(m.recipient, evaluation?.recipient)} subject="the recipient bound at commit" />,
    },
    {
      name: "verdict",
      type: "uint8",
      value: (
        <span className="text-xs">
          <span className="font-mono tabular">{String(m.verdict)}</span>{" "}
          <span className="text-muted">{Number(m.verdict) === 1 ? "(verified violation)" : "(not a payable verdict)"}</span>
        </span>
      ),
      check: <MatchMark ok={Number(m.verdict) === 1} subject="VERDICT_VERIFIED_VIOLATION (1)" />,
    },
    {
      name: "expiry",
      type: "uint64",
      value: (
        <span className="text-xs">
          <span className="font-mono tabular">{String(m.expiry)}</span> <DateTime ts={Number(m.expiry)} className="text-muted" />
        </span>
      ),
      check: <MatchMark ok={Number(m.expiry) === attestation.expiry} subject="the stored expiry" />,
    },
  ];

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr]">
        <dt className="text-muted">Signer</dt>
        <dd className="min-w-0 space-y-1">
          <Address value={attestation.signer} label="attestation signer" />
          <div>
            <MatchMark
              ok={signerCheck}
              subject={
                <>
                  the declared evaluator in the spec (<span className="font-mono">{declared}</span>)
                </>
              }
            />
          </div>
          {onchain ? (
            <div>
              <MatchMark ok={sameHex(attestation.signer, onchain.evaluator)} subject="the evaluator recorded in the contract for this challenge" />
            </div>
          ) : null}
          {configEvaluator && sameHex(configEvaluator, declared) === false ? (
            <p className="text-xs text-warn">
              The backend&apos;s configured evaluator ({configEvaluator}) is not the one declared in this spec.
            </p>
          ) : null}
        </dd>

        <dt className="text-muted">Signature check</dt>
        <dd className="min-w-0 text-xs">
          {recovered.isPending ? (
            <span className="text-muted">Recovering the signer from the signature in this browser.</span>
          ) : recovered.isError ? (
            <span className="text-bad">
              Could not recover a signer from this signature: {recovered.error instanceof Error ? recovered.error.message.split("\n")[0] : "unknown error"}
            </span>
          ) : (
            <span className="space-y-0.5">
              <span className="block">
                Recovered in this browser from the typed data and signature: <span className="font-mono">{recovered.data}</span>
              </span>
              <MatchMark ok={sameHex(recovered.data, attestation.signer)} subject="the reported signer" />
            </span>
          )}
        </dd>

        <dt className="text-muted">Expiry</dt>
        <dd className="min-w-0 text-sm">
          <Countdown to={attestation.expiry} prefix="Expires in" expiredText="Expired - the contract rejects it now" />{" "}
          <span className="text-xs text-muted">
            (<DateTime ts={attestation.expiry} seconds />)
          </span>
        </dd>

        <dt className="text-muted">Signature</dt>
        <dd className="min-w-0">
          <Digest value={attestation.signature} label="attestation signature" head={12} tail={10} />
        </dd>

        <dt className="text-muted">EIP-712 domain</dt>
        <dd className="min-w-0 space-y-1 text-xs">
          <div>
            <span className="font-mono">{td.domain.name}</span> version <span className="font-mono">{td.domain.version}</span>, chain{" "}
            <span className="font-mono tabular">{td.domain.chainId}</span> ({txNetworkPhrase(td.domain.chainId)})
            {view.chain_id !== null ? (
              <>
                {" "}
                <MatchMark ok={td.domain.chainId === view.chain_id} subject={"the challenge's chain"} />
              </>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-2">
            <span>verifying contract</span>
            <Address value={td.domain.verifyingContract} label="verifying contract" />
            <MatchMark ok={sameHex(td.domain.verifyingContract, view.contract)} subject={"the challenge's contract"} />
          </div>
        </dd>
      </dl>

      <Table caption="Attestation typed-data message: field, type, value, and what this page compared it with" dense>
        <THead>
          <tr>
            <TH>Field</TH>
            <TH>Type</TH>
            <TH>Value</TH>
            <TH>Checked on this page</TH>
          </tr>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.name}>
              <TD mono>{r.name}</TD>
              <TD mono className="text-muted">
                {r.type}
              </TD>
              <TD>{r.value}</TD>
              <TD>{r.check}</TD>
            </TR>
          ))}
        </TBody>
      </Table>

      <Callout tone="neutral" icon={<ShieldQuestion />} title="What this signature is">
        The page compares values and recovers the signer&apos;s address; it cannot re-run the replay. The attestation is the
        declared evaluator&apos;s statement about its own replay.
      </Callout>
      <TrustStatement kind="attestation" />
    </div>
  );
}
