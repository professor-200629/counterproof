"use client";

import { Download, FileCode2, FileJson, GitCompareArrows } from "lucide-react";
import { JobFacts } from "@/components/job-facts";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { EmptyState, ErrorState, Loading } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { TimeAgo } from "@/components/ui/time";
import { regressionExportFilename, regressionExportUrl, type Regression } from "@/lib/api";
import { cn } from "@/lib/cn";
import { POLL_MS, useRegressionExport } from "@/lib/queries";
import { isRegressionActive } from "@/lib/status";
import { SNAPSHOT_MODE } from "@/lib/snapshot";
import { adapterOfKey, replayRelation } from "@/lib/target-labels";

// ---------------------------------------------------------------------------- in progress
/** A queued / replaying regression: only what the backend reports, no estimated progress. */
export function RegressionProgress({ regression }: { regression: Regression }) {
  const job = regression.job ?? null;
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={regression.status} domain="regression" />
        <span className="font-mono text-xs text-muted">{regression.target_key}</span>
      </div>
      <p className="text-sm text-muted">
        {regression.status === "queued"
          ? "Waiting for a worker. Nothing has been replayed yet."
          : SNAPSHOT_MODE
            ? "Still replaying when recorded; no verdict in this recording."
            : "The evaluator is replaying the sequence in a fresh synthetic marketplace. No verdict yet."}{" "}
        {SNAPSHOT_MODE
          ? "It had no outcome when this snapshot was recorded, and this recording does not update."
          : `This page checks again every ${POLL_MS / 1000} s until the backend reports an outcome.`}
      </p>
      <JobFacts job={job} requestedAt={regression.created_at} />
    </div>
  );
}

// ---------------------------------------------------------------------------- exports
/** JSON fixture and pytest file for a finished regression, plus what the test asserts. */
export function ExportPanel({ regression }: { regression: Regression }) {
  const finished = !!regression.outcome && !isRegressionActive(regression.status);
  const exp = useRegressionExport(regression.id, { enabled: finished });
  return (
    <Card>
      <CardHeader
        title="Export as a regression test"
        description="The same counterexample as a file you can keep: a JSON fixture, or a pytest file that replays it with the CounterProof backend."
        actions={
          finished ? (
            <>
              <ButtonLink href={regressionExportUrl(regression.id, "json")} external download={regressionExportFilename(regression.id, "json")} size="sm" icon={<FileJson />}>
                JSON
              </ButtonLink>
              <ButtonLink href={regressionExportUrl(regression.id, "pytest")} external download={regressionExportFilename(regression.id, "pytest")} size="sm" icon={<FileCode2 />}>
                pytest
              </ButtonLink>
            </>
          ) : undefined
        }
      />
      <CardBody className="space-y-3">
        {!finished ? (
          <p className="text-sm text-muted">Available once the regression replay has an outcome.</p>
        ) : exp.isPending ? (
          <Loading label="regression export" rows={3} />
        ) : exp.isError ? (
          <ErrorState error={exp.error} title="Could not load the export" onRetry={() => void exp.refetch()} compact />
        ) : exp.data ? (
          <>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]">
              <dt className="text-muted">Test name</dt>
              <dd className="font-mono text-xs break-all">{exp.data.name}</dd>
              <dt className="text-muted">Asserts</dt>
              <dd>{exp.data.expectation}</dd>
              <dt className="text-muted">Rule</dt>
              <dd>
                <span className="font-mono text-xs text-muted">{exp.data.rule.id}</span> {exp.data.rule.statement}
              </dd>
              <dt className="text-muted">Initial state</dt>
              <dd>
                <Digest value={exp.data.initial_state_digest} label="initial state digest" />{" "}
                <span className="text-xs text-muted">({exp.data.initial_state.world_id}, synthetic)</span>
              </dd>
              <dt className="text-muted">Actions</dt>
              <dd className="tabular">{exp.data.actions.length}</dd>
              <dt className="text-muted">Last result</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <StatusBadge status={exp.data.last_result.outcome} domain="regression" size="sm" />
                <span className="font-mono text-xs text-muted">{exp.data.last_result.target}</span>
              </dd>
            </dl>
            {exp.data.last_result.outcome === "verified_violation" ? (
              <p className="text-sm font-medium text-bad">
                This test fails today against {exp.data.last_result.target}: the sequence still violates {exp.data.rule.id} there.
              </p>
            ) : exp.data.last_result.outcome !== "not_reproduced" ? (
              <p className="text-sm text-warn">
                The last replay had no clear verdict ({exp.data.last_result.outcome ?? "none"}), so the test&apos;s current status is unknown.
                {exp.data.last_result.outcome_reason ? ` ${exp.data.last_result.outcome_reason}` : null}
              </p>
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------- history
export interface RegressionListProps {
  query: { data?: Regression[]; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  selectedId: string | null;
  onSelect: (r: Regression) => void;
  /**
   * The challenge's own target: rows replayed against another adapter, or against the original
   * version itself, are marked as not being a repair.
   */
  original?: { adapter: string; version: string };
}

/** Every regression replay recorded for this challenge, newest first. */
export function RegressionList({ query, selectedId, onSelect, original }: RegressionListProps) {
  if (query.isPending) return <Loading label="previous regressions" rows={3} card />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} compact />;
  const regs = query.data ?? [];
  if (regs.length === 0) {
    return (
      <EmptyState
        compact
        title="No regression replays yet"
        description={
          SNAPSHOT_MODE
            ? "None had been recorded when this snapshot was taken."
            : "Start one above: the evaluator replays a verified sequence against the version you choose."
        }
      />
    );
  }
  return (
    <Table caption="Regression replays for this challenge, newest first">
      <THead>
        <tr>
          <TH>Regression</TH>
          <TH>Replayed against</TH>
          <TH>Outcome</TH>
          <TH>Source candidate</TH>
          <TH>Queued</TH>
          <TH>
            <span className="sr-only">Actions</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {regs.map((r) => {
          const selected = r.id === selectedId;
          const finished = !!r.outcome && !isRegressionActive(r.status);
          const relation = original ? replayRelation(r.target_key, original) : "repair";
          return (
            <TR key={r.id} className={cn(selected && "bg-raised/70")} aria-current={selected ? "true" : undefined}>
              <TD mono>
                {r.id}
                {selected ? (
                  <Badge tone="neutral" size="sm" className="ml-2">
                    shown above
                  </Badge>
                ) : null}
              </TD>
              <TD mono>
                {r.target_key}
                {original && relation === "other-family" ? (
                  <Badge
                    tone="warn"
                    size="sm"
                    className="ml-2 font-sans"
                    title={`Replayed against another agent (adapter ${adapterOfKey(r.target_key) ?? "?"}), not a version of ${original.adapter}: not a repair of this agent.`}
                  >
                    different agent family
                  </Badge>
                ) : original && relation === "same-version" ? (
                  <Badge
                    tone="neutral"
                    size="sm"
                    className="ml-2 font-sans"
                    title={`Replayed against ${original.adapter}@${original.version} again, the original version itself: a re-run of the unchanged agent, not a repair.`}
                  >
                    same version re-run, not a repair
                  </Badge>
                ) : null}
              </TD>
              <TD>
                <StatusBadge status={r.status} domain="regression" size="sm" />
              </TD>
              <TD mono className="text-muted">
                {r.source_candidate_id}
              </TD>
              <TD className="whitespace-nowrap text-xs text-muted">
                <TimeAgo ts={r.created_at} />
              </TD>
              <TD>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <Button size="sm" variant={selected ? "ghost" : "secondary"} icon={<GitCompareArrows />} onClick={() => onSelect(r)} disabled={selected}>
                    {selected ? "Comparing" : "Compare"}
                  </Button>
                  {finished ? (
                    <>
                      <ButtonLink
                        href={regressionExportUrl(r.id, "json")}
                        external
                        download={regressionExportFilename(r.id, "json")}
                        variant="ghost"
                        size="sm"
                        icon={<Download />}
                        aria-label={`Download regression ${r.id} as JSON`}
                      >
                        JSON
                      </ButtonLink>
                      <ButtonLink
                        href={regressionExportUrl(r.id, "pytest")}
                        external
                        download={regressionExportFilename(r.id, "pytest")}
                        variant="ghost"
                        size="sm"
                        icon={<Download />}
                        aria-label={`Download regression ${r.id} as a pytest file`}
                      >
                        pytest
                      </ButtonLink>
                    </>
                  ) : null}
                </div>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
