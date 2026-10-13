import { Download, FileSearch } from "lucide-react";
import type { ReactNode } from "react";
import { AgentClaims, Limitations } from "@/components/truth";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { ProvenanceBadge } from "@/components/ui/provenance-badge";
import { ErrorState, Loading } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { evidenceDownloadUrl, evidenceFilename, type EvidenceBundle, type SpecRule } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDuration, formatNumber, plural } from "@/lib/format";
import { statusMeta, type StatusDomain } from "@/lib/status";
import { agentClaims, distinctLedgerDigests, ledgerFacts, violatedCount } from "./ledger-facts";

export interface VersionColumnProps {
  /** Extra facts under the bundle facts (e.g. model proposals observed by the broker). */
  footer?: ReactNode;
  eyebrow: string;
  title: string;
  /** Outcome to show (evaluation outcome / regression status). */
  status: string | null | undefined;
  domain: StatusDomain;
  /** Evidence bundle query for this side. */
  bundle: { data?: EvidenceBundle; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown } | null;
  /** The claimed rule as written in the spec. */
  rule: SpecRule | null;
  currency: string;
  /** Link to a page that renders this evidence (evaluations only). */
  evidenceHref?: string | null;
  /** Shown instead of the body when there is nothing to compare yet. */
  placeholder?: ReactNode;
  className?: string;
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </div>
  );
}

/** One side of the before / after comparison, read entirely from its evidence bundle. */
export function VersionColumn({ eyebrow, title, status, domain, bundle, rule, currency, evidenceHref, placeholder, footer, className }: VersionColumnProps) {
  const tone = status ? statusMeta(status, domain).tone : "neutral";
  return (
    <Card as="article" tone={tone} className={cn("flex flex-col", className)} aria-label={`${eyebrow}: ${title}`}>
      <CardHeader eyebrow={eyebrow} title={title} actions={status ? <StatusBadge status={status} domain={domain} /> : undefined} />
      <CardBody className="flex-1 space-y-4">
        {placeholder ? (
          placeholder
        ) : !bundle ? (
          <p className="text-sm text-muted">No evidence bundle yet.</p>
        ) : bundle.isPending ? (
          <Loading label="evidence bundle" rows={6} />
        ) : bundle.isError || !bundle.data ? (
          <ErrorState error={bundle.error} title="Could not load the evidence bundle" onRetry={() => void bundle.refetch()} compact />
        ) : (
          <BundleFacts bundle={bundle.data} rule={rule} currency={currency} domain={domain} evidenceHref={evidenceHref} />
        )}
        {!placeholder && footer ? footer : null}
      </CardBody>
    </Card>
  );
}

function BundleFacts({
  bundle,
  rule,
  currency,
  domain,
  evidenceHref,
}: {
  bundle: EvidenceBundle;
  rule: SpecRule | null;
  currency: string;
  domain: StatusDomain;
  evidenceHref?: string | null;
}) {
  const replays = bundle.replays;
  const first = replays[0] ?? null;
  const ruleId = bundle.claimed_rule ?? rule?.id ?? "the claimed rule";
  const violated = violatedCount(bundle);
  const digests = distinctLedgerDigests(replays);
  const facts = first ? ledgerFacts(first.ledger, rule, currency) : [];
  const chainValid = replays.length > 0 && replays.every((r) => r.ledger_chain_valid);
  const toolCalls = replays.map((r) => r.stats.tool_calls).filter((n): n is number => typeof n === "number");
  const digest = bundle.evidence_digest ?? null;

  return (
    <>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-[minmax(7.5rem,auto)_1fr]">
        <Row label="Version">
          <span className="font-mono text-xs">
            {bundle.target.adapter}@{bundle.target.version}
          </span>
          <span className="mt-1 block">
            <ProvenanceBadge kind="target" value={bundle.target.label} size={bundle.target.label === "intentionally-vulnerable-fixture" ? "lg" : "md"} />
          </span>
        </Row>
        <Row label="Artifact">
          <Digest value={bundle.target.artifact_digest} label="target artifact digest" />
        </Row>
        <Row label="Outcome">
          <StatusBadge status={bundle.verdict.outcome} domain={domain} size="sm" />
          <span className="mt-1 block text-xs text-muted">{bundle.verdict.reason}</span>
        </Row>
        <Row label="Rule result">
          {replays.length === 0 ? (
            <span className="text-muted">no replays ran</span>
          ) : (
            <span className={cn("font-medium", violated > 0 ? "text-bad" : "text-ok")}>
              <span className="font-mono">{ruleId}</span>{" "}
              {violated > 0
                ? `violated in ${violated} of ${replays.length} ${plural(replays.length, "replay")}`
                : `held in all ${replays.length} ${plural(replays.length, "replay")}`}
            </span>
          )}
          {bundle.verdict.summary ? <span className="mt-1 block text-xs text-muted">Checker: {bundle.verdict.summary}</span> : null}
          {bundle.verdict.other_rules_violated.length ? (
            <span className="mt-1 block text-xs text-bad">Other rules violated: {bundle.verdict.other_rules_violated.join(", ")}</span>
          ) : null}
        </Row>
        {facts.map((f) => (
          <Row key={f.key} label={f.label}>
            <span className={cn("tabular", f.primary ? "font-semibold" : "text-fg")}>{f.value}</span>
          </Row>
        ))}
        <Row label={digests.length > 1 ? "Ledger digests" : "Ledger digest"}>
          {digests.length === 0 ? (
            <span className="text-muted">none</span>
          ) : (
            <span className="space-y-1">
              {digests.map((d) => (
                <span key={d} className="block">
                  <Digest value={d} label="ledger digest" />
                </span>
              ))}
              <span className="block text-xs text-muted">
                {digests.length === 1
                  ? `identical in all ${replays.length} ${plural(replays.length, "replay")}`
                  : `replays produced ${digests.length} different ledgers`}
                {chainValid ? "; hash chain valid (evaluator's check)" : "; hash chain NOT valid in every replay"}
              </span>
            </span>
          )}
        </Row>
        <Row label="Work per replay">
          <span className="tabular text-xs">
            {toolCalls.length ? `${toolCalls.map((n) => formatNumber(n)).join(" / ")} tool calls` : "tool calls not reported"}
            {first?.stats.duration_ms !== undefined ? `, ${replays.map((r) => formatDuration(r.stats.duration_ms ?? null)).join(" / ")}` : ""}
          </span>
        </Row>
        <Row label="Evidence">
          <Digest value={digest} label="evidence digest" href={evidenceHref ?? undefined} />
        </Row>
      </dl>
      {facts.length ? (
        <p className="text-xs text-subtle">
          Numbers above are computed on this page from replay {first?.index ?? 0}&apos;s ledger in the evidence bundle; the outcome
          is the evaluator&apos;s deterministic checker.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {evidenceHref ? (
          <ButtonLink href={evidenceHref} size="sm" icon={<FileSearch />}>
            Open evidence
          </ButtonLink>
        ) : null}
        {digest ? (
          <ButtonLink href={evidenceDownloadUrl(digest)} external download={evidenceFilename(digest)} size="sm" variant="ghost" icon={<Download />}>
            Download evidence JSON
          </ButtonLink>
        ) : null}
      </div>

      <AgentClaims claims={agentClaims(replays)} />

      {bundle.limitations.length ? (
        <details className="group rounded-md border border-line">
          <summary className="cursor-pointer rounded-md px-3 py-2 text-xs font-medium text-muted hover:bg-raised">
            Limitations stated in this evidence bundle ({bundle.limitations.length})
          </summary>
          <div className="px-3 pb-3">
            <Limitations items={bundle.limitations} title="Limitations" />
          </div>
        </details>
      ) : null}
    </>
  );
}
