"use client";

import { FilePlus2 } from "lucide-react";
import { useState } from "react";
import { TrustStatement } from "@/components/truth";
import { Button, ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/section";
import { EmptyState, ErrorState, QueryState } from "@/components/ui/states";
import type { ChallengeListItem, ChallengeStatus } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatNumber, plural } from "@/lib/format";
import { useChallenges, useConfig } from "@/lib/queries";
import { KNOWN_STATUSES, statusMeta } from "@/lib/status";
import { ChallengesTable } from "./challenges-table";
import { ChallengeLoop, productIntro, sortNewest } from "./shared";

type FilterId = "all" | "verified" | "active" | ChallengeStatus;

interface FilterOption {
  id: FilterId;
  label: string;
  count: number;
}

function matches(filter: FilterId, c: ChallengeListItem): boolean {
  if (filter === "all") return true;
  if (filter === "verified") return c.counts.verified > 0;
  if (filter === "active") return c.counts.active_runs > 0;
  return c.status === filter;
}

function buildFilters(items: ChallengeListItem[]): FilterOption[] {
  const out: FilterOption[] = [{ id: "all", label: "All", count: items.length }];
  const verified = items.filter((c) => matches("verified", c)).length;
  if (verified > 0) out.push({ id: "verified", label: "With verified violations", count: verified });
  const active = items.filter((c) => matches("active", c)).length;
  if (active > 0) out.push({ id: "active", label: "Runs in progress", count: active });
  for (const status of KNOWN_STATUSES.challenge as readonly ChallengeStatus[]) {
    const n = items.filter((c) => c.status === status).length;
    if (n > 0) out.push({ id: status, label: statusMeta(status, "challenge").label, count: n });
  }
  // Statuses the backend sends that this build does not know yet still get a filter.
  const unknown = Array.from(new Set(items.map((c) => c.status))).filter(
    (s) => !(KNOWN_STATUSES.challenge as readonly string[]).includes(s),
  );
  for (const status of unknown) {
    out.push({ id: status, label: statusMeta(status, "challenge").label, count: items.filter((c) => c.status === status).length });
  }
  return out;
}

/** The Challenges page (/challenges): every challenge on this backend with a status filter. */
export function ChallengesListView() {
  const q = useChallenges();
  const { data: config } = useConfig();
  const [filter, setFilter] = useState<FilterId>("all");

  const header = (
    <PageHeader
      title="Challenges"
      description="Every promise published on this backend, newest first. Open one to see its rules, runs, the evaluator's replays, settlement and regression tests."
      actions={
        <ButtonLink href="/challenges/new" variant="primary" icon={<FilePlus2 />}>
          Create challenge
        </ButtonLink>
      }
    />
  );

  if (!q.data) {
    return (
      <>
        {header}
        <QueryState query={q} label="challenges" rows={6} card />
      </>
    );
  }

  const all = sortNewest(q.data);

  if (all.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          title="No challenges yet"
          description={productIntro(config?.network)}
          action={
            <ButtonLink href="/challenges/new" variant="primary" icon={<FilePlus2 />}>
              Create the first challenge
            </ButtonLink>
          }
        />
        <ChallengeLoop className="mt-6" />
      </>
    );
  }

  const options = buildFilters(all);
  const current = options.find((o) => o.id === filter) ?? options[0];
  const shown = all.filter((c) => matches(current.id, c));
  const verifiedTotal = all.reduce((n, c) => n + c.counts.verified, 0);

  return (
    <>
      {header}
      <div className="space-y-4">
        {q.isError ? (
          <ErrorState compact title="Could not refresh; showing the last loaded list" error={q.error} onRetry={() => void q.refetch()} />
        ) : null}

        {options.length > 1 ? (
          <div role="group" aria-label="Filter challenges" className="flex flex-wrap gap-2">
            {options.map((o) => {
              const pressed = current.id === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => setFilter(o.id)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
                    pressed
                      ? "border-accent-line bg-accent-soft text-accent-text"
                      : "border-line bg-surface text-muted hover:border-line-strong hover:text-fg",
                  )}
                >
                  {o.label}
                  <span className="tabular opacity-80">{formatNumber(o.count)}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        <p className="text-sm text-muted" aria-live="polite">
          {current.id === "all"
            ? `${formatNumber(all.length)} ${plural(all.length, "challenge")}, ${formatNumber(verifiedTotal)} verified ${plural(verifiedTotal, "violation")} in total.`
            : `Showing ${formatNumber(shown.length)} of ${formatNumber(all.length)} ${plural(all.length, "challenge")}: ${current.label.toLowerCase()}.`}
        </p>

        {shown.length > 0 ? (
          <ChallengesTable items={shown} caption={current.id === "all" ? "All challenges" : `Challenges: ${current.label}`} />
        ) : (
          <EmptyState
            compact
            title="No challenge matches this filter"
            action={
              <Button size="sm" onClick={() => setFilter("all")}>
                Show all challenges
              </Button>
            }
          />
        )}

        <div className="space-y-1 pt-2">
          <TrustStatement kind="not-proof" />
          <TrustStatement kind="attestation" />
        </div>
      </div>
    </>
  );
}
