"use client";

import { Bot, Play } from "lucide-react";
import { useId, useState } from "react";
import { TrustStatement } from "@/components/truth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { NumberField, Select } from "@/components/ui/form";
import { ErrorState } from "@/components/ui/states";
import { sessionLimits, type AppConfig, type RoleLimits, type SpecRule, type Strategy } from "@/lib/api";
import { useSession, useStartRun } from "@/lib/queries";
import { DataPairs } from "@/components/evidence/values";
import { Mono } from "@/components/ui/text-link";
import { SNAPSHOT_MODE } from "@/lib/snapshot";

/**
 * Budget the form starts with. These mirror the defaults the backend applies when no
 * budget is sent (limits.clamp_budget), lowered to the server's caps for this session; the
 * server clamps whatever is sent to those caps and the run shows its effective budget.
 */
export function initialBudget(modelDriven: boolean, caps?: RoleLimits | null) {
  const d = modelDriven ? { max_sequences: 12, max_wall_seconds: 900 } : { max_sequences: 120, max_wall_seconds: 90 };
  return caps
    ? { max_sequences: Math.min(d.max_sequences, caps.max_sequences), max_wall_seconds: Math.min(d.max_wall_seconds, caps.max_wall_seconds) }
    : d;
}

export interface StrategyCardProps {
  strategy: Strategy;
  challengeId: number;
  rules: SpecRule[];
  config: AppConfig | null;
  /** True when the target itself is driven by a live model (bigger time budget). */
  targetRequiresModel: boolean;
  /** Why runs cannot start right now (status, deadline, isolation), or null. */
  blockedReason: string | null;
}

/** One search strategy: what it tries, which of this challenge's rules it aims at, budget, Run. */
export function StrategyCard({ strategy, challengeId, rules, config, targetRequiresModel, blockedReason }: StrategyCardProps) {
  const isModel = strategy.mode === "model-assisted";
  const start = useStartRun(challengeId);
  const session = useSession();
  const caps = sessionLimits(session.data);
  const init = initialBudget(isModel || targetRequiresModel, caps);
  // undefined = not edited yet: follow the defaults and the caps once the session loads.
  const [seqInput, setMaxSeq] = useState<number | null | undefined>(undefined);
  const [wallInput, setMaxWall] = useState<number | null | undefined>(undefined);
  const maxSeq = seqInput === undefined ? init.max_sequences : seqInput;
  const maxWall = wallInput === undefined ? init.max_wall_seconds : wallInput;
  const providers = config?.providers ?? [];
  const configured = providers.filter((p) => p.configured);
  // The user's explicit choice; until they pick one, follow the backend's live-model provider
  // (or the first configured one). Derived each render so a late-loading config still applies.
  const [chosenProvider, setProvider] = useState<string>("");
  const defaultProvider =
    config?.live_model.provider && providers.some((p) => p.provider === config.live_model.provider)
      ? config.live_model.provider
      : (configured[0]?.provider ?? providers[0]?.provider ?? "");
  const provider = chosenProvider || defaultProvider;
  const baseId = useId();
  const selected = providers.find((p) => p.provider === provider) ?? null;
  const model = config?.live_model.model ?? selected?.default_model ?? null;

  const covered = rules.filter((r) => strategy.targets_rules.includes(r.template));
  const budgetMissing = maxSeq === null || maxWall === null;
  const providerMissing = isModel && (!selected || !selected.configured);
  const disabled = !!blockedReason || budgetMissing || providerMissing;

  const run = () => {
    if (maxSeq === null || maxWall === null) return;
    start.mutate({
      strategy: strategy.id,
      mode: strategy.mode,
      budget: { max_sequences: maxSeq, max_wall_seconds: maxWall },
      ...(isModel && provider ? { params: { provider } } : {}),
    });
  };

  return (
    <Card as="li" className="flex flex-col">
      <CardHeader
        title={strategy.title}
        level={3}
        eyebrow={<span className="font-mono normal-case tracking-normal">{strategy.id}</span>}
        actions={
          <Badge tone="neutral" size="sm" icon={isModel ? <Bot /> : undefined}>
            {isModel ? "Model-assisted" : "Deterministic"}
          </Badge>
        }
      />
      <CardBody className="flex-1 space-y-3">
        <p className="text-sm text-fg">{strategy.description}</p>
        <div className="text-sm">
          <p className="text-muted">Aims at rules of this challenge</p>
          <p className="mt-1">
            {strategy.targets_rules.length === 0 ? (
              <span className="text-muted">Any rule - the model proposes sequences against the whole spec.</span>
            ) : covered.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {covered.map((r) => (
                  <Mono key={r.id}>
                    {r.id} {r.template}
                  </Mono>
                ))}
              </span>
            ) : (
              <span className="text-muted">None of its templates ({strategy.targets_rules.join(", ")}) appear in this spec.</span>
            )}
          </p>
        </div>
        {Object.keys(strategy.defaults).length > 0 ? (
          <div className="text-sm">
            <p className="text-muted">Default parameters</p>
            <DataPairs data={strategy.defaults} className="mt-1" />
          </div>
        ) : null}

        {isModel && SNAPSHOT_MODE ? (
          <TrustStatement kind="llm" />
        ) : isModel ? (
          <div className="space-y-2 rounded-md border border-line bg-inset p-3">
            {providers.length === 0 ? (
              <p className="text-sm text-warn">The backend reports no model providers.</p>
            ) : (
              <Select
                label="Provider"
                id={`${baseId}-provider`}
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                options={providers.map((p) => ({
                  value: p.provider,
                  label: `${p.provider} - ${p.configured ? "key configured" : `no key (${p.key_env})`}`,
                }))}
                hint={
                  selected
                    ? selected.configured
                      ? `Model: ${model ?? "provider default"}. Key from ${selected.key_env} on the backend.` +
                        (caps?.model ? ` Judge sessions always use ${caps.model}.` : "")
                      : `Set ${selected.key_env} on the backend to use ${selected.provider}.`
                    : undefined
                }
                error={selected && !selected.configured ? `${selected.provider} has no API key configured.` : undefined}
              />
            )}
            <TrustStatement kind="llm" />
          </div>
        ) : null}

        {SNAPSHOT_MODE ? null : (
          <fieldset className="grid grid-cols-2 gap-3">
            <legend className="mb-1.5 text-sm font-medium text-fg">Search budget</legend>
            <NumberField
              label="Max sequences"
              id={`${baseId}-seq`}
              value={maxSeq}
              onChange={setMaxSeq}
              min={1}
              max={caps?.max_sequences ?? 100000}
              unit="seq"
            />
            <NumberField
              label="Max wall time"
              id={`${baseId}-wall`}
              value={maxWall}
              onChange={setMaxWall}
              min={1}
              max={caps?.max_wall_seconds ?? 86400}
              unit="s"
            />
            {caps ? (
              <p className="col-span-2 text-xs text-muted">
                Server caps for {session.data?.authenticated && session.data.role === "operator" ? "the operator" : "a judge session"}:{" "}
                {caps.max_sequences} sequences, {caps.max_wall_seconds} s
                {isModel || targetRequiresModel ? `, ${caps.max_model_calls} model calls, ${caps.max_model_tokens} tokens` : ""} per
                run. The server lowers anything above them.
              </p>
            ) : null}
          </fieldset>
        )}
      </CardBody>
      {/* Snapshot mode: no budget form and no Run button; the tab says once why. */}
      {SNAPSHOT_MODE ? null : (
        <div className="space-y-2 border-t border-line px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Play />} disabled={disabled} busy={start.isPending} busyLabel="Queuing..." onClick={run}>
              Run {strategy.title.toLowerCase()}
            </Button>
            {blockedReason ? <span className="text-xs text-muted">{blockedReason}</span> : null}
            {!blockedReason && budgetMissing ? <span className="text-xs text-warn">Enter a valid budget.</span> : null}
          </div>
          {start.isError ? <ErrorState error={start.error} title="The backend refused this run" compact /> : null}
          {start.isSuccess && start.data ? (
            <p role="status" className="text-xs text-muted">
              Queued run <span className="font-mono text-fg">{start.data.id}</span> with budget{" "}
              <span className="tabular">
                {start.data.budget.max_sequences} sequences / {start.data.budget.max_wall_seconds} s
              </span>
              {start.data.budget_clamped && Object.keys(start.data.budget_clamped).length > 0
                ? ` (lowered by the server: ${Object.entries(start.data.budget_clamped)
                    .map(([k, v]) => `${k.replaceAll("_", " ")} ${String(v.requested)} -> ${v.effective}`)
                    .join(", ")})`
                : ""}
              . It appears in the run list below.
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
