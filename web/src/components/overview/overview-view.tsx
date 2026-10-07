"use client";

import { FilePlus2 } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader, Section } from "@/components/ui/section";
import { Stat, StatGrid } from "@/components/ui/stat";
import { ErrorState, Loading, QueryState } from "@/components/ui/states";
import { TextLink } from "@/components/ui/text-link";
import { isBackendUnreachable, type Overview } from "@/lib/api";
import { formatNumber, plural } from "@/lib/format";
import { POLL_MS, useChallenges, useConfig, useOverview } from "@/lib/queries";
import { RecordedMark } from "@/components/snapshot";
import { ActivityFeed } from "./activity-feed";
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

  const header = (
    <PageHeader
      title="Overview"
      description="Promises about AI purchasing agents, the counterexamples found against them, and what the declared trusted evaluator verified on replay."
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
        {overview.data ? (
          <>
            {overview.isError ? (
              <ErrorState
                compact
                title="Could not refresh; showing the last loaded counts"
                error={overview.error}
                onRetry={() => void overview.refetch()}
              />
            ) : null}
            <OverviewStats data={overview.data} />
          </>
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

function OverviewStats({ data }: { data: Overview }) {
  return (
    <StatGrid columns={2} className="lg:grid-cols-5">
      <Stat
        className="col-span-2 lg:col-span-1"
        label="Challenges"
        value={formatNumber(data.challenges)}
        hint={SNAPSHOT_MODE && SNAPSHOT_MANIFEST
          ? `included in this recorded snapshot (${SNAPSHOT_MANIFEST.challenges_included.length} of ${SNAPSHOT_MANIFEST.challenges_on_evaluator} on the evaluator)`
          : "published on this backend"}
      />
      <Stat label="Funded" value={formatNumber(data.funded)} hint="reward escrowed, not yet settled or refunded" />
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
        hint="evaluator replays that reproduced a rule violation"
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
