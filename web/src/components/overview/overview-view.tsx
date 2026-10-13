"use client";

import { FilePlus2 } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader, Section } from "@/components/ui/section";
import { Stat, StatGrid } from "@/components/ui/stat";
import { ErrorState, Loading, QueryState } from "@/components/ui/states";
import { TextLink } from "@/components/ui/text-link";
import { isBackendUnreachable, type ChallengeListItem, type NetworkKind, type Overview } from "@/lib/api";
import { nativeSymbol } from "@/lib/chain";
import { formatNumber, plural } from "@/lib/format";
import { POLL_MS, useChallenges, useConfig, useOverview } from "@/lib/queries";
import { RecordedMark } from "@/components/snapshot";
import { ActivityFeed } from "./activity-feed";
import { everFunded, verifiedSplit } from "./featured-data";
import { FeaturedFinding } from "./featured-finding";
import { ChallengesTable } from "./challenges-table";
import { EnvironmentPanel } from "./environment-panel";
import { ProofLimits } from "./proof-limits";
import { ChallengeLoop, productIntro, sortNewest } from "./shared";
import { SNAPSHOT_MANIFEST, SNAPSHOT_MODE } from "@/lib/snapshot";

/** How many challenges the overview lists before linking to /challenges. */
const OVERVIEW_ROWS = 6;

/** The Overview page (/): real counts, recent challenges, activity, environment and the truth rules. */
export function OverviewView() {
  const overview = useOverview();
  const challenges = useChallenges();
  const config = useConfig();

  const header = (
    <PageHeader
      title="Overview"
      description={SNAPSHOT_MODE ? undefined : "Promises about AI purchasing agents, the counterexamples found against them, and what the declared trusted evaluator verified on replay."}
      actions={
        SNAPSHOT_MODE ? (
          <ButtonLink href="/challenges/new" icon={<FilePlus2 />}>
            How a challenge is created
          </ButtonLink>
        ) : (
          <ButtonLink href="/challenges/new" variant="primary" icon={<FilePlus2 />}>
            Create challenge
          </ButtonLink>
        )
      }
    />
  );

  // Backend down: one clear error instead of one per panel.
  if (!overview.data && overview.isError && isBackendUnreachable(overview.error)) {
    return (
      <>
        {header}
        <div className="space-y-8">
          <ErrorState
            error={overview.error}
            onRetry={() => {
              void overview.refetch();
              void challenges.refetch();
            }}
          />
          <ProofLimits />
        </div>
      </>
    );
  }

  const empty = overview.data?.challenges === 0 || (challenges.data !== undefined && challenges.data.length === 0);

  if (empty) {
    return (
      <>
        {header}
        <div className="space-y-8">
          <FirstChallenge />
          <div className="grid gap-8 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <EnvironmentPanel />
            <ProofLimits />
          </div>
        </div>
      </>
    );
  }

  const sorted = challenges.data ? sortNewest(challenges.data) : [];
  const recent = sorted.slice(0, OVERVIEW_ROWS);

  return (
    <>
      {header}
      <div className="space-y-8">
        {challenges.data ? (
          <FeaturedFinding challenges={challenges.data} />
        ) : challenges.isPending ? (
          <Loading label="featured finding" rows={3} card />
        ) : null}

        {overview.data ? (
          <div className="space-y-2">
            {overview.isError ? (
              <ErrorState
                compact
                title="Could not refresh; showing the last loaded counts"
                error={overview.error}
                onRetry={() => void overview.refetch()}
              />
            ) : null}
            <OverviewStats data={overview.data} list={challenges.data ?? null} />
            <CurrencyLegend network={SNAPSHOT_MANIFEST?.network ?? config.data?.network ?? null} />
          </div>
        ) : overview.isPending ? (
          <Loading label="overview counts" rows={2} card />
        ) : (
          <ErrorState error={overview.error} title="Could not load the overview counts" onRetry={() => void overview.refetch()} />
        )}

        <Section
          id="challenges"
          title="Challenges"
          description="Most recent first. Results are outcomes recorded by the evaluator on this backend."
          actions={
            sorted.length > 0 ? (
              <ButtonLink href="/challenges" size="sm">
                All challenges ({formatNumber(sorted.length)})
              </ButtonLink>
            ) : null
          }
        >
          {challenges.data ? (
            <>
              {challenges.isError ? (
                <ErrorState
                  compact
                  className="mb-3"
                  title="Could not refresh; showing the last loaded list"
                  error={challenges.error}
                  onRetry={() => void challenges.refetch()}
                />
              ) : null}
              <ChallengesTable items={recent} caption="Most recent challenges" />
              {sorted.length > recent.length ? (
                <p className="mt-2 text-sm text-muted">
                  Showing {recent.length} of {sorted.length}.{" "}
                  <TextLink href="/challenges">View all challenges</TextLink>
                </p>
              ) : null}
            </>
          ) : (
            <QueryState query={challenges} label="challenges" rows={4} card />
          )}
        </Section>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Section id="activity" title="Recent activity" description="What the backend recorded, with links to the challenge, evidence or transaction.">
            {overview.data ? (
              <ActivityFeed entries={overview.data.activity} challenges={challenges.data} />
            ) : (
              <QueryState query={overview} label="activity" rows={6} card />
            )}
          </Section>
          <ProofLimits className="self-start" />
        </div>

        <EnvironmentPanel />
      </div>
    </>
  );
}

/**
 * The overview counts. "Awaiting settlement" is the backend's `funded` count (status funded
 * now); "Ever funded" and the live-model / fixture split of verified violations are derived
 * here from the challenge list, since the overview payload does not carry them.
 */
function OverviewStats({ data, list }: { data: Overview; list: ChallengeListItem[] | null }) {
  const split = list ? verifiedSplit(list) : null;
  const partial = !!list && SNAPSHOT_MODE && SNAPSHOT_MANIFEST !== null && SNAPSHOT_MANIFEST.challenges_included.length < SNAPSHOT_MANIFEST.challenges_on_evaluator;
  return (
    <StatGrid columns={6}>
      <Stat
        label="Challenges"
        value={formatNumber(data.challenges)}
        hint={SNAPSHOT_MODE && SNAPSHOT_MANIFEST
          ? `included in this recorded snapshot (${SNAPSHOT_MANIFEST.challenges_included.length} of ${SNAPSHOT_MANIFEST.challenges_on_evaluator} on the evaluator)`
          : "published on this backend"}
      />
      <Stat
        label="Awaiting settlement"
        value={formatNumber(data.funded)}
        hint="funded now: reward escrowed, not yet settled or refunded"
      />
      <Stat
        label="Ever funded"
        value={list ? formatNumber(everFunded(list)) : "-"}
        hint={
          list
            ? `challenges with a recorded funding transaction, whatever their status now${partial ? " (of those included)" : ""}`
            : "needs the challenge list, which has not loaded"
        }
      />
      <Stat
        label={
          <>
            Active runs <RecordedMark what="This count" />
          </>
        }
        value={formatNumber(data.active_runs)}
        tone={data.active_runs > 0 ? "warn" : undefined}
        hint={
          SNAPSHOT_MODE
            ? data.active_runs > 0
              ? `${plural(data.active_runs, "search", "searches")} queued or running when recorded; not refreshing`
              : "no search queued or running when recorded"
            : data.active_runs > 0
              ? `${plural(data.active_runs, "search", "searches")} queued or running; refreshing every ${POLL_MS / 1000} s`
              : "no search queued or running"
        }
      />
      <Stat
        label="Verified violations"
        value={formatNumber(data.verified_violations)}
        tone={data.verified_violations > 0 ? "bad" : undefined}
        hint={<VerifiedHint total={data.verified_violations} split={split} />}
      />
      <Stat
        label="Settled"
        value={formatNumber(data.settled)}
        tone={data.settled > 0 ? "ok" : undefined}
        hint="attestation accepted on chain, recipient credited"
      />
    </StatGrid>
  );
}

/** What the verified-violation count is made of: live-model agents vs planted-defect fixtures. */
function VerifiedHint({ total, split }: { total: number; split: ReturnType<typeof verifiedSplit> | null }) {
  const base = "evaluations whose replays reproduced a rule violation";
  if (!split || total === 0) return <>{base}</>;
  const parts = [
    `${formatNumber(split.liveModel)} on a live-model agent`,
    `${formatNumber(split.plantedFixture)} on a planted-defect fixture`,
    ...(split.other > 0 ? [`${formatNumber(split.other)} on another target`] : []),
  ];
  return (
    <>
      {base}: {parts.join(", ")}
      {split.listed !== total ? ` (split covers the ${formatNumber(split.listed)} in the listed challenges)` : ""}
    </>
  );
}

/**
 * Two currencies appear in this console and must not be confused: rewards in the network's
 * native token (testnet MON on Monad testnet), and amounts inside the invented marketplace
 * (SYN), which are synthetic units.
 */
function CurrencyLegend({ network }: { network: NetworkKind | string | null }) {
  const symbol = nativeSymbol(network);
  const reward =
    network === "monad-testnet"
      ? "Rewards in testnet MON: Monad testnet's native token, moved by real testnet transactions; it has no monetary value."
      : network === "anvil-local"
        ? `Rewards in ${symbol}: a value on a local development chain (31337), not Monad and of no value.`
        : network === "offchain"
          ? "No rewards: this backend runs off-chain and escrows nothing."
          : "Rewards are in the settlement network's native token.";
  return (
    <dl aria-label="Currencies on this page" className="grid gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-2">
      <div className="flex min-w-0 gap-1.5">
        <dt className="shrink-0 font-semibold text-fg">{symbol ? symbol.split(" ")[0] : "Reward"}</dt>
        <dd className="min-w-0">{reward}</dd>
      </div>
      <div className="flex min-w-0 gap-1.5">
        <dt className="shrink-0 font-semibold text-fg">SYN</dt>
        <dd className="min-w-0">
          Prices, budgets and payments inside the invented marketplace: synthetic units, no real money or account.
        </dd>
      </div>
    </dl>
  );
}

function FirstChallenge() {
  const { data: config } = useConfig();
  return (
    <Card as="section" aria-labelledby="first-challenge-heading" padded className="space-y-5">
      <div className="flex flex-col items-start gap-3">
        <h2 id="first-challenge-heading" className="text-base font-semibold text-fg">
          No challenges yet
        </h2>
        <p className="max-w-3xl text-sm text-muted">{productIntro(config?.network)}</p>
        {SNAPSHOT_MODE ? (
          <ButtonLink href="/challenges/new" icon={<FilePlus2 />}>
            How a challenge is created
          </ButtonLink>
        ) : (
          <ButtonLink href="/challenges/new" variant="primary" icon={<FilePlus2 />}>
            Create the first challenge
          </ButtonLink>
        )}
      </div>
      <ChallengeLoop className="border-t border-line pt-5" />
    </Card>
  );
}
