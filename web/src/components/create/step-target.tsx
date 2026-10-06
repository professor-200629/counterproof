"use client";

import { Bot, TriangleAlert } from "lucide-react";
import { Badge, Callout, Digest, EmptyState, ProvenanceBadge } from "@/components/ui";
import type { AppConfig, Target } from "@/lib/api";
import { cn } from "@/lib/cn";

export interface StepTargetProps {
  targets: Target[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  config: AppConfig | undefined;
}

/** Step 1: which agent version the promises are about. */
export function StepTarget({ targets, selectedKey, onSelect, config }: StepTargetProps) {
  if (targets.length === 0) {
    return (
      <EmptyState
        title="The backend lists no targets"
        description="GET /api/targets returned an empty list. A target adapter must be registered in the backend before a challenge can be published."
      />
    );
  }
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">Target agent and version</legend>
      <ul className="grid gap-3 lg:grid-cols-3">
        {targets.map((t) => (
          <li key={t.key} className="min-w-0">
            <TargetCard target={t} checked={selectedKey === t.key} onSelect={() => onSelect(t.key)} config={config} />
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function TargetCard({
  target: t,
  checked,
  onSelect,
  config,
}: {
  target: Target;
  checked: boolean;
  onSelect: () => void;
  config: AppConfig | undefined;
}) {
  const id = `target-${t.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const fixture = t.label === "intentionally-vulnerable-fixture";
  const stochastic = t.determinism === "stochastic";
  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col gap-3 rounded-lg border bg-surface p-4 transition-colors",
        checked ? "border-accent-line ring-1 ring-accent-line" : "border-line hover:border-line-strong",
      )}
    >
      <div className="flex items-start gap-2.5">
        <input
          id={id}
          type="radio"
          name="target"
          value={t.key}
          checked={checked}
          onChange={onSelect}
          aria-describedby={`${id}-desc`}
          className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
        />
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
          <span className="block text-sm font-semibold text-fg">{t.title}</span>
          <span className="mt-0.5 block font-mono text-xs text-muted">
            {t.adapter}@{t.version}
          </span>
        </label>
      </div>

      <div>
        <ProvenanceBadge kind="target" value={t.label} requiresModel={t.requires_model} />
      </div>

      <p id={`${id}-desc`} className="text-sm text-muted">
        {t.description}
      </p>

      {fixture && t.planted_defects.length > 0 ? (
        <div className="rounded-md border border-warn-line bg-warn-soft px-3 py-2">
          <p className="text-xs font-semibold text-warn">Planted defects (known in advance)</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-fg">
            {t.planted_defects.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted">Findings against this target are demonstrations, not discoveries.</p>
        </div>
      ) : null}

      <dl className="mt-auto grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted">Version</dt>
        <dd className="font-mono text-fg">{t.version}</dd>
        <dt className="text-muted">Artifact</dt>
        <dd className="min-w-0">
          <Digest value={t.artifact_digest} label={`${t.key} artifact digest`} head={6} tail={4} />
        </dd>
        <dt className="text-muted">Behaviour</dt>
        <dd>
          <Badge tone={stochastic ? "warn" : "neutral"} size="sm" icon={stochastic ? <TriangleAlert /> : undefined}>
            {stochastic ? "Stochastic" : "Deterministic"}
          </Badge>
        </dd>
        <dt className="text-muted">Provenance</dt>
        <dd className="text-fg">{t.provenance}</dd>
      </dl>

      {stochastic ? (
        <Callout tone="warn" icon={<Bot />} title="Live model: results are statistical">
          Needs <code className="font-mono text-xs">COUNTERPROOF_LLM_PROVIDER</code>. Replays call a hosted model, so a
          verdict holds for this model on this date only.{" "}
          {config ? (
            <span className="text-muted">
              This backend reports live model provider{" "}
              <span className="font-mono text-xs text-fg">{config.live_model.provider ?? "not set"}</span>
              {config.live_model.model ? (
                <>
                  , model <span className="font-mono text-xs text-fg">{config.live_model.model}</span>
                </>
              ) : null}
              .
            </span>
          ) : null}
        </Callout>
      ) : null}
    </div>
  );
}
