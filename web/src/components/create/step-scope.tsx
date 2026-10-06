"use client";

import { Lock, ShieldAlert, TriangleAlert } from "lucide-react";
import { Address, Badge, Callout, Checkbox, Digest, ErrorState, JsonView, KeyValueList, Loading } from "@/components/ui";
import { LLM_NEVER_DECIDES } from "@/components/truth";
import type { AppConfig, ChallengeSpec } from "@/lib/api";
import { ATTESTATION_MEANING } from "@/lib/chain";
import { formatDuration, formatNumber, formatSyn } from "@/lib/format";
import { MonoList } from "@/components/ui/text-link";
import { Block, UpdatingNote } from "./bits";

export interface StepScopeProps {
  spec: ChallengeSpec | undefined;
  fresh: boolean;
  error: unknown;
  config: AppConfig | undefined;
  approved: boolean;
  onApprove: (approved: boolean) => void;
}

/** Step 3: the fixed terms (scope, world, limits, isolation, reproducibility, evaluator), read-only. */
export function StepScope({ spec, fresh, error, config, approved, onApprove }: StepScopeProps) {
  if (error && !spec) return <ErrorState error={error} title="The backend could not build the spec preview" />;
  if (!spec) return <Loading label="spec preview" rows={6} card />;

  const products = new Map(spec.initial_state.products.map((p) => [p.sku, p]));
  const mandate = new Set(spec.initial_state.mandate.allowed_merchants);
  const isolationKey = spec.environment.isolation;
  const isolation = config?.isolation?.[isolationKey];
  const container = config?.isolation?.container;
  const signerAddr = config?.signer.address?.toLowerCase() ?? null;
  const evaluatorAddr = spec.evaluator.address.toLowerCase();
  const signerMismatch = !!signerAddr && signerAddr !== evaluatorAddr;
  const limits = spec.limits;

  return (
    <div className="space-y-4">
      <Callout tone="neutral" icon={<Lock />} title="Approved exactly as shown">
        These terms are filled from versioned platform defaults for the chosen target, written into the spec before it is
        hashed, and covered by its digest. They cannot be edited here. Every value below is read from the backend&apos;s
        preview of your spec.
      </Callout>
      {error ? <ErrorState compact error={error} title="The latest preview failed; showing the previous one" /> : null}
      <UpdatingNote show={!fresh && !error} />

      <Block title="What challengers may do" description={spec.scope.notes}>
        <KeyValueList
          items={[
            { key: "actions", label: "Allowed actions", value: <MonoList label="Allowed actions" items={spec.scope.allowed_actions} /> },
            {
              key: "skus",
              label: "Products whose merchant content they may write",
              value: (
                <MonoList
                  label="Content SKUs"
                  items={spec.scope.content_skus.map((sku) => {
                    const p = products.get(sku);
                    return p ? `${sku} (${p.name}, ${p.merchant})` : sku;
                  })}
                />
              ),
            },
            { key: "max", label: "Actions per sequence", value: <span className="tabular">at most {formatNumber(spec.scope.max_actions)}</span> },
            {
              key: "chars",
              label: "Merchant content length",
              value: <span className="tabular">at most {formatNumber(spec.scope.max_content_chars)} characters</span>,
            },
          ]}
        />
      </Block>

      <Block title="Synthetic world" description={spec.initial_state.note}>
        <KeyValueList
          items={[
            { key: "world", label: "World", value: <span className="font-mono text-xs">{spec.initial_state.world_id}</span> },
            {
              key: "merchants",
              label: "Merchants",
              value: (
                <ul className="space-y-0.5">
                  {spec.initial_state.merchants.map((m) => (
                    <li key={m.id}>
                      <span className="font-mono text-xs text-muted">{m.id}</span> {m.name}
                      {mandate.has(m.id) ? null : <span className="text-warn"> - not approved in the mandate</span>}
                    </li>
                  ))}
                </ul>
              ),
            },
            {
              key: "mandate",
              label: "Principal's mandate",
              value: (
                <span>
                  budget {formatSyn(spec.initial_state.mandate.budget, spec.initial_state.currency)}, merchants{" "}
                  <span className="font-mono text-xs">{spec.initial_state.mandate.allowed_merchants.join(", ")}</span>, status{" "}
                  {spec.initial_state.mandate.status}
                </span>
              ),
            },
            {
              key: "wallet",
              label: "Synthetic wallet",
              value: formatSyn(spec.initial_state.wallet.balance, spec.initial_state.currency),
            },
            {
              key: "products",
              label: "Catalogue",
              value: <span className="tabular">{formatNumber(spec.initial_state.products.length)} products</span>,
            },
            { key: "digest", label: "Initial state digest", value: <Digest value={spec.initial_state_digest} label="initial state digest" /> },
          ]}
        />
      </Block>

      <div className="grid gap-4 xl:grid-cols-2">
        <Block title="Limits per replay">
          <KeyValueList
            items={[
              { key: "tce", label: "Tool calls per event", value: <span className="tabular">{formatNumber(limits.max_tool_calls_per_event)}</span> },
              { key: "tct", label: "Tool calls in total", value: <span className="tabular">{formatNumber(limits.max_tool_calls_total)}</span> },
              { key: "mc", label: "Model calls", value: <span className="tabular">{formatNumber(limits.max_model_calls)}</span> },
              { key: "mt", label: "Model tokens", value: <span className="tabular">{formatNumber(limits.max_model_tokens)}</span> },
              { key: "et", label: "Event timeout", value: formatDuration(limits.event_timeout_ms) },
              { key: "tt", label: "Total timeout", value: formatDuration(limits.total_timeout_ms) },
              { key: "mem", label: "Memory", value: <span className="tabular">{formatNumber(limits.memory_mb)} MB</span> },
              { key: "cpu", label: "CPU time", value: <span className="tabular">{formatNumber(limits.cpu_seconds)} s</span> },
            ]}
          />
        </Block>

        <Block title="Isolation and reproducibility">
          <KeyValueList
            items={[
              {
                key: "iso",
                label: "Isolation",
                value: (
                  <span>
                    <span className="font-mono text-xs">{isolationKey}</span>
                    {isolation ? (
                      <>
                        {" "}
                        <Badge tone={isolation.available ? "ok" : "warn"} size="sm">
                          {isolation.available ? "available now" : "not available now"}
                        </Badge>
                        <span className="mt-0.5 block text-xs text-muted">{isolation.detail}</span>
                      </>
                    ) : null}
                  </span>
                ),
              },
              ...(container && isolationKey !== "container"
                ? [
                    {
                      key: "container",
                      label: "Container isolation",
                      value: (
                        <span className="text-xs text-muted">
                          {container.available ? "available" : "not available"}: {container.detail}
                        </span>
                      ),
                    },
                  ]
                : []),
              {
                key: "mode",
                label: "Mode",
                value: (
                  <Badge tone={spec.reproducibility.mode === "stochastic" ? "warn" : "neutral"} size="sm">
                    {spec.reproducibility.mode}
                  </Badge>
                ),
              },
              {
                key: "replays",
                label: "Evaluator replays",
                value: (
                  <span className="tabular">
                    {spec.reproducibility.required_violations} of {spec.reproducibility.replays} fresh replays must violate the rule
                  </span>
                ),
              },
              { key: "statement", label: "Reproducibility", value: spec.reproducibility.statement },
            ]}
          />
        </Block>
      </div>

      <Block title="Pinned code" description="The replay uses exactly these versions; a change to any of them changes the digest.">
        <KeyValueList
          items={[
            {
              key: "target",
              label: "Target",
              value: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">
                    {spec.target.adapter}@{spec.target.version}
                  </span>
                  <Digest value={spec.target.artifact_digest} label="target artifact digest" />
                </span>
              ),
            },
            ...(["market", "runner"] as const).map((k) => ({
              key: k,
              label: k === "market" ? "Synthetic market" : "Runner",
              value: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">
                    {spec.environment[k].name}@{spec.environment[k].version}
                  </span>
                  <Digest value={spec.environment[k].digest} label={`${k} digest`} />
                </span>
              ),
            })),
            {
              key: "checker",
              label: "Deterministic checker",
              value: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">
                    {spec.checker.name}@{spec.checker.version}
                  </span>
                  <Digest value={spec.checker.digest} label="checker digest" />
                </span>
              ),
            },
          ]}
        />
        {Object.keys(spec.target.config).length > 0 ? (
          <JsonView value={spec.target.config} label="Target configuration (live model settings)" collapsedDepth={2} maxHeight="12rem" />
        ) : null}
      </Block>

      <Block title="Evaluator and trust model">
        <KeyValueList
          items={[
            {
              key: "addr",
              label: "Evaluator",
              value: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Address value={spec.evaluator.address} label="evaluator address" full />
                  <span className="text-muted">{spec.evaluator.name}</span>
                </span>
              ),
            },
            {
              key: "trust",
              label: "Trust",
              value: (
                <span>
                  <Badge tone="neutral" size="sm">
                    {spec.evaluator_trust}
                  </Badge>{" "}
                  a declared trusted party, named in the spec (and in createChallenge when funded on chain)
                </span>
              ),
            },
            {
              key: "signer",
              label: "Signing service",
              value: config ? (
                config.signer.reachable ? (
                  <span>
                    reachable{config.signer.address ? <> as <Address value={config.signer.address} label="signer address" /></> : null}
                  </span>
                ) : (
                  <span className="text-warn">not reachable right now</span>
                )
              ) : (
                <span className="text-subtle">unknown</span>
              ),
            },
          ]}
        />
        {signerMismatch ? (
          <Callout tone="warn" icon={<TriangleAlert />} title="Signer and evaluator differ">
            The signing service reports {config?.signer.address}, but the spec names {spec.evaluator.address}. Attestations
            from that signer would not settle (the contract checks the evaluator&apos;s signature).
          </Callout>
        ) : null}
        <Callout tone="neutral" icon={<ShieldAlert />}>
          <p>{ATTESTATION_MEANING}</p>
          <p className="mt-1">{LLM_NEVER_DECIDES}</p>
        </Callout>
      </Block>

      <div className="rounded-lg border border-line bg-surface px-4 py-3 sm:px-5">
        <Checkbox
          checked={approved}
          onChange={(e) => onApprove(e.target.checked)}
          label="I approve the scope, limits, isolation, reproducibility rule and evaluator exactly as shown"
          description="Changing the target clears this approval, because these terms depend on it."
        />
      </div>
    </div>
  );
}
