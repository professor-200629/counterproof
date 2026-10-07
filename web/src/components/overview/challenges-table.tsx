"use client";

import { Card } from "@/components/ui/card";
import { ProvenanceBadge } from "@/components/ui/provenance-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { TBody, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { TextLink } from "@/components/ui/text-link";
import { TimeAgo } from "@/components/ui/time";
import type { ChallengeListItem } from "@/lib/api";
import { formatWei } from "@/lib/chain";
import { formatNumber, plural } from "@/lib/format";
import { Deadlines } from "./deadline";
import { SNAPSHOT_MODE } from "@/lib/snapshot";

export interface ChallengesTableProps {
  items: ChallengeListItem[];
  /** Accessible name of the table / list ("Most recent challenges"). */
  caption: string;
  className?: string;
}

/**
 * Challenges as a table (xl and up, where it fits beside the nav) or cards (one column on
 * phones, two on tablets). Every figure is a backend
 * count from GET /api/challenges; nothing is derived beyond formatting.
 */
export function ChallengesTable({ items, caption, className }: ChallengesTableProps) {
  return (
    <div className={className}>
      <ul aria-label={caption} className="grid gap-3 md:grid-cols-2 xl:hidden">
        {items.map((c) => (
          <ChallengeCard key={c.id} c={c} />
        ))}
      </ul>
      <div className="hidden xl:block">
        <Table caption={caption}>
          <THead>
            <tr>
              <TH>Challenge</TH>
              <TH>Target</TH>
              <TH className="text-right">Rules</TH>
              <TH>Status and network</TH>
              <TH>Evaluator results</TH>
              <TH>Deadlines</TH>
            </tr>
          </THead>
          <TBody>
            {items.map((c) => (
              <TR key={c.id}>
                <TD className="min-w-[12rem]">
                  <TitleCell c={c} />
                </TD>
                <TD className="min-w-[11rem] max-w-[15rem]">
                  <TargetCell c={c} />
                </TD>
                <TD numeric>
                  <RulesCell c={c} align="right" />
                </TD>
                <TD className="min-w-[11rem]">
                  <StatusCell c={c} />
                </TD>
                <TD className="min-w-[9rem]">
                  <ResultsCell c={c} />
                </TD>
                <TD className="min-w-[12rem]">
                  <Deadlines
                    submission={c.deadlines.submission_deadline}
                    settlement={c.deadlines.settlement_deadline}
                    quiet={isClosed(c)}
                  />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    </div>
  );
}

function isClosed(c: ChallengeListItem): boolean {
  return c.status === "settled" || c.status === "refunded";
}

function TitleCell({ c }: { c: ChallengeListItem }) {
  return (
    <div className="min-w-0">
      <TextLink href={`/challenges/${c.id}`} className="font-medium break-words">
        {c.title || `Challenge #${c.id}`}
      </TextLink>
      <p className="mt-0.5 text-xs text-subtle">
        #{c.id} - created <TimeAgo ts={c.created_at} />
      </p>
    </div>
  );
}

function TargetCell({ c }: { c: ChallengeListItem }) {
  return (
    <div className="space-y-1.5">
      <p className="break-all font-mono text-xs text-fg">
        {c.target.adapter}@{c.target.version}
      </p>
      <ProvenanceBadge kind="target" value={c.target.label} />
      <p className="text-xs text-subtle">{c.target.determinism}</p>
    </div>
  );
}

function RulesCell({ c, align = "left" }: { c: ChallengeListItem; align?: "left" | "right" }) {
  const n = c.rules.length;
  return (
    <div className={align === "right" ? "text-right" : undefined}>
      <span className="tabular font-medium text-fg">{formatNumber(n)}</span>{" "}
      <span className="text-xs text-muted">{plural(n, "rule")}</span>
      {n > 0 ? (
        <p className="mt-0.5 whitespace-nowrap font-mono text-[11px] text-subtle" title={c.rules.map((r) => `${r.id}: ${r.statement}`).join("\n")}>
          {c.rules.map((r) => r.id).join(" ")}
        </p>
      ) : null}
    </div>
  );
}

function StatusCell({ c }: { c: ChallengeListItem }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <StatusBadge status={c.status} domain="challenge" />
      <ProvenanceBadge kind="network" value={c.network} size="sm" />
      {c.network !== "offchain" ? (
        <p className="text-xs tabular text-muted">Reward {formatWei(c.reward_wei, c.network)}</p>
      ) : null}
      {c.supersedes ? <p className="text-xs text-subtle">Revises an earlier spec</p> : null}
    </div>
  );
}

function ResultsCell({ c }: { c: ChallengeListItem }) {
  const { verified, not_reproduced, runs, active_runs, candidates } = c.counts;
  return (
    <ul className="space-y-0.5 text-xs">
      <li className={verified > 0 ? "font-semibold text-bad" : "text-muted"}>
        <span className="tabular">{formatNumber(verified)}</span> verified {plural(verified, "violation")}
      </li>
      <li className={not_reproduced > 0 ? "text-ok" : "text-muted"}>
        <span className="tabular">{formatNumber(not_reproduced)}</span> not reproduced
      </li>
      <li className="text-subtle">
        <span className="tabular">{formatNumber(runs)}</span> {plural(runs, "run")},{" "}
        <span className="tabular">{formatNumber(candidates)}</span> {plural(candidates, "candidate")}
      </li>
      {active_runs > 0 ? (
        <li className="text-warn">
          <span className="tabular">{formatNumber(active_runs)}</span> {plural(active_runs, "run")} queued or running
          {SNAPSHOT_MODE ? " when recorded" : ""}
        </li>
      ) : null}
    </ul>
  );
}

function ChallengeCard({ c }: { c: ChallengeListItem }) {
  return (
    <Card as="li" padded className="@container space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <TitleCell c={c} />
        <StatusBadge status={c.status} domain="challenge" />
      </div>
      <TargetCell c={c} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ProvenanceBadge kind="network" value={c.network} size="sm" />
        <RulesCell c={c} />
        {c.network !== "offchain" ? (
          <span className="text-xs tabular text-muted">Reward {formatWei(c.reward_wei, c.network)}</span>
        ) : null}
      </div>
      <div className="grid gap-3 border-t border-line pt-3 @md:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-medium text-muted">Evaluator results</p>
          <ResultsCell c={c} />
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted">Deadlines</p>
          <Deadlines
            submission={c.deadlines.submission_deadline}
            settlement={c.deadlines.settlement_deadline}
            quiet={isClosed(c)}
          />
        </div>
      </div>
    </Card>
  );
}
