"use client";

import { FlaskConical } from "lucide-react";
import { TrustStatement } from "@/components/truth";
import { Address } from "@/components/ui/address";
import { Badge } from "@/components/ui/badge";
import { Callout, Card, CardBody, CardHeader } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { JsonView } from "@/components/ui/json-view";
import { ProvenanceBadge } from "@/components/ui/provenance-badge";
import { Section } from "@/components/ui/section";
import { KeyValueList } from "@/components/ui/stat";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { DateTime } from "@/components/ui/time";
import type { AppConfig, ChallengeView, ComponentInfo, RuleTemplate } from "@/lib/api";
import { formatWei, txNetworkPhrase } from "@/lib/chain";
import { formatDuration, formatNumber, sameHex } from "@/lib/format";
import { DataPairs } from "@/components/evidence/values";
import { MatchMark } from "@/components/ui/match-mark";
import { Mono, MonoList } from "@/components/ui/text-link";
import { Disclosure } from "@/components/ui/disclosure";

function ComponentValue({ c, label }: { c: ComponentInfo; label: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs">
        {c.name}@{c.version}
      </span>
      <Digest value={c.digest} label={`${label} digest`} />
    </span>
  );
}

export interface PromiseTabProps {
  view: ChallengeView;
  config: AppConfig | null;
  templates: RuleTemplate[] | undefined;
}

/** "What was promised": rules, the target, the synthetic world, scope, limits, evaluator, reward, full spec. */
export function PromiseTab({ view, config, templates }: PromiseTabProps) {
  const spec = view.spec;
  const target = view.target_info;
  const eligible = new Set(spec.reward.eligible_rules);
  const offchain = view.status === "offchain" || view.network === "offchain";
  const requiredIso = spec.environment.isolation;
  const isoStatus = config?.isolation?.[requiredIso] ?? null;

  return (
    <div className="space-y-8">
      <Section
        title="The promise: rules"
        description="Each rule is an explicit template with parameters. The deterministic checker decides them from the evaluator's ledger only; nothing the agent says counts."
      >
        <ol className="space-y-3">
          {spec.rules.map((r) => {
            const t = templates?.find((x) => x.id === r.template);
            return (
              <Card as="li" key={r.id} padded className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="flex min-w-0 flex-1 items-baseline gap-2 text-sm font-medium text-fg sm:text-base">
                    <Mono>{r.id}</Mono>
                    <span className="min-w-0">{r.statement}</span>
                  </p>
                  {offchain ? null : eligible.has(r.id) ? (
                    <Badge tone="neutral" size="sm">
                      Reward-eligible
                    </Badge>
                  ) : (
                    <Badge tone="neutral" size="sm">
                      Not reward-eligible
                    </Badge>
                  )}
                </div>
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[9rem_1fr]">
                  <dt className="text-muted">Template</dt>
                  <dd className="min-w-0">
                    <span className="font-mono text-xs">
                      {r.template} v{r.template_version}
                    </span>
                    {t ? <span className="text-muted"> - {t.title}</span> : null}
                  </dd>
                  <dt className="text-muted">Parameters</dt>
                  <dd className="min-w-0">
                    {Object.keys(r.params).length ? <DataPairs data={r.params} currency={spec.initial_state.currency} /> : <span className="text-muted">none</span>}
                  </dd>
                  {t ? (
                    <>
                      <dt className="text-muted">Checker reads</dt>
                      <dd className="min-w-0 text-fg/90">{t.evidence}</dd>
                    </>
                  ) : null}
                </dl>
              </Card>
            );
          })}
        </ol>
      </Section>

      <Section title="Target under test" description="Exactly one agent version, pinned by its artifact digest.">
        <Card>
          <CardHeader
            title={target?.title ?? `${spec.target.adapter}@${spec.target.version}`}
            level={3}
            actions={<ProvenanceBadge kind="target" value={spec.target.label} requiresModel={target?.requires_model} size="md" />}
          />
          <CardBody className="space-y-4">
            {target?.description ? <p className="text-sm text-fg">{target.description}</p> : null}
            <KeyValueList
              items={[
                { key: "key", label: "Adapter @ version", value: <span className="font-mono text-xs">{spec.target.adapter}@{spec.target.version}</span> },
                { key: "digest", label: "Artifact digest", value: <Digest value={spec.target.artifact_digest} label="target artifact digest" /> },
                { key: "det", label: "Determinism", value: spec.target.determinism },
                ...(target
                  ? [
                      { key: "module", label: "Module", value: <span className="font-mono text-xs">{target.module_file}</span> },
                      { key: "prov", label: "Provenance", value: target.provenance },
                      { key: "fp", label: "Written by", value: target.first_party ? "the CounterProof team (first party)" : "a third party" },
                      { key: "model", label: "Needs a live model", value: target.requires_model ? "yes" : "no" },
                    ]
                  : []),
                ...(Object.keys(spec.target.config).length
                  ? [{ key: "cfg", label: "Target config", value: <DataPairs data={spec.target.config} /> }]
                  : []),
              ]}
            />
            {!target ? (
              <Callout tone="warn" title="Target not in this backend's catalogue">
                The spec names a target this backend does not list, so its description and planted defects are unavailable.
              </Callout>
            ) : null}
            {spec.target.label === "intentionally-vulnerable-fixture" ? (
              <Callout tone="warn" icon={<FlaskConical />} title="Planted defects (known before any testing)">
                {target && target.planted_defects.length > 0 ? (
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {target.planted_defects.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                ) : (
                  <p>The catalogue lists no planted defects for this fixture.</p>
                )}
                <p className="mt-2 text-xs">Findings against this target demonstrate the pipeline; they are not independent discoveries.</p>
              </Callout>
            ) : null}
          </CardBody>
        </Card>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Synthetic world" level={3} description={spec.initial_state.note}>
          <Card padded className="space-y-4">
            <KeyValueList
              items={[
                { key: "world", label: "World", value: <span className="font-mono text-xs">{spec.initial_state.world_id}</span> },
                { key: "digest", label: "Initial state", value: <Digest value={spec.initial_state_digest} label="initial state digest" /> },
                {
                  key: "mandate",
                  label: "Mandate",
                  value: (
                    <span>
                      budget {formatNumber(spec.initial_state.mandate.budget)} {spec.initial_state.currency}, status{" "}
                      {spec.initial_state.mandate.status}
                    </span>
                  ),
                },
                { key: "allowed", label: "Approved merchants", value: <MonoList label="Approved merchants" items={spec.initial_state.mandate.allowed_merchants} /> },
                {
                  key: "wallet",
                  label: "Wallet",
                  value: `${formatNumber(spec.initial_state.wallet.balance)} ${spec.initial_state.currency} (synthetic)`,
                },
                { key: "market", label: "Market", value: <ComponentValue c={spec.environment.market} label="market" /> },
                { key: "runner", label: "Runner", value: <ComponentValue c={spec.environment.runner} label="runner" /> },
                {
                  key: "iso",
                  label: "Isolation required",
                  value: (
                    <span className="flex flex-col gap-0.5">
                      <span className="font-mono text-xs">{requiredIso}</span>
                      {isoStatus ? (
                        <span className={isoStatus.available ? "text-xs text-muted" : "text-xs text-warn"}>
                          {isoStatus.available ? "available on this backend" : "unavailable on this backend"}: {isoStatus.detail}
                        </span>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
            <Disclosure
              summary={`Merchants and products (${spec.initial_state.merchants.length} merchants, ${spec.initial_state.products.length} products)`}
              bodyClassName="space-y-3"
            >
                <ul className="space-y-0.5 text-sm">
                  {spec.initial_state.merchants.map((m) => (
                    <li key={m.id}>
                      <span className="font-mono text-xs">{m.id}</span> {m.name}
                      {spec.initial_state.mandate.allowed_merchants.includes(m.id) ? null : (
                        <span className="text-xs text-warn"> - not approved by the mandate</span>
                      )}
                    </li>
                  ))}
                </ul>
                <Table className="relative" caption="Products in the synthetic catalogue" dense>
                  <THead>
                    <tr>
                      <TH>SKU</TH>
                      <TH>Name</TH>
                      <TH>Merchant</TH>
                      <TH className="text-right">Price</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {spec.initial_state.products.map((p) => (
                      <TR key={p.sku}>
                        <TD mono>{p.sku}</TD>
                        <TD>{p.name}</TD>
                        <TD mono>{p.merchant}</TD>
                        <TD numeric>
                          {formatNumber(p.price)} {spec.initial_state.currency}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
            </Disclosure>
          </Card>
        </Section>

        <Section title="Scope" level={3} description={spec.scope.notes}>
          <Card padded>
            <KeyValueList
              items={[
                { key: "actions", label: "Allowed actions", value: <MonoList label="Allowed actions" items={spec.scope.allowed_actions} /> },
                { key: "skus", label: "Merchant text allowed on", value: <MonoList label="Merchant text allowed on" items={spec.scope.content_skus} /> },
                { key: "max", label: "Max actions", value: <span className="tabular">{formatNumber(spec.scope.max_actions)} per counterexample</span> },
                { key: "chars", label: "Max merchant text", value: <span className="tabular">{formatNumber(spec.scope.max_content_chars)} characters</span> },
              ]}
            />
          </Card>
        </Section>

        <Section title="Limits per replay" level={3} description="Enforced by the runner on every replay; exceeding one is a timeout or crash, never a violation.">
          <Card padded>
            <KeyValueList
              items={[
                { key: "tpe", label: "Tool calls per event", value: formatNumber(spec.limits.max_tool_calls_per_event) },
                { key: "tt", label: "Tool calls in total", value: formatNumber(spec.limits.max_tool_calls_total) },
                { key: "mc", label: "Model calls", value: formatNumber(spec.limits.max_model_calls) },
                { key: "mt", label: "Model tokens", value: formatNumber(spec.limits.max_model_tokens) },
                { key: "et", label: "Event timeout", value: formatDuration(spec.limits.event_timeout_ms) },
                { key: "to", label: "Total timeout", value: formatDuration(spec.limits.total_timeout_ms) },
                { key: "mem", label: "Memory", value: `${formatNumber(spec.limits.memory_mb)} MB` },
                { key: "cpu", label: "CPU", value: `${formatNumber(spec.limits.cpu_seconds)} s` },
              ]}
            />
          </Card>
        </Section>

        <Section title="Reproducibility" level={3} description="What a verdict requires before it counts.">
          <Card padded className="space-y-2">
            <p className="text-sm text-fg">{spec.reproducibility.statement}</p>
            <KeyValueList
              items={[
                { key: "mode", label: "Mode", value: spec.reproducibility.mode },
                { key: "replays", label: "Independent replays", value: formatNumber(spec.reproducibility.replays) },
                { key: "req", label: "Violations required", value: formatNumber(spec.reproducibility.required_violations) },
              ]}
            />
          </Card>
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Who checks: the evaluator" level={3}>
          <Card padded className="space-y-3">
            <KeyValueList
              items={[
                { key: "name", label: "Name", value: spec.evaluator.name || <span className="text-muted">not named</span> },
                {
                  key: "addr",
                  label: "Address",
                  value: (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <Address value={spec.evaluator.address} label="evaluator address" />
                      {config?.evaluator_address ? (
                        <MatchMark
                          ok={sameHex(config.evaluator_address, spec.evaluator.address)}
                          okText="this backend's configured evaluator"
                          badText="not this backend's configured evaluator"
                        />
                      ) : null}
                    </span>
                  ),
                },
                {
                  key: "trust",
                  label: "Trust model",
                  value: (
                    <span>
                      <span className="font-mono text-xs">{spec.evaluator_trust}</span>
                      <span className="text-muted"> - a declared trusted party, not a proof system</span>
                    </span>
                  ),
                },
                { key: "checker", label: "Checker", value: <ComponentValue c={spec.checker} label="checker" /> },
              ]}
            />
            <TrustStatement kind="attestation" />
            <TrustStatement kind="llm" />
          </Card>
        </Section>

        <Section title="Reward and settlement" level={3}>
          <Card padded className="space-y-3">
            <KeyValueList
              items={[
                {
                  key: "amount",
                  label: "Reward",
                  value: offchain ? spec.reward.currency : formatWei(spec.reward.amount_wei, view.network),
                },
                { key: "outcomes", label: "Eligible outcomes", value: <MonoList label="Eligible outcomes" items={spec.reward.eligible_outcomes} /> },
                { key: "rules", label: "Eligible rules", value: <MonoList label="Eligible rules" items={spec.reward.eligible_rules} /> },
                { key: "policy", label: "Policy", value: <span className="font-mono text-xs">{spec.reward.policy}</span> },
                { key: "max", label: "Max rewards", value: formatNumber(spec.reward.max_rewards) },
                { key: "sub", label: "Submissions close", value: <DateTime ts={spec.deadlines.submission_deadline} /> },
                { key: "set", label: "Settlement deadline", value: <DateTime ts={spec.deadlines.settlement_deadline} /> },
                {
                  key: "chain",
                  label: "Settles on",
                  value: spec.settlement ? (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {txNetworkPhrase(spec.settlement.chain_id)}
                      <Address value={spec.settlement.contract} label="settlement contract" />
                    </span>
                  ) : (
                    <span className="text-muted">nowhere - off-chain, evidence only</span>
                  ),
                },
                { key: "rev", label: "Revision", value: spec.supersedes ? <>{spec.revision} (supersedes <Digest value={spec.supersedes} label="superseded spec digest" />)</> : String(spec.revision) },
              ]}
            />
            {offchain ? null : (
              <p className="text-xs text-muted">The payout always goes to the recipient a challenger binds when committing a submission.</p>
            )}
          </Card>
        </Section>
      </div>

      <Section
        title="Full specification"
        description={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            Content-addressed: the digest <Digest value={view.spec_digest} label="spec digest" /> is the hash of this canonical document. {spec.format}
          </span>
        }
      >
        <JsonView value={spec} label="Challenge specification" collapsedDepth={1} maxHeight="36rem" />
      </Section>
    </div>
  );
}

