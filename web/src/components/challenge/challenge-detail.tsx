"use client";

import { ShieldAlert } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/section";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { ErrorState, QueryState } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { useNow } from "@/components/ui/time";
import { finishedSummary, type ChallengeView } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { useChallenge, useConfig, useRuleTemplates } from "@/lib/queries";
import { isEvaluationActive, isRunActive } from "@/lib/status";
import { SNAPSHOT_MODE } from "@/lib/snapshot";
import { ActivityTab } from "./activity-tab";
import { ChallengeHeader } from "./challenge-header";
import { FindingsTab } from "./findings-tab";
import { PromiseTab } from "./promise-tab";
import { TestingTab } from "./testing-tab";
import { TextLink } from "@/components/ui/text-link";

const TAB_IDS = ["promise", "testing", "findings", "activity"] as const;
type TabId = (typeof TAB_IDS)[number];

function isTabId(v: string | null): v is TabId {
  return !!v && (TAB_IDS as readonly string[]).includes(v);
}

/** Challenge detail: header facts, a short summary, then four tabs. Tab state lives in `?tab=`. */
export function ChallengeDetail({ id }: { id: string }) {
  const q = useChallenge(id);
  const config = useConfig();
  const templates = useRuleTemplates();
  const now = useNow(5_000);
  const search = useSearchParams();
  const tabParam = search.get("tab");
  const tab: TabId = isTabId(tabParam) ? tabParam : "promise";

  const setTab = useCallback(
    (next: string) => {
      const params = new URLSearchParams(search.toString());
      if (next === "promise") params.delete("tab");
      else params.set("tab", next);
      const qs = params.toString();
      // Native history integrates with the Next router and keeps useSearchParams in sync.
      window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    },
    [search],
  );

  if (!q.data) {
    return (
      <>
        <PageHeader
          title={`Challenge #${id}`}
          breadcrumb={<Breadcrumbs items={[{ label: "Challenges", href: "/challenges" }, { label: `#${id}`, mono: true }]} />}
        />
        <QueryState
          query={q}
          label="challenge"
          rows={8}
          card
          errorTitle="Could not load the challenge"
          notFound={{
            title: `Challenge #${id} does not exist`,
            description: "The backend has no challenge with this id.",
            action: <ButtonLink href="/challenges">All challenges</ButtonLink>,
          }}
        />
      </>
    );
  }

  const view = q.data;
  const nowMs = now;
  const unverified = view.candidates.filter((c) => c.status === "candidate_found").length;
  const activeRuns = view.runs.filter((r) => isRunActive(r.status)).length;
  const activeEvals = view.evaluations.filter((e) => isEvaluationActive(e.status)).length;

  return (
    <div className="space-y-6">
      <div>
        <ChallengeHeader view={view} now={nowMs} />
        {q.isError ? (
          <ErrorState error={q.error} title="Refresh failed - showing the last data received" compact className="mt-3" />
        ) : null}
      </div>

      <Summary view={view} activeRuns={activeRuns} activeEvals={activeEvals} unverified={unverified} />

      <Tabs
        label="Challenge sections"
        value={tab}
        onChange={setTab}
        items={[
          {
            id: "promise",
            label: "Promise and scope",
            content: <PromiseTab view={view} config={config.data ?? null} templates={templates.data} />,
          },
          {
            id: "testing",
            label: SNAPSHOT_MODE ? "Testing (recorded)" : "Live testing",
            badge: view.runs.length ? (activeRuns ? `${activeRuns} active` : view.runs.length) : undefined,
            content: <TestingTab view={view} config={config.data ?? null} nowMs={nowMs} onShowFindings={() => setTab("findings")} />,
          },
          {
            id: "findings",
            label: "Findings",
            badge: view.candidates.length + view.evaluations.length || undefined,
            content: <FindingsTab view={view} config={config.data ?? null} nowMs={nowMs} />,
          },
          {
            id: "activity",
            label: "Activity",
            badge: view.activity.length || undefined,
            content: <ActivityTab view={view} />,
          },
        ]}
      />
    </div>
  );
}

function Summary({
  view,
  activeRuns,
  activeEvals,
  unverified,
}: {
  view: ChallengeView;
  activeRuns: number;
  activeEvals: number;
  unverified: number;
}) {
  const verified = view.evaluations.filter((e) => e.outcome === "verified_violation");
  const notReproduced = view.evaluations.filter((e) => e.outcome === "not_reproduced").length;
  const latest = [...verified].sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0))[0] ?? null;
  const latestSummary = finishedSummary(latest);
  return (
    <div className="space-y-3">
      <StatGrid columns={4}>
        <Stat
          label="Search runs"
          value={formatNumber(view.runs.length)}
          hint={
            SNAPSHOT_MODE
              ? activeRuns
                ? `${activeRuns} running or queued when recorded`
                : "none active when recorded"
              : activeRuns
                ? `${activeRuns} running or queued`
                : "none active"
          }
        />
        <Stat
          label="Unverified candidates"
          value={formatNumber(unverified)}
          tone={unverified ? "warn" : undefined}
          hint="challenger self-checks, not evidence"
        />
        <Stat
          label="Independent replays"
          value={formatNumber(view.evaluations.length)}
          hint={activeEvals ? `${activeEvals} still replaying${SNAPSHOT_MODE ? " when recorded" : ""}` : `${notReproduced} not reproduced`}
        />
        <Stat
          label="Verified violations"
          value={formatNumber(verified.length)}
          tone={verified.length ? "bad" : undefined}
          hint="by the declared trusted evaluator"
        />
      </StatGrid>
      {latest ? (
        <Callout tone="bad" icon={<ShieldAlert />} title="Verified violation">
          <p>
            {latestSummary?.rule ? (
              <>
                <span className="font-mono text-xs">{latestSummary.rule.rule_id}</span> {latestSummary.rule.statement}{" "}
              </>
            ) : null}
            {latestSummary?.summary ? <span className="text-fg">- {latestSummary.summary}</span> : null}
          </p>
          <p className="mt-1">
            <TextLink href={`/evaluations/${latest.id}`}>Open the evidence</TextLink>
          </p>
        </Callout>
      ) : null}
    </div>
  );
}
