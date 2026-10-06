"use client";

import { CircleCheck, Download, FileSearch, Hourglass, PenLine, Receipt, Undo2 } from "lucide-react";
import type { Hex } from "viem";
import { ActivityList, ActivityRef } from "@/components/activity-list";
import { FundingPanel } from "@/components/create/funding-panel";
import { TxHash } from "@/components/tx-hash";
import { LocalChainNotice } from "@/components/tx-status";
import { TrustStatement } from "@/components/truth";
import { Address } from "@/components/ui/address";
import { Breadcrumbs, challengeCrumbs } from "@/components/ui/breadcrumbs";
import { Button, ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { ProvenanceBadge } from "@/components/ui/provenance-badge";
import { PageHeader, Section } from "@/components/ui/section";
import { KeyValueList } from "@/components/ui/stat";
import { ErrorState, QueryState } from "@/components/ui/states";
import { TextLink } from "@/components/ui/text-link";
import { StatusBadge } from "@/components/ui/status-badge";
import { Countdown, DateTime, TimeAgo, useNow } from "@/components/ui/time";
import {
  evidenceDownloadUrl,
  finishedSummary,
  type AppConfig,
  type ChallengeView,
  type Evaluation,
  type Settlement,
  type SettlementAttestation,
} from "@/lib/api";
import { formatWei, toChecksumAddress, txNetworkPhrase } from "@/lib/chain";
import { useAttest, useChallenge, useConfig, useSettlement } from "@/lib/queries";
import { isChallengeActive, isEvaluationActive } from "@/lib/status";
import { supportedChainIdFor } from "@/lib/wagmi";
import { RefundAction, SettleAction, WithdrawAction, type ChainTarget } from "./actions";
import { AttestationDetails } from "./attestation-details";
import {
  commitTxFor,
  confirmedTx,
  currentAttestation,
  detailString,
  failedAttempts,
  isPayableVerdict,
  latestAttestationNote,
  pickSettlementEvaluation,
  sameAddress,
  settlementActivity,
  txsOfKind,
} from "./derive";
import { OffchainSettlement } from "./offchain-settlement";
import { FailedAttempts, RecordedTxList } from "./recorded-tx";
import { Timeline, TimelineStep, type TimelineState } from "./timeline";
import { plural, sameHex } from "@/lib/format";

const FINISHED_STATUSES = new Set(["funded", "settled", "refunded"]);

export function SettlementView({ challengeId }: { challengeId: string }) {
  const viewQ = useChallenge(challengeId);
  const view = viewQ.data;
  const settlementQ = useSettlement(challengeId, { enabled: !!view && view.network !== "offchain", poll: isChallengeActive(view) });
  const configQ = useConfig();

  const breadcrumb = <Breadcrumbs items={challengeCrumbs(challengeId, view?.spec.title, "Settlement")} />;

  if (!view) {
    return (
      <>
        <PageHeader title="Settlement" breadcrumb={breadcrumb} />
        <QueryState
          query={viewQ}
          label="challenge"
          card
          rows={6}
          notFound={{
            title: `Challenge #${challengeId} does not exist`,
            description: "The backend has no challenge with this id, so there is nothing to settle.",
            action: <ButtonLink href="/challenges">All challenges</ButtonLink>,
          }}
        />
      </>
    );
  }

  const offchain = view.network === "offchain" || view.status === "offchain";
  const header = (
    <PageHeader
      title="Settlement"
      breadcrumb={breadcrumb}
      description={
        <>
          <span className="text-fg">{view.spec.title}</span>
          {" - "}
          {offchain
            ? "evidence only: this challenge has no reward."
            : "was the reward paid, to whom, on which network, and on whose signature."}
        </>
      }
      meta={
        <>
          <StatusBadge status={view.status} domain="challenge" />
          <ProvenanceBadge kind="network" value={view.network} />
          <ProvenanceBadge kind="target" value={view.spec.target.label} requiresModel={view.target_info?.requires_model} />
          {view.onchain_id ? <span className="text-xs text-muted">on-chain challenge #{view.onchain_id}</span> : null}
        </>
      }
    />
  );

  if (offchain) {
    return (
      <>
        {header}
        <OffchainSettlement view={view} />
      </>
    );
  }

  return (
    <>
      {header}
      {settlementQ.data ? (
        <OnchainSettlement view={view} settlement={settlementQ.data} config={configQ.data ?? null} />
      ) : (
        <QueryState query={settlementQ} label="settlement" card rows={6} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------- on-chain
interface OnchainProps {
  view: ChallengeView;
  settlement: Settlement;
  config: AppConfig | null;
}

function OnchainSettlement({ view, settlement, config }: OnchainProps) {
  const now = useNow(1000);
  const nowSec = now === null ? null : Math.floor(now / 1000);
  const attestation = currentAttestation(settlement, view);
  const evaluation = pickSettlementEvaluation(view, attestation);
  const onchain = settlement.onchain;
  const contractRaw = view.contract ?? config?.chain.contract ?? null;
  const target: ChainTarget = {
    contract: contractRaw ? (toChecksumAddress(contractRaw) as Hex | null) : null,
    chainId: supportedChainIdFor(view.network),
    network: view.network,
  };
  const settledTx = confirmedTx(view.transactions, "settle");
  const refundTx = confirmedTx(view.transactions, "refund");
  const activity = settlementActivity(view.activity);

  return (
    <div className="space-y-8">
      <AnswerCallout view={view} settlement={settlement} attestation={attestation} evaluation={evaluation} nowSec={nowSec} />
      <LocalChainNotice network={view.network} />
      {settlement.onchain_error ? (
        <Callout tone="warn" title="The backend could not read this challenge from the contract" role="status">
          {settlement.onchain_error}. Steps below fall back to the backend&apos;s recorded state.
        </Callout>
      ) : null}

      <Section
        title="Settlement timeline"
        description="Each step shows what the backend recorded after reading receipts from the chain, or what this page read from the contract itself. Nothing here is taken from the wallet's word."
      >
        <Timeline label="Settlement steps">
          <FundedStep view={view} settlement={settlement} config={config} />
          <CommitStep view={view} evaluation={evaluation} />
          <ReplayStep view={view} evaluation={evaluation} />
          <AttestStep view={view} settlement={settlement} attestation={attestation} evaluation={evaluation} config={config} nowSec={nowSec} />
          <SettleStep view={view} settlement={settlement} attestation={attestation} target={target} nowSec={nowSec} settledTx={settledTx} />
          <WithdrawStep view={view} settlement={settlement} attestation={attestation} target={target} settledTx={settledTx} refundTx={refundTx} />
        </Timeline>
      </Section>

      {view.status === "funded" || view.status === "refunded" || txsOfKind(view.transactions, "refund").length > 0 ? (
        <Section
          title="Refund if never settled"
          description="The other way escrow can end: after the settlement deadline, an unsettled reward goes back to the publisher."
        >
          <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
            {view.status === "refunded" && refundTx ? (
              <Callout tone="neutral" icon={<Undo2 />} title={`Refunded on ${txNetworkPhrase(refundTx.chain_id)}`} role="status">
                {formatWei(detailString(refundTx, "reward_wei") ?? view.reward_wei, view.network)} returned to the credit of the
                publisher <Address value={detailString(refundTx, "publisher") ?? view.spec.publisher.address} label="publisher" />. Nobody
                was paid a reward.
              </Callout>
            ) : null}
            {view.status === "funded" ? <RefundAction view={view} onchain={onchain} nowSec={nowSec} {...target} /> : null}
            <RecordedTxList txs={txsOfKind(view.transactions, "refund")} />
            <FailedAttempts entries={failedAttempts(view.activity, ["refund"])} />
          </div>
        </Section>
      ) : null}

      <ReceiptNote />

      <Section title="Settlement activity" description="The backend's log for funding, commitments, attestations and payouts, verbatim (newest first).">
        {activity.length > 0 ? (
          <ActivityList
            entries={activity}
            limit={20}
            renderRef={(e) => <ActivityRef entry={e} chainId={view.chain_id} linkSettlement={false} />}
          />
        ) : (
          <p className="text-sm text-muted">No settlement activity recorded yet.</p>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------- answer first
function AnswerCallout({
  view,
  settlement,
  attestation,
  evaluation,
  nowSec,
}: {
  view: ChallengeView;
  settlement: Settlement;
  attestation: SettlementAttestation | null;
  evaluation: Evaluation | null;
  nowSec: number | null;
}) {
  const reward = settlement.onchain?.reward_wei ?? view.reward_wei;
  if (view.status === "settled") {
    const tx = confirmedTx(view.transactions, "settle");
    const recipient = detailString(tx, "recipient") ?? attestation?.typed_data.message.recipient ?? null;
    // settle() only credits a pull balance; the reward leaves the contract when the recipient withdraws.
    const withdrawal =
      txsOfKind(view.transactions, "withdraw").find(
        (t) =>
          t.status === "confirmed" &&
          sameHex(detailString(t, "account"), recipient) === true &&
          (tx?.block_number == null || t.block_number == null || t.block_number >= tx.block_number),
      ) ?? null;
    const where = txNetworkPhrase(tx?.chain_id ?? view.chain_id);
    return (
      <Callout
        tone="ok"
        icon={<CircleCheck />}
        title={withdrawal ? `Reward credited and withdrawn: settled on ${where}` : `Reward credited to the bound recipient: settled on ${where}`}
        role="status"
      >
        {formatWei(detailString(tx, "reward_wei") ?? reward, view.network)} was credited by the contract to{" "}
        <Address value={recipient} label="recipient" />, the recipient bound when the submission was committed. The backend
        verified this from the settlement receipt and its ChallengeSettled event.{" "}
        {withdrawal
          ? `The recipient has since withdrawn its whole credit (${formatWei(detailString(withdrawal, "amount_wei"), view.network)}), which includes this reward.`
          : "The credit stays in the contract until the recipient withdraws it; no withdrawal by the recipient is recorded yet."}
      </Callout>
    );
  }
  if (view.status === "refunded") {
    return (
      <Callout tone="neutral" icon={<Undo2 />} title="No reward paid: refunded to the publisher" role="status">
        The settlement deadline passed without a settlement, and the escrowed reward returned to the publisher&apos;s credit.
      </Callout>
    );
  }
  if (view.status === "awaiting_funding") {
    return (
      <Callout tone="warn" icon={<Hourglass />} title="Not paid: the reward is not escrowed yet" role="status">
        Until a funding transaction is confirmed on chain, there is nothing to settle.
      </Callout>
    );
  }
  // funded
  let next: string;
  if (!evaluation) next = "No submission has been evaluated yet.";
  else if (isEvaluationActive(evaluation.status)) next = "The evaluator is replaying the submission; no verdict yet.";
  else if (!isPayableVerdict(evaluation)) next = "The latest evaluated submission did not produce a payable verdict.";
  else if (!attestation) next = "A verified violation is waiting for the declared evaluator's signature.";
  else if (nowSec !== null && nowSec > attestation.expiry) next = "The attestation expired before anyone relayed it.";
  else next = "The attestation is signed. Anyone may relay it below; the reward goes to the bound recipient.";
  return (
    <Callout tone="warn" icon={<Hourglass />} title={`Not paid yet: ${formatWei(reward, view.network)} in escrow`} role="status">
      {next}
    </Callout>
  );
}

function ReceiptNote() {
  return (
    <Callout tone="neutral" icon={<Receipt />} title="What this receipt proves">
      <p>
        A settlement receipt proves that the escrow contract credited the reward to the bound recipient after checking a valid
        signature from the declared evaluator over this exact submission and evidence digest. It does not prove that the AI agent is correct, or
        that it is incorrect: the contract cannot re-run the replay, and the evaluator is a declared trusted party, not a
        proof system.
      </p>
      <TrustStatement kind="receipt" className="mt-2" />
      <TrustStatement kind="llm" className="mt-1" />
    </Callout>
  );
}

// ---------------------------------------------------------------------------- steps
function FundedStep({ view, settlement, config }: { view: ChallengeView; settlement: Settlement; config: AppConfig | null }) {
  const onchain = settlement.onchain;
  const fundTxs = txsOfKind(view.transactions, "fund");
  const fundRow = fundTxs.find((t) => sameHex(t.hash, view.fund_tx) === true) ?? null;
  const funded = FINISHED_STATUSES.has(view.status) && !!view.fund_tx;
  const state: TimelineState = funded ? "complete" : fundTxs[0]?.status === "failed" ? "error" : "current";
  const reward = onchain?.reward_wei ?? view.reward_wei;
  const deadlines = view.spec.deadlines;
  return (
    <TimelineStep
      index={1}
      id="step-funded"
      title="Funded"
      state={state}
      summary={
        funded
          ? `${formatWei(reward, view.network)} escrowed in the contract as challenge #${view.onchain_id ?? "?"}.`
          : state === "error"
            ? "The last funding transaction failed. No reward is escrowed."
            : "No reward is escrowed yet."
      }
    >
      <KeyValueList
        items={[
          {
            key: "tx",
            label: "Funding transaction",
            value: view.fund_tx ? (
              <span className="space-y-0.5">
                <TxHash hash={view.fund_tx} chainId={fundRow?.chain_id ?? view.chain_id} label="funding transaction hash" />
                {fundRow?.block_number != null ? (
                  <span className="block text-xs text-muted">
                    block <span className="font-mono tabular">{fundRow.block_number}</span>
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-muted">none confirmed</span>
            ),
          },
          {
            key: "escrow",
            label: "Escrow",
            value: (
              <span>
                <span className="font-semibold tabular">{formatWei(reward, view.network)}</span>{" "}
                <span className="text-xs text-muted">{onchain ? "(contract value, read by the backend)" : "(spec value)"}</span>
              </span>
            ),
          },
          {
            key: "status",
            label: "Contract says",
            value: onchain ? (
              <StatusBadge status={onchain.status} domain="onchain" size="sm" />
            ) : (
              <span className="text-xs text-muted">{view.onchain_id ? "not read (see the warning above)" : "no on-chain id yet"}</span>
            ),
          },
          {
            key: "publisher",
            label: "Publisher",
            value: <Address value={onchain?.publisher ?? view.spec.publisher.address} label="publisher" note={view.spec.publisher.name || undefined} />,
          },
          {
            key: "sub",
            label: "Submissions close",
            value: (
              <span>
                <DateTime ts={onchain?.submission_deadline ?? deadlines.submission_deadline} />{" "}
                <span className="text-xs">
                  (<Countdown to={onchain?.submission_deadline ?? deadlines.submission_deadline} expiredText="closed" />)
                </span>
              </span>
            ),
          },
          {
            key: "settle",
            label: "Settlement deadline",
            value: (
              <span>
                <DateTime ts={onchain?.settlement_deadline ?? deadlines.settlement_deadline} />{" "}
                <span className="text-xs">
                  (<Countdown to={onchain?.settlement_deadline ?? deadlines.settlement_deadline} expiredText="passed" />)
                </span>
              </span>
            ),
          },
        ]}
      />
      {fundTxs.some((t) => t.status !== "confirmed") ? <RecordedTxList txs={fundTxs} className="mt-3" /> : null}
      <FailedAttempts entries={failedAttempts(view.activity, ["fund"])} className="mt-3" />
      {view.status === "awaiting_funding" ? (
        <section aria-labelledby="fund-now-heading" className="mt-4 space-y-3 border-t border-line pt-4">
          <h4 id="fund-now-heading" className="text-sm font-semibold text-fg">
            Fund challenge #{view.id}
          </h4>
          {config ? (
            <FundingPanel config={config} created={{ challenge: view, spec: view.spec, digest: view.spec_digest }} inPlace />
          ) : (
            <p className="text-sm text-muted">Loading the backend configuration (contract and chain) before funding can be offered.</p>
          )}
        </section>
      ) : null}
    </TimelineStep>
  );
}

function CommitStep({ view, evaluation }: { view: ChallengeView; evaluation: Evaluation | null }) {
  const commitTx = commitTxFor(view, evaluation);
  const chainEvaluations = view.evaluations.filter((e) => e.source === "chain").length;
  let state: TimelineState = "upcoming";
  let summary: string = "No submission has been committed yet.";
  if (evaluation?.source === "chain") {
    state = "complete";
    summary = "The candidate's digest and payout recipient were committed on chain before the reveal.";
  } else if (evaluation) {
    state = "warning";
    summary = "This submission was evaluated off-chain and was never committed; it cannot be settled.";
  } else if (view.status === "funded") {
    state = "current";
  }
  return (
    <TimelineStep index={2} id="step-committed" title="Candidate committed" state={state} summary={summary}>
      {evaluation ? (
        <>
          <KeyValueList
            items={[
              { key: "sid", label: "Submission id", value: <Digest value={evaluation.submission_id} label="submission id" /> },
              {
                key: "ctx",
                label: "Commit transaction",
                value:
                  evaluation.commit_tx || commitTx ? (
                    <span className="space-y-0.5">
                      <TxHash hash={evaluation.commit_tx ?? commitTx?.hash} chainId={commitTx?.chain_id ?? view.chain_id} label="commit transaction hash" />
                      {commitTx?.block_number != null ? (
                        <span className="block text-xs text-muted">
                          block <span className="font-mono tabular">{commitTx.block_number}</span>
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-muted">none recorded</span>
                  ),
              },
              { key: "ch", label: "Challenger", value: <Address value={evaluation.challenger} label="challenger" /> },
              {
                key: "rc",
                label: "Recipient",
                value: <Address value={evaluation.recipient} label="recipient" note="bound at commit - the only address the reward can go to" />,
              },
            ]}
          />
          <p className="mt-3 text-xs text-muted">
            {chainEvaluations} committed {plural(chainEvaluations, "submission")} evaluated for this challenge. This page follows{" "}
            <span className="font-mono">{evaluation.id}</span>
            {view.attestation?.evaluation_id === evaluation.id ? " (the attested one)." : " (the latest relevant one)."}
          </p>
          {commitTx && commitTx.status === "failed" ? <RecordedTxList txs={[commitTx]} className="mt-3" /> : null}
        </>
      ) : (
        <p className="text-sm text-muted">
          Challengers search on the <TextLink href={`/challenges/${view.id}?tab=testing`}>challenge page</TextLink> and
          commit a candidate before revealing it to the evaluator.
        </p>
      )}
    </TimelineStep>
  );
}

function ReplayStep({ view, evaluation }: { view: ChallengeView; evaluation: Evaluation | null }) {
  const s = finishedSummary(evaluation);
  let state: TimelineState = "upcoming";
  let summary = "Nothing has been replayed yet.";
  if (evaluation && isEvaluationActive(evaluation.status)) {
    state = "current";
    summary = "The evaluator is replaying the sequence in a fresh synthetic marketplace; no verdict yet.";
  } else if (s?.outcome === "verified_violation") {
    state = "complete";
    summary = s.reason;
  } else if (s && (s.outcome === "runner_failure" || s.outcome === "malformed_submission")) {
    state = "error";
    summary = s.reason;
  } else if (s) {
    state = "warning";
    summary = `${s.reason} - no payable verdict.`;
  }
  const violated = s?.replays.filter((r) => r.claimed_rule_violated).length ?? 0;
  return (
    <TimelineStep index={3} id="step-replayed" title="Independently replayed" state={state} summary={summary}>
      {evaluation ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={evaluation.status} domain="evaluation" />
            <ProvenanceBadge kind="target" value={view.spec.target.label} requiresModel={view.target_info?.requires_model} size="md" />
            <span className="font-mono text-xs text-muted">
              {view.spec.target.adapter}@{view.spec.target.version}
            </span>
          </div>
          {s ? (
            <KeyValueList
              items={[
                {
                  key: "rule",
                  label: "Rule",
                  value: s.rule ? (
                    <span>
                      <span className="font-mono text-xs text-muted">{s.rule.rule_id}</span> {s.rule.statement}
                    </span>
                  ) : (
                    <span className="text-muted">no rule verdict</span>
                  ),
                },
                {
                  key: "replays",
                  label: "Replays",
                  value: (
                    <span className="tabular">
                      claimed rule violated in {violated} of {s.replays.length} {plural(s.replays.length, "replay")}
                    </span>
                  ),
                },
                ...(s.summary ? [{ key: "obs", label: "Observed", value: s.summary }] : []),
                { key: "elig", label: "Reward eligible", value: s.reward_eligible ? "yes, under the spec's reward policy" : "no" },
              ]}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted">Evidence</span>
            <Digest value={evaluation.evidence_digest} label="evidence digest" href={`/evaluations/${evaluation.id}`} emptyText="not produced yet" />
            <ButtonLink href={`/evaluations/${evaluation.id}`} size="sm" icon={<FileSearch />}>
              Open evidence
            </ButtonLink>
            {evaluation.evidence_digest ? (
              <ButtonLink href={evidenceDownloadUrl(evaluation.evidence_digest)} external download size="sm" variant="ghost" icon={<Download />}>
                Download JSON
              </ButtonLink>
            ) : null}
          </div>
        </div>
      ) : null}
    </TimelineStep>
  );
}

function AttestStep({
  view,
  settlement,
  attestation,
  evaluation,
  config,
  nowSec,
}: {
  view: ChallengeView;
  settlement: Settlement;
  attestation: SettlementAttestation | null;
  evaluation: Evaluation | null;
  config: AppConfig | null;
  nowSec: number | null;
}) {
  const payable = isPayableVerdict(evaluation);
  let state: TimelineState = "upcoming";
  let stateLabel: string | undefined;
  let summary = "Signed only for a verified violation that is eligible for the reward.";
  if (attestation) {
    const signerOk = sameAddress(attestation.signer, view.spec.evaluator.address);
    const expired = nowSec !== null && nowSec > attestation.expiry;
    if (!signerOk) {
      state = "error";
      summary = "The signer is not the evaluator declared in the spec; the contract would reject it (SignerNotEvaluator).";
    } else if (expired && view.status === "funded") {
      state = "warning";
      stateLabel = "Expired";
      summary = "Signed by the declared evaluator, but the attestation expired before it was relayed.";
    } else {
      state = "complete";
      summary = "Signed by the declared evaluator over the submission, candidate and evidence digests.";
    }
  } else if (evaluation && payable && view.status === "funded") {
    state = "current";
    summary = "Waiting for the declared evaluator's signer.";
  } else if (evaluation && finishedSummary(evaluation) && !payable) {
    state = "skipped";
    summary = "No payable verdict, so there is nothing to attest.";
  }
  return (
    <TimelineStep index={4} id="step-attested" title="Attested" state={state} stateLabel={stateLabel} summary={summary}>
      {attestation ? (
        <AttestationDetails
          attestation={attestation}
          view={view}
          evaluation={evaluation}
          onchain={settlement.onchain}
          configEvaluator={config?.evaluator_address}
        />
      ) : state === "current" && evaluation ? (
        <RequestAttestation view={view} evaluation={evaluation} config={config} />
      ) : (
        <p className="text-sm text-muted">
          Declared evaluator: <Address value={view.spec.evaluator.address} label="declared evaluator" />{" "}
          <span className="text-xs">({view.spec.evaluator_trust})</span>
        </p>
      )}
    </TimelineStep>
  );
}

function RequestAttestation({ view, evaluation, config }: { view: ChallengeView; evaluation: Evaluation; config: AppConfig | null }) {
  const attest = useAttest(view.id);
  const note = latestAttestationNote(view.activity, evaluation.id);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        The evaluator&apos;s signer re-checks the evidence bundle and the on-chain commitment before it signs, and refuses if
        anything differs. Declared evaluator: <Address value={view.spec.evaluator.address} label="declared evaluator" />
      </p>
      {config && !config.signer.reachable ? (
        <Callout tone="warn" title="Signer not reachable" role="status">
          /api/config reports the signer service at {config.signer.url} as unreachable, so a request will fail until it is running.
        </Callout>
      ) : null}
      {note ? (
        <p className="text-xs text-warn">
          Last attempt (<TimeAgo ts={note.created_at} />): {note.message}
        </p>
      ) : null}
      <Button
        variant="primary"
        icon={<PenLine />}
        onClick={() => attest.mutate(evaluation.id)}
        busy={attest.isPending}
        busyLabel="Asking the signer"
      >
        Ask the evaluator to sign
      </Button>
      {attest.isError ? <ErrorState error={attest.error} title="The signer did not attest" compact /> : null}
      {attest.isSuccess ? <p className="text-sm text-ok">Signed. The attestation is shown here once the page refreshes its data.</p> : null}
    </div>
  );
}

function SettleStep({
  view,
  settlement,
  attestation,
  target,
  nowSec,
  settledTx,
}: {
  view: ChallengeView;
  settlement: Settlement;
  attestation: SettlementAttestation | null;
  target: ChainTarget;
  nowSec: number | null;
  settledTx: ReturnType<typeof confirmedTx>;
}) {
  const settleTxs = txsOfKind(view.transactions, "settle");
  const attempts = failedAttempts(view.activity, ["settle"]);
  let state: TimelineState = "upcoming";
  let stateLabel: string | undefined;
  let summary = "Possible once a signed attestation exists.";
  if (view.status === "settled") {
    state = "complete";
    summary = `Settled on ${txNetworkPhrase(settledTx?.chain_id ?? view.chain_id)}.`;
  } else if (view.status === "refunded") {
    state = "skipped";
    stateLabel = "Refunded instead";
    summary = "The challenge was refunded; it can no longer be settled.";
  } else if (attestation && view.status === "funded") {
    const lastFailed = settleTxs[0]?.status === "failed";
    state = lastFailed ? "error" : "current";
    stateLabel = lastFailed ? "Last attempt failed" : undefined;
    summary = lastFailed
      ? "The last settle transaction failed on chain. Nothing was paid; you can relay again if the attestation is still valid."
      : "Ready to relay. Anyone may send it.";
  }
  const recipient = detailString(settledTx, "recipient") ?? attestation?.typed_data.message.recipient ?? null;
  return (
    <TimelineStep index={5} id="step-settled" title="Settled" state={state} stateLabel={stateLabel} summary={summary}>
      {view.status === "settled" ? (
        <div className="space-y-3">
          <Callout tone="ok" icon={<CircleCheck />} title={`Settled on ${txNetworkPhrase(settledTx?.chain_id ?? view.chain_id)}`} role="status">
            The contract credited {formatWei(detailString(settledTx, "reward_wei") ?? settlement.onchain?.reward_wei ?? view.reward_wei, view.network)}{" "}
            to <Address value={recipient} label="recipient" />.
          </Callout>
          {settledTx ? (
            <KeyValueList
              items={[
                { key: "tx", label: "Settle transaction", value: <TxHash hash={settledTx.hash} chainId={settledTx.chain_id} label="settle transaction hash" /> },
                {
                  key: "blk",
                  label: "Block",
                  value: settledTx.block_number != null ? <span className="font-mono tabular">{settledTx.block_number}</span> : "n/a",
                },
                {
                  key: "relayer",
                  label: "Relayed by",
                  value: settledTx.from_addr ? (
                    <Address
                      value={settledTx.from_addr}
                      label="relayer"
                      note={sameAddress(settledTx.from_addr, recipient) ? "the recipient" : "not the recipient - the reward still went to the recipient"}
                    />
                  ) : (
                    "n/a"
                  ),
                },
                ...(detailString(settledTx, "evidence_digest")
                  ? [
                      {
                        key: "ev",
                        label: "Evidence digest in the event",
                        value: <Digest value={detailString(settledTx, "evidence_digest")} label="settled evidence digest" />,
                      },
                    ]
                  : []),
              ]}
            />
          ) : (
            <p className="text-xs text-muted">The backend marks this challenge settled, but no settle transaction row is attached to it.</p>
          )}
          <TrustStatement kind="receipt" />
        </div>
      ) : attestation && view.status === "funded" ? (
        <SettleAction view={view} attestation={attestation} onchain={settlement.onchain} nowSec={nowSec} {...target} />
      ) : (
        <p className="text-sm text-muted">
          The settle button appears here once the declared evaluator has signed an attestation for a verified violation.
        </p>
      )}
      {settleTxs.some((t) => t.status !== "confirmed") ? (
        <RecordedTxList txs={settleTxs.filter((t) => t.status !== "confirmed")} className="mt-3" />
      ) : null}
      <FailedAttempts entries={attempts} className="mt-3" />
    </TimelineStep>
  );
}

function WithdrawStep({
  view,
  settlement,
  attestation,
  target,
  settledTx,
  refundTx,
}: {
  view: ChallengeView;
  settlement: Settlement;
  attestation: SettlementAttestation | null;
  target: ChainTarget;
  settledTx: ReturnType<typeof confirmedTx>;
  refundTx: ReturnType<typeof confirmedTx>;
}) {
  const settled = view.status === "settled";
  const refunded = view.status === "refunded";
  const beneficiary = settled
    ? (detailString(settledTx, "recipient") ?? attestation?.typed_data.message.recipient ?? null)
    : refunded
      ? (detailString(refundTx, "publisher") ?? settlement.onchain?.publisher ?? view.spec.publisher.address)
      : null;
  const role = settled ? "recipient" : "publisher";
  const withdrawTxs = txsOfKind(view.transactions, "withdraw");
  const beneficiaryWithdrawal = withdrawTxs.find((t) => t.status === "confirmed" && sameAddress(detailString(t, "account"), beneficiary)) ?? null;

  let state: TimelineState = "upcoming";
  let summary = "Credits can be withdrawn after a settlement (by the recipient) or a refund (by the publisher).";
  if (beneficiary && beneficiaryWithdrawal) {
    state = "complete";
    summary = `The ${role} withdrew ${formatWei(detailString(beneficiaryWithdrawal, "amount_wei"), view.network)} on ${txNetworkPhrase(beneficiaryWithdrawal.chain_id)}.`;
  } else if (beneficiary) {
    state = "current";
    summary = `The ${role}'s credit sits in the contract until the ${role} withdraws it. No withdrawal by the ${role} is recorded for this challenge.`;
  }
  return (
    <TimelineStep index={6} id="step-withdrawn" title="Withdrawn" state={state} summary={summary} last>
      {beneficiary ? (
        <WithdrawAction view={view} beneficiary={beneficiary} beneficiaryRole={role} {...target} />
      ) : (
        <p className="text-sm text-muted">Nothing to withdraw yet.</p>
      )}
      <RecordedTxList
        txs={withdrawTxs}
        className="mt-3"
        renderDetail={(t) =>
          t.status === "confirmed" && detailString(t, "amount_wei") ? (
            <p className="mt-1 text-xs text-muted">
              {formatWei(detailString(t, "amount_wei"), view.network)} from the credit of{" "}
              <Address value={detailString(t, "account")} label="account" /> to <Address value={detailString(t, "to")} label="destination" />
            </p>
          ) : null
        }
      />
      <FailedAttempts entries={failedAttempts(view.activity, ["withdraw"])} className="mt-3" />
    </TimelineStep>
  );
}
