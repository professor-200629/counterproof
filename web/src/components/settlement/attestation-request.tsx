"use client";

import { Hourglass, PenLine, RefreshCw } from "lucide-react";
import { ReadOnlyNote } from "@/components/snapshot";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { TimeAgo } from "@/components/ui/time";
import { isAttestQueued, type Job } from "@/lib/api";
import { useAttest } from "@/lib/queries";
import { SNAPSHOT_MODE } from "@/lib/snapshot";
import { attestationJobOutcome, isAttestationJobActive, verificationSummary } from "./derive";

/** Why a live-model attestation takes minutes, said once wherever one is requested. */
export function signerReplayNote(liveModel: boolean): string {
  return liveModel
    ? "Before it signs, the evaluator's signer replays the committed candidate itself: the spec's k-of-n fresh replays against the live model, which takes several minutes."
    : "Before it signs, the evaluator's signer replays the committed candidate itself in fresh isolated children; this usually takes seconds.";
}

/**
 * What the latest request to the evaluator's signer is doing: queued, replaying (with the
 * signer's own progress), or why it ended without a signature. Renders nothing when there is
 * no request, or the last one was signed.
 */
export function SignerJobStatus({ job, liveModel }: { job: Job | null | undefined; liveModel: boolean }) {
  if (!job) return null;
  const { status, verification, detail } = attestationJobOutcome(job);
  if (isAttestationJobActive(job)) {
    const progress = verificationSummary(verification);
    return (
      <Callout tone="warn" icon={<Hourglass />} title="The evaluator's signer is independently replaying" role="status">
        {job.status === "queued" ? "The request is queued for a worker. " : null}
        {signerReplayNote(liveModel)} {progress ? `Now: ${progress}.` : null} The attestation appears here when it is signed; nothing is
        paid on the worker&apos;s word.
      </Callout>
    );
  }
  if (status === "refused" || status === "not_requested") {
    return (
      <Callout tone="warn" title="The signer refused to attest" role="status">
        {detail ?? "No reason was recorded."} {verificationSummary(verification) ? `(${verificationSummary(verification)}.)` : null}{" "}
        <span className="text-xs text-muted">
          Request finished <TimeAgo ts={job.finished_at ?? job.created_at} />.
        </span>
      </Callout>
    );
  }
  if (status === "failed" || status === "timed_out" || status === "cancelled" || job.status === "failed") {
    return (
      <Callout tone="warn" title="The signer could not finish its own replay" role="status">
        {detail ?? job.error ?? "The request ended before the signer answered."} This is not a verdict about the agent: nothing was
        signed or refused, and the attestation can be requested again.
      </Callout>
    );
  }
  return null;
}

/**
 * Ask the evaluator's signer to sign (or to renew an expired attestation). A 202 answer
 * means the request is queued: the signer replays the committed candidate itself first, and
 * the page polls until it finishes. Snapshot mode shows the read-only note instead.
 */
export function AttestationRequestButton({
  challengeId,
  evaluationId,
  job,
  renew = false,
  liveModel,
  readOnlyAction,
}: {
  challengeId: number | string;
  evaluationId: string;
  job: Job | null | undefined;
  renew?: boolean;
  liveModel: boolean;
  /** What the snapshot's read-only note says cannot be done here. */
  readOnlyAction?: string;
}) {
  const attest = useAttest(challengeId);
  if (SNAPSHOT_MODE) {
    return <ReadOnlyNote action={readOnlyAction ?? (renew ? "Renewing an attestation" : "Asking the evaluator to sign an attestation")} />;
  }
  const pending = isAttestationJobActive(job);
  const queued = attest.isSuccess && isAttestQueued(attest.data);
  return (
    <div className="space-y-3">
      <Button
        variant="primary"
        icon={renew ? <RefreshCw /> : <PenLine />}
        onClick={() => attest.mutate(evaluationId)}
        busy={attest.isPending}
        busyLabel={renew ? "Asking the signer to renew" : "Asking the signer"}
        disabled={pending}
      >
        {renew ? "Renew attestation" : "Ask the evaluator to sign"}
      </Button>
      {attest.isError ? <ErrorState error={attest.error} title="The signer did not attest" compact /> : null}
      {queued && !pending ? (
        <p role="status" className="text-sm text-muted">
          Request queued. {signerReplayNote(liveModel)}
        </p>
      ) : null}
      {attest.isSuccess && !isAttestQueued(attest.data) ? (
        <p role="status" className="text-sm text-ok">
          {renew ? "Renewed." : "Signed."} The attestation is shown here once the page refreshes its data.
        </p>
      ) : null}
    </div>
  );
}
