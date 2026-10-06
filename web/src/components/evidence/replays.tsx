"use client";

import { Link2, Link2Off } from "lucide-react";
import { AgentClaims } from "@/components/truth";
import { Badge } from "@/components/ui/badge";
import { Digest } from "@/components/ui/digest";
import { KeyValueList } from "@/components/ui/stat";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import type { EvidenceBundle, EvidenceReplay, JsonObject, JsonValue } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatBytes, formatDuration, formatNumber } from "@/lib/format";
import { asNumber } from "@/lib/json";
import { Mono } from "@/components/ui/text-link";
import { Disclosure } from "@/components/ui/disclosure";
import { CompactJson, DataPairs } from "./values";
import { MatchMark } from "@/components/ui/match-mark";

/**
 * The claimed rule's state in one replay. "held" is only said when the replay ran to
 * completion; a replay that crashed, timed out or hit a runner failure tested nothing.
 */
export function replayRuleState(r: EvidenceReplay): "violated" | "held" | "not tested" {
  if (r.claimed_rule_violated) return "violated";
  return r.run_outcome === "completed" ? "held" : "not tested";
}

function RuleStateText({ r }: { r: EvidenceReplay }) {
  const state = replayRuleState(r);
  if (state === "violated") return <span className="text-xs font-semibold text-bad">violated</span>;
  if (state === "held") return <span className="text-xs font-semibold text-ok">held</span>;
  return <span className="text-xs font-semibold text-warn">not tested ({r.run_outcome})</span>;
}

function isolationOf(r: EvidenceReplay): { backend: string | null; peak: number | null; detail: JsonObject | null } {
  const iso = r.isolation;
  return {
    backend: iso && typeof iso.backend === "string" ? iso.backend : null,
    peak: iso ? asNumber(iso.peak_memory_bytes) : null,
    detail: iso,
  };
}

/** Summary table: one row per independent replay, and whether the ledgers are identical. */
export function ReplaysTable({ bundle }: { bundle: EvidenceBundle }) {
  const replays = bundle.replays;
  const reference = replays[0]?.ledger_digest ?? null;
  const deterministic = bundle.reproducibility.mode === "deterministic";
  const allIdentical = replays.length > 1 && replays.every((r) => r.ledger_digest !== null && r.ledger_digest === reference);
  return (
    <div className="space-y-3">
      <Table className="relative" caption="Independent replays of the candidate in fresh synthetic marketplaces">
        <THead>
          <tr>
            <TH className="text-right">Replay</TH>
            <TH>Run outcome</TH>
            <TH>Claimed rule</TH>
            <TH>Ledger digest</TH>
            <TH>Identical to replay {replays[0]?.index ?? 0}?</TH>
            <TH className="text-right">Tool calls</TH>
            <TH className="text-right">Duration</TH>
            <TH>Isolation</TH>
          </tr>
        </THead>
        <TBody>
          {replays.map((r, i) => {
            const iso = isolationOf(r);
            return (
              <TR key={r.index}>
                <TD mono numeric>
                  {r.index}
                </TD>
                <TD>
                  <span className="font-mono text-xs">{r.run_outcome}</span>
                  <span className="block text-xs text-muted">{r.run_reason}</span>
                </TD>
                <TD>
                  <RuleStateText r={r} />
                  {r.rules_violated.length > 0 ? (
                    <span className="block text-xs text-muted">violated: {r.rules_violated.join(", ")}</span>
                  ) : null}
                </TD>
                <TD>
                  <Digest value={r.ledger_digest} label={`ledger digest of replay ${r.index}`} head={6} tail={4} />
                </TD>
                <TD>
                  {i === 0 ? (
                    <span className="text-xs text-muted">reference</span>
                  ) : (
                    <MatchMark ok={r.ledger_digest && reference ? r.ledger_digest === reference : null} okText="identical" />
                  )}
                </TD>
                <TD numeric>{formatNumber(asNumber(r.stats.tool_calls))}</TD>
                <TD numeric>{formatDuration(asNumber(r.stats.duration_ms))}</TD>
                <TD>
                  <span className="font-mono text-xs">{iso.backend ?? "not reported"}</span>
                  {iso.peak !== null ? <span className="block text-xs text-muted">peak memory {formatBytes(iso.peak)}</span> : null}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      <p className="text-sm text-muted">
        {bundle.reproducibility.statement}{" "}
        {replays.length > 1 ? (
          allIdentical ? (
            <span className="font-medium text-ok">All {replays.length} replays produced the same ledger digest.</span>
          ) : deterministic ? (
            <span className="font-medium text-warn">Ledger digests differ between replays.</span>
          ) : (
            <span>Ledger digests differ, which a stochastic target allows.</span>
          )
        ) : null}
      </p>
    </div>
  );
}

/** Per-replay detail: ledger timeline with witness events, tool-call trace, agent claims. */
export function ReplayDetails({ bundle, currency = "SYN" }: { bundle: EvidenceBundle; currency?: string }) {
  const witness = bundle.verdict.witness_seqs ?? [];
  if (bundle.replays.length === 0) {
    return <p className="text-sm text-muted">No replay ran, so there is no ledger or trace.</p>;
  }
  return (
    <Tabs
      label="Replays"
      items={bundle.replays.map((r) => ({
        id: String(r.index),
        label: `Replay ${r.index}`,
        badge: replayRuleState(r),
        content: <ReplayDetail replay={r} witness={witness} currency={currency} />,
      }))}
    />
  );
}

function ReplayDetail({ replay, witness, currency }: { replay: EvidenceReplay; witness: number[]; currency: string }) {
  const witnessSet = new Set(witness);
  const iso = isolationOf(replay);
  const stats = replay.stats;
  return (
    <div className="space-y-5">
      <KeyValueList
        items={[
          { key: "outcome", label: "Run outcome", value: <span className="font-mono text-xs">{replay.run_outcome} - {replay.run_reason}</span> },
          {
            key: "chain",
            label: "Ledger hash chain",
            value: replay.ledger_chain_valid ? (
              <span className="inline-flex items-center gap-1 text-sm font-medium text-ok">
                <Link2 aria-hidden="true" className="size-4" /> Intact - each event commits to the previous one
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-sm font-medium text-bad">
                <Link2Off aria-hidden="true" className="size-4" /> Broken - the ledger does not verify
              </span>
            ),
          },
          { key: "ledger", label: "Ledger digest", value: <Digest value={replay.ledger_digest} label="ledger digest" /> },
          { key: "trace", label: "Trace digest", value: <Digest value={replay.trace_digest} label="trace digest" /> },
          {
            key: "stats",
            label: "Work",
            value: (
              <span className="tabular">
                {formatNumber(asNumber(stats.actions))} actions, {formatNumber(asNumber(stats.tool_calls))} tool calls,{" "}
                {formatNumber(asNumber(stats.model_calls))} model calls, {formatDuration(asNumber(stats.duration_ms))}
              </span>
            ),
          },
          {
            key: "iso",
            label: "Isolation",
            value: iso.detail ? <DataPairs data={iso.detail} /> : <span className="text-subtle">not reported</span>,
          },
        ]}
      />

      <div>
        <h3 className="mb-2 text-sm font-semibold text-fg">
          Ledger timeline <span className="font-normal text-muted">({replay.ledger.length} events, written by the evaluator-side market)</span>
        </h3>
        {witness.length > 0 ? (
          <p className="mb-2 flex items-center gap-2 text-xs text-muted">
            <span aria-hidden="true" className="inline-block size-3 rounded-sm border border-bad-line bg-bad-soft" />
            Rows marked &quot;witness&quot; are the events the checker cites for the violation (seq {witness.join(", ")}).
          </p>
        ) : null}
        {replay.ledger.length === 0 ? (
          <p className="text-sm text-muted">The ledger is empty.</p>
        ) : (
          <Table className="relative" caption={`Ledger of replay ${replay.index}`} dense>
            <THead>
              <tr>
                <TH className="text-right">Seq</TH>
                <TH>Event</TH>
                <TH>Data</TH>
                <TH>Hash</TH>
              </tr>
            </THead>
            <TBody>
              {replay.ledger.map((e) => {
                const isWitness = witnessSet.has(e.seq);
                return (
                  <TR key={e.seq} highlighted={isWitness}>
                    <TD mono numeric className={cn(isWitness && "font-semibold text-bad")}>
                      {e.seq}
                    </TD>
                    <TD>
                      <span className="whitespace-nowrap font-mono text-xs">{e.type}</span>
                      {isWitness ? (
                        <Badge tone="bad" size="sm" className="ml-2">
                          witness
                        </Badge>
                      ) : null}
                    </TD>
                    <TD className="min-w-[16rem]">
                      <DataPairs data={e.data} currency={currency} />
                    </TD>
                    <TD>
                      <Digest value={e.hash} label={`hash of ledger event ${e.seq}`} head={6} tail={4} />
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </div>

      <Disclosure
        summary={
          <span className="font-semibold">
            Tool-call trace <span className="font-normal text-muted">({replay.trace.length} entr{replay.trace.length === 1 ? "y" : "ies"})</span>
          </span>
        }
      >
          {replay.trace.length === 0 ? (
            <p className="text-sm text-muted">No tool calls were recorded.</p>
          ) : (
            <Table className="relative" caption={`Tool calls of replay ${replay.index}`} dense>
              <THead>
                <tr>
                  <TH className="text-right">#</TH>
                  <TH className="text-right">Step</TH>
                  <TH>Tool</TH>
                  <TH>Arguments</TH>
                  <TH>Response</TH>
                </tr>
              </THead>
              <TBody>
                {replay.trace.map((t, i) => {
                  // Entries are usually tool calls; a live-model target can also log refused
                  // model calls ({ model_call, refused, refusal_kind }). Show those as they are.
                  const raw = t as unknown as Record<string, JsonValue>;
                  const step = typeof raw.action_index === "number" ? raw.action_index + 1 : "-";
                  if (typeof raw.tool !== "string") {
                    const rest = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "n" && k !== "action_index"));
                    return (
                      <TR key={`${String(raw.n)}-${i}`}>
                        <TD mono numeric>
                          {String(raw.n ?? i)}
                        </TD>
                        <TD mono numeric>
                          {step}
                        </TD>
                        <TD>
                          <span className="text-xs font-semibold text-warn">
                            {typeof raw.refused === "string" ? `refused${typeof raw.refusal_kind === "string" ? ` (${raw.refusal_kind})` : ""}` : "other entry"}
                          </span>
                        </TD>
                        <TD colSpan={2}>
                          <DataPairs data={rest} />
                        </TD>
                      </TR>
                    );
                  }
                  const resp = raw.response;
                  const respObj = resp !== null && typeof resp === "object" && !Array.isArray(resp) ? resp : null;
                  const ok = respObj ? respObj.ok : undefined;
                  const body = ok === true ? respObj?.value : ok === false ? respObj?.error : resp;
                  const args = raw.args !== null && typeof raw.args === "object" && !Array.isArray(raw.args) ? raw.args : null;
                  return (
                    <TR key={`${String(raw.n)}-${i}`}>
                      <TD mono numeric>
                        {String(raw.n ?? i)}
                      </TD>
                      <TD mono numeric>
                        {step}
                      </TD>
                      <TD mono>{raw.tool}</TD>
                      <TD className="min-w-[10rem]">
                        <DataPairs data={args} currency={currency} />
                      </TD>
                      <TD className="min-w-[14rem]">
                        {ok === true ? (
                          <span className="mr-1.5 text-xs font-semibold text-muted">ok</span>
                        ) : ok === false ? (
                          <span className="mr-1.5 text-xs font-semibold text-warn">error</span>
                        ) : null}
                        {body === undefined ? <span className="text-xs text-subtle">no response recorded</span> : <CompactJson value={body} />}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
          <p className="mt-2 text-xs text-muted">
            &quot;Step&quot; is the 1-based action of the counterexample the agent was handling. The trace is what the agent asked
            the market; the ledger above is what the market recorded.
          </p>
      </Disclosure>

      {replay.agent_claims_unverified.length > 0 ? (
        <AgentClaims claims={replay.agent_claims_unverified} />
      ) : (
        <p className="text-xs text-muted">The agent made no claims of its own in this replay.</p>
      )}

      {replay.rules_violated.length > 0 ? (
        <p className="text-sm text-muted">
          Rules the checker found violated in this replay:{" "}
          {replay.rules_violated.map((r) => (
            <Mono key={r} className="mr-1">
              {r}
            </Mono>
          ))}
        </p>
      ) : null}
    </div>
  );
}
