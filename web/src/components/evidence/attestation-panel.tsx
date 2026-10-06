"use client";

import { FileSignature, Scale } from "lucide-react";
import type { ReactNode } from "react";
import { TrustStatement } from "@/components/truth";
import { Address } from "@/components/ui/address";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { JsonView } from "@/components/ui/json-view";
import { KeyValueList } from "@/components/ui/stat";
import { ErrorState } from "@/components/ui/states";
import { Countdown, DateTime } from "@/components/ui/time";
import type { AttestationTypedData, ChallengeView, Evaluation, EvidenceBundle, Hex } from "@/lib/api";
import { digestMatchesBytes32, txNetworkPhrase } from "@/lib/chain";
import { useAttest } from "@/lib/queries";
import { MatchMark } from "@/components/ui/match-mark";
import { sameHex } from "@/lib/format";
import type { SignatureBinding } from "@/components/settlement/use-recovered-signer";
import { BindingMark } from "./who-checked";

/** The parts of an attestation this panel shows (AttestationRow and SettlementAttestation both fit). */
export interface AttestationLike {
  typed_data: AttestationTypedData;
  signature: Hex;
  signer: string;
  expiry: number;
  created_at?: number;
}

export interface AttestationPanelProps {
  evaluation: Evaluation;
  bundle: EvidenceBundle;
  /** The challenge (for status, network and the settlement link); null while loading. */
  challenge: ChallengeView | null;
  attestation: AttestationLike | null;
  /** The signer recovered from the signature in this browser, compared with the evaluator. */
  binding: SignatureBinding;
}

/**
 * The evaluator's EIP-712 attestation for this evaluation, checked field by field against
 * the evidence on this page, or the honest reason there is none (and a button to request
 * one when the verdict is a reward-eligible verified violation on a funded challenge).
 */
export function AttestationPanel({ evaluation, bundle, challenge, attestation, binding }: AttestationPanelProps) {
  const attest = useAttest(evaluation.challenge_id);
  const outcome = bundle.verdict.outcome;
  const settlementHref = `/challenges/${evaluation.challenge_id}/settlement`;

  if (!attestation) {
    let body: ReactNode;
    if (outcome !== "verified_violation") {
      body = (
        <p className="text-sm text-muted">
          No attestation: only a verified violation can be attested for a reward, and this outcome is not one.
        </p>
      );
    } else if (!bundle.verdict.reward_eligible) {
      body = (
        <p className="text-sm text-muted">
          No attestation: this verified violation is not reward-eligible under the challenge&apos;s reward policy (rule or outcome not
          listed as eligible).
        </p>
      );
    } else if (!challenge) {
      body = <p className="text-sm text-muted">Loading the challenge to see whether an attestation can be requested.</p>;
    } else if (challenge.status === "offchain") {
      body = (
        <p className="text-sm text-muted">
          Off-chain challenge: there is no reward and no settlement, so no attestation is requested. The evidence bundle is the
          result.
        </p>
      );
    } else if (challenge.status !== "funded") {
      body = (
        <p className="text-sm text-muted">
          The challenge is <span className="font-medium text-fg">{challenge.status}</span>, so the backend will not request a new
          attestation.
        </p>
      );
    } else {
      body = (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            No attestation yet. Requesting one asks the evaluator&apos;s signing service to sign an EIP-712 attestation of this
            verdict, binding the spec, submission, candidate and evidence digests and the recipient fixed at commit time.
          </p>
          <Button
            variant="primary"
            icon={<FileSignature />}
            busy={attest.isPending}
            busyLabel="Requesting attestation..."
            onClick={() => attest.mutate(evaluation.id)}
          >
            Request attestation
          </Button>
          {attest.isError ? <ErrorState error={attest.error} title="The attestation was not issued" compact /> : null}
          {attest.isSuccess ? (
            <p role="status" className="text-sm text-ok">
              Attestation issued. Reloading the evaluation.
            </p>
          ) : null}
        </div>
      );
    }
    return (
      <Card>
        <CardHeader title="Evaluator attestation" level={3} />
        <CardBody className="space-y-3">
          {body}
          <TrustStatement kind="attestation" />
        </CardBody>
      </Card>
    );
  }

  const td = attestation.typed_data;
  const m = td.message;
  const checks = {
    spec: digestMatchesBytes32(m.specDigest, bundle.challenge.spec_digest),
    candidate: digestMatchesBytes32(m.candidateDigest, bundle.submission.candidate_digest),
    evidence: digestMatchesBytes32(m.evidenceDigest, bundle.evidence_digest ?? evaluation.evidence_digest),
    recipient: sameHex(m.recipient, evaluation.recipient),
    challenger: sameHex(m.challenger, evaluation.challenger),
  };

  return (
    <Card>
      <CardHeader
        title="Evaluator attestation"
        level={3}
        description="EIP-712 signature by the declared trusted evaluator. The contract accepts it from any relayer and pays only the recipient inside it."
        actions={
          <ButtonLink href={settlementHref} size="sm" icon={<Scale />}>
            Settlement
          </ButtonLink>
        }
      />
      <CardBody className="space-y-4">
        <KeyValueList
          items={[
            {
              key: "signer",
              label: "Signer",
              value: (
                <span className="flex flex-col gap-1">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Address value={attestation.signer} label="signer address" />
                    <span className="text-xs text-muted">reported by the backend</span>
                  </span>
                  {binding.state === "recovered" ? (
                    <MatchMark ok={sameHex(binding.address, attestation.signer) === true} subject="the address recovered from the signature" />
                  ) : null}
                  <BindingMark binding={binding} address={bundle.evaluator.address} />
                </span>
              ),
            },
            {
              key: "expiry",
              label: "Expires",
              value: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <DateTime ts={attestation.expiry} />
                  <Countdown to={attestation.expiry} prefix="in" expiredText="expired - a new attestation is needed to settle" />
                </span>
              ),
            },
            { key: "sig", label: "Signature", value: <Digest value={attestation.signature} label="signature" head={10} tail={8} /> },
            ...(attestation.created_at
              ? [{ key: "created", label: "Signed", value: <DateTime ts={attestation.created_at} /> }]
              : []),
          ]}
        />

        <div>
          <h3 className="mb-2 text-sm font-semibold text-fg">Signed message</h3>
          <KeyValueList
            items={[
              { key: "cid", label: "challengeId (on chain)", value: <span className="font-mono text-xs">{String(m.challengeId)}</span> },
              {
                key: "spec",
                label: "specDigest",
                value: (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Digest value={m.specDigest} label="signed spec digest" />
                    <MatchMark ok={checks.spec} subject="the spec digest in the evidence" />
                  </span>
                ),
              },
              { key: "sub", label: "submissionId", value: <Digest value={m.submissionId} label="signed submission id" /> },
              {
                key: "cand",
                label: "candidateDigest",
                value: (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Digest value={m.candidateDigest} label="signed candidate digest" />
                    <MatchMark ok={checks.candidate} subject="the replayed candidate in the evidence" />
                  </span>
                ),
              },
              {
                key: "evid",
                label: "evidenceDigest",
                value: (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Digest value={m.evidenceDigest} label="signed evidence digest" />
                    <MatchMark ok={checks.evidence} subject="this evidence bundle" />
                  </span>
                ),
              },
              {
                key: "chal",
                label: "challenger",
                value: (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Address value={m.challenger} label="challenger" />
                    <MatchMark ok={checks.challenger} subject="the committed challenger" />
                  </span>
                ),
              },
              {
                key: "rec",
                label: "recipient (payout)",
                value: (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Address value={m.recipient} label="recipient" />
                    <MatchMark ok={checks.recipient} subject="the recipient bound at commit time" />
                  </span>
                ),
              },
              { key: "verdict", label: "verdict (uint8)", value: <span className="font-mono text-xs">{m.verdict}</span> },
              { key: "exp", label: "expiry", value: <span className="font-mono text-xs">{m.expiry}</span> },
            ]}
          />
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-fg">Domain</h3>
          <KeyValueList
            items={[
              { key: "name", label: "name / version", value: `${td.domain.name} / ${td.domain.version}` },
              { key: "chain", label: "chainId", value: `${td.domain.chainId} - ${txNetworkPhrase(td.domain.chainId)}` },
              { key: "contract", label: "verifyingContract", value: <Address value={td.domain.verifyingContract} label="contract" /> },
            ]}
          />
        </div>

        <JsonView value={td} label="EIP-712 typed data" collapsedDepth={0} />
        <TrustStatement kind="attestation" />
      </CardBody>
      <CardFooter>
        Anyone may relay <span className="font-mono text-xs text-fg">settle()</span>; the reward always goes to the recipient above.
      </CardFooter>
    </Card>
  );
}
