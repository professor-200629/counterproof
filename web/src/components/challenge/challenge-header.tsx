"use client";

import { GitCompare, Scale } from "lucide-react";
import type { ReactNode } from "react";
import { TrustStatement } from "@/components/truth";
import { TxHash } from "@/components/tx-hash";
import { Address } from "@/components/ui/address";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { ProvenanceBadge } from "@/components/ui/provenance-badge";
import { PageHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { Countdown, DateTime, TimeAgo } from "@/components/ui/time";
import type { ChallengeView } from "@/lib/api";
import { formatWei, txNetworkPhrase } from "@/lib/chain";
import { TextLink } from "@/components/ui/text-link";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-1 min-w-0 text-sm text-fg">{children}</dd>
    </div>
  );
}

/** Page header + the challenge's identifying facts (digest, reward, deadlines, funding). */
export function ChallengeHeader({ view, now }: { view: ChallengeView; now: number | null }) {
  const offchain = view.status === "offchain" || view.network === "offchain";
  const deadlines = view.spec.deadlines;
  const submissionsClosed = now !== null && now / 1000 > deadlines.submission_deadline;

  return (
    <>
      <PageHeader
        breadcrumb={<Breadcrumbs items={[{ label: "Challenges", href: "/challenges" }, { label: `#${view.id}`, mono: true }]} />}
        title={view.spec.title}
        description={
          view.spec.publisher.name || view.spec.publisher.address ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              Published by {view.spec.publisher.name ? <span className="text-fg">{view.spec.publisher.name}</span> : null}
              <Address value={view.spec.publisher.address} label="publisher address" />
              <span className="text-subtle">-</span> created <TimeAgo ts={view.created_at} />
            </span>
          ) : null
        }
        meta={
          <>
            <StatusBadge status={view.status} domain="challenge" />
            <ProvenanceBadge kind="target" value={view.spec.target.label} requiresModel={view.target_info?.requires_model} />
            <ProvenanceBadge kind="network" value={view.network} />
          </>
        }
        actions={
          <>
            <ButtonLink href={`/challenges/${view.id}/settlement`} icon={<Scale />}>
              Settlement
            </ButtonLink>
            <ButtonLink href={`/challenges/${view.id}/compare`} icon={<GitCompare />}>
              Repair and regression
            </ButtonLink>
          </>
        }
      />

      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Spec digest">
          <Digest value={view.spec_digest} label="spec digest" />
        </Fact>
        <Fact label="Target under test">
          <span className="font-mono text-xs">
            {view.spec.target.adapter}@{view.spec.target.version}
          </span>
        </Fact>
        <Fact label="Reward">
          {offchain ? (
            <span className="text-muted">None - off-chain, evidence only</span>
          ) : (
            <span>
              <span className="font-semibold tabular">{formatWei(view.reward_wei, view.network)}</span>
              {view.status === "awaiting_funding" ? <span className="text-warn"> (not escrowed yet)</span> : null}
            </span>
          )}
        </Fact>
        <Fact label="On-chain challenge id">
          {offchain ? (
            <span className="text-muted">None (off-chain)</span>
          ) : view.onchain_id ? (
            <span>
              <span className="font-mono text-xs">#{view.onchain_id}</span>
              <span className="text-xs text-muted"> on {txNetworkPhrase(view.chain_id)}</span>
            </span>
          ) : (
            <span className="text-warn">Not assigned until funding confirms</span>
          )}
        </Fact>
        <Fact label="Submissions close">
          <span className="flex flex-col">
            <DateTime ts={deadlines.submission_deadline} />
            <Countdown to={deadlines.submission_deadline} prefix="in" expiredText="closed" className="text-xs" />
          </span>
        </Fact>
        <Fact label="Settlement deadline">
          <span className="flex flex-col">
            <DateTime ts={deadlines.settlement_deadline} />
            <Countdown
              to={deadlines.settlement_deadline}
              prefix="in"
              expiredText={offchain ? "passed" : "passed - refund possible if unsettled"}
              className="text-xs"
            />
          </span>
        </Fact>
        <Fact label="Funding transaction">
          {view.fund_tx ? (
            <TxHash hash={view.fund_tx} chainId={view.chain_id} label="funding transaction hash" head={8} tail={6} />
          ) : offchain ? (
            <span className="text-muted">Not applicable</span>
          ) : (
            <span className="text-warn">None recorded yet</span>
          )}
        </Fact>
        <Fact label="Contract">
          {view.contract ? <Address value={view.contract} label="contract address" /> : <span className="text-muted">None</span>}
        </Fact>
      </dl>

      {view.fund_tx ? <TrustStatement kind="receipt" className="mt-2" /> : null}

      <div className="mt-4 space-y-3">
        {view.status === "awaiting_funding" ? (
          <Callout tone="warn" title="Awaiting funding">
            The reward has not been escrowed by a confirmed transaction yet. Until it is, the backend refuses search runs and
            submissions for this challenge. The publisher can fund it from the{" "}
            <TextLink href={`/challenges/${view.id}/settlement#step-funded`}>Settlement page</TextLink>.
          </Callout>
        ) : null}
        {submissionsClosed && (view.status === "funded" || view.status === "offchain") ? (
          <Callout tone="neutral" title="Submission deadline passed">
            No new search runs or submissions are accepted. Existing evidence stays available.
          </Callout>
        ) : null}
        {view.note ? (
          <Callout tone="neutral" title="Backend note">
            {view.note}
          </Callout>
        ) : null}
      </div>
    </>
  );
}
