"use client";

import { Blocks, Bot, Box, KeyRound, Link2, ShieldCheck } from "lucide-react";
import { useId, type ReactNode } from "react";
import { TrustStatement } from "@/components/truth";
import { Address } from "@/components/ui/address";
import { Badge } from "@/components/ui/badge";
import { Callout, Card, CardBody, CardHeader } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { ProvenanceBadge } from "@/components/ui/provenance-badge";
import { ErrorState, QueryState } from "@/components/ui/states";
import { TextLink } from "@/components/ui/text-link";
import type { AppConfig, ComponentInfo, IsolationBackend } from "@/lib/api";
import { MONADSCAN_TX_BASE } from "@/lib/chain";
import { formatNumber, sameHex } from "@/lib/format";
import { useConfig } from "@/lib/queries";
import { Facts, Indicator } from "./shared";

/**
 * "Environment and trust": what GET /api/config says about this backend - network and
 * contract, the declared trusted evaluator and its signer, isolation backends, live-model
 * providers (presence only) and the pinned component digests.
 */
export function EnvironmentPanel({ headingId = "environment-heading" }: { headingId?: string }) {
  const q = useConfig();
  return (
    <Card as="section" aria-labelledby={headingId}>
      <CardHeader
        id={headingId}
        level={2}
        title="Environment and trust"
        description="As reported by this backend (GET /api/config). Keys are never shown, only whether one is present."
      />
      <CardBody>
        {q.data ? (
          <>
            {q.isError ? (
              <ErrorState compact className="mb-4" title="Could not refresh; showing the last loaded configuration" error={q.error} onRetry={() => void q.refetch()} />
            ) : null}
            <EnvironmentBody config={q.data} />
          </>
        ) : (
          <QueryState query={q} label="backend configuration" rows={5} />
        )}
      </CardBody>
    </Card>
  );
}

function EnvironmentBody({ config }: { config: AppConfig }) {
  return (
    <div className="grid gap-x-8 gap-y-8 md:grid-cols-2">
      <Group title="Chain and settlement" icon={<Link2 />}>
        <ChainFacts config={config} />
      </Group>
      <Group title="Evaluator and signer" icon={<ShieldCheck />}>
        <EvaluatorFacts config={config} />
      </Group>
      <Group title="Isolation" icon={<Box />}>
        <IsolationFacts config={config} />
      </Group>
      <Group title="Live-model providers" icon={<Bot />}>
        <ProviderFacts config={config} />
      </Group>
      <Group title="Pinned components" icon={<Blocks />} className="md:col-span-2">
        <ComponentFacts config={config} />
      </Group>
    </div>
  );
}

function Group({ title, icon, children, className }: { title: string; icon: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={className}>
      <h3 id={id} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-subtle">
        <span aria-hidden="true" className="[&>svg]:size-3.5">
          {icon}
        </span>
        {title}
      </h3>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------- chain
function ChainFacts({ config }: { config: AppConfig }) {
  const c = config.chain;
  const network = (
    <span className="flex flex-col items-start gap-1">
      <ProvenanceBadge kind="network" value={config.network} />
      <span className="text-xs text-muted">Backend label: {config.network_label}</span>
    </span>
  );
  if (config.network === "offchain") {
    return (
      <>
        <Facts items={[{ key: "network", label: "Network", value: network }]} />
        <Callout tone="neutral" title="No chain configured">
          Challenges here are evidence-only: no reward escrow, no attestation request, no settlement transaction.
        </Callout>
      </>
    );
  }
  const mismatch = c.reachable && c.chain_id_matches === false;
  return (
    <>
      <Facts
        items={[
          { key: "network", label: "Network", value: network },
          {
            key: "chain-id",
            label: "Chain id",
            value: (
              <span className="flex flex-col items-start gap-1">
                <span className="font-mono text-xs">{c.chain_id ?? "not set"}</span>
                {mismatch ? (
                  <Indicator tone="warn">
                    RPC reports chain {c.rpc_chain_id ?? "unknown"}; transactions would go to the wrong chain
                  </Indicator>
                ) : null}
              </span>
            ),
          },
          {
            key: "rpc",
            label: "RPC",
            value: (
              <span className="flex flex-col items-start gap-1">
                {c.reachable ? (
                  <Indicator tone="ok">
                    Reachable{typeof c.block === "number" ? `, block ${formatNumber(c.block)}` : ""}
                  </Indicator>
                ) : (
                  <Indicator tone="warn">Unreachable</Indicator>
                )}
                {c.rpc ? <span className="break-all font-mono text-xs text-muted">{c.rpc}</span> : null}
                {c.error ? <span className="text-xs text-muted">Backend says: {c.error}</span> : null}
              </span>
            ),
          },
          {
            key: "contract",
            label: "CounterProof contract",
            value: (
              <span className="flex flex-col items-start gap-1">
                {c.contract ? (
                  <Digest value={c.contract} label="contract address" head={8} tail={6} />
                ) : (
                  <Indicator tone="warn">No contract address configured</Indicator>
                )}
                {c.contract && c.contract_has_code === false ? (
                  <Indicator tone="warn">No contract code at this address</Indicator>
                ) : null}
                {c.contract && c.contract_has_code === true ? <Indicator tone="ok">Contract code present</Indicator> : null}
              </span>
            ),
          },
          {
            key: "explorer",
            label: "Explorer",
            value:
              config.network === "monad-testnet" ? (
                <TextLink href={MONADSCAN_TX_BASE.replace(/\/tx\/$/, "")} external>
                  testnet.monadscan.com
                </TextLink>
              ) : (
                <span className="text-muted">
                  None. Local anvil (31337) is a development chain on this machine, not Monad; its transactions have no
                  public explorer.
                </span>
              ),
          },
        ]}
      />
      <TrustStatement kind="receipt" />
    </>
  );
}

// ---------------------------------------------------------------------------- evaluator / signer
function EvaluatorFacts({ config }: { config: AppConfig }) {
  const s = config.signer;
  const offchain = config.network === "offchain";
  const matches = sameHex(s.address, config.evaluator_address);
  const bot = config.challenger_bot;
  const items = [
    {
      key: "evaluator",
      label: "Evaluator address",
      value: (
        <span className="flex flex-col items-start gap-1">
          {config.evaluator_address ? (
            <Address value={config.evaluator_address} label="evaluator address" />
          ) : (
            <Indicator tone="warn">No evaluator address configured</Indicator>
          )}
          <Badge tone="neutral" size="sm">
            Declared trusted evaluator
          </Badge>
          <span className="text-xs text-muted">
            It replays every candidate in a fresh synthetic marketplace and signs an EIP-712 attestation about its own
            replay. You trust this party; the signature is not a zero-knowledge proof.
          </span>
        </span>
      ),
    },
    {
      key: "signer",
      label: "Signer service",
      value: (
        <span className="flex flex-col items-start gap-1">
          {s.reachable ? (
            <Indicator tone="ok">Reachable</Indicator>
          ) : offchain ? (
            <Indicator tone="neutral">Not reachable - not needed off-chain</Indicator>
          ) : (
            <Indicator tone="warn">Unreachable - attestations cannot be signed</Indicator>
          )}
          {s.reachable && s.configured === true ? <Indicator tone="ok">Signing key configured</Indicator> : null}
          {s.reachable && s.configured === false ? <Indicator tone="warn">No signing key configured</Indicator> : null}
          {s.address ? <Address value={s.address} label="signer address" /> : null}
          {matches === false ? (
            <Indicator tone="warn">Signer address differs from the declared evaluator; its attestations would not settle</Indicator>
          ) : null}
          {matches === true ? <Indicator tone="ok">Matches the declared evaluator</Indicator> : null}
          <span className="break-all font-mono text-xs text-muted">{s.url}</span>
          <span className="text-xs text-muted">Attestations are only requested for funded on-chain challenges.</span>
        </span>
      ),
    },
  ];
  if (!offchain) {
    items.push({
      key: "bot",
      label: "Built-in challenger",
      value: (
        <span className="flex flex-col items-start gap-1">
          <Address value={bot.address} label="challenger address" showRole />
          <Address value={bot.recipient} label="reward recipient" showRole />
          {bot.can_commit ? (
            <Indicator tone="ok">Can commit submissions on chain</Indicator>
          ) : (
            <Indicator tone="neutral">Cannot commit on chain (no challenger key configured)</Indicator>
          )}
        </span>
      ),
    });
  }
  return (
    <>
      <Facts items={items} />
      <TrustStatement kind="attestation" />
    </>
  );
}

// ---------------------------------------------------------------------------- isolation
const ISOLATION_NAMES: Record<string, string> = {
  process: "Process isolation",
  container: "Container isolation (Docker)",
};

function containerUnavailableTitle(detail: string): string {
  return /docker/i.test(detail) && /not running|unavailable|cannot connect/i.test(detail)
    ? "Docker engine not running"
    : "Container isolation unavailable";
}

function IsolationFacts({ config }: { config: AppConfig }) {
  const entries = Object.entries(config.isolation) as [string, IsolationBackend][];
  const container = config.isolation.container;
  const process = config.isolation.process;
  return (
    <>
      <ul className="divide-y divide-line rounded-md border border-line">
        {entries.map(([name, b]) => (
          <li key={name} className="space-y-1 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-sm font-medium text-fg">{ISOLATION_NAMES[name] ?? name}</span>
              <Indicator tone={b.available ? "ok" : "warn"}>{b.available ? "Available" : "Unavailable"}</Indicator>
              {name === config.default_isolation ? (
                <Badge tone="neutral" size="sm">
                  Default for new challenges
                </Badge>
              ) : null}
            </div>
            <p className="text-xs text-muted">{b.detail}</p>
          </li>
        ))}
      </ul>
      {container && !container.available ? (
        <Callout tone="warn" title={`${containerUnavailableTitle(container.detail)}: executable targets fail closed`}>
          Targets that require container isolation are refused rather than run with weaker isolation; there is no silent
          fallback.
          {process?.available ? " Challenges that use process isolation still run." : ""}
        </Callout>
      ) : null}
      {process && !process.available ? (
        <Callout tone="warn" title="Process isolation unavailable">
          Runs and replays that require it fail closed.
        </Callout>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------- providers
function ProviderFacts({ config }: { config: AppConfig }) {
  const live = config.live_model;
  return (
    <>
      {config.providers.length === 0 ? (
        <p className="text-sm text-muted">This backend lists no live-model providers.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {config.providers.map((p) => (
            <li key={p.provider} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">
                  {p.provider} <span className="font-mono text-xs font-normal text-subtle">{p.key_env}</span>
                </p>
                <p className="break-all font-mono text-xs text-muted">default model {p.default_model}</p>
              </div>
              <span className="inline-flex items-center gap-1.5">
                <KeyRound aria-hidden="true" className="size-3.5 text-subtle" />
                <Indicator tone={p.configured ? "ok" : "neutral"}>{p.configured ? "Key present" : "No key"}</Indicator>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Facts
        items={[
          {
            key: "live",
            label: "Live model setting",
            value: live.provider ? (
              <span className="font-mono text-xs">
                {live.provider}
                {live.model ? ` / ${live.model}` : ""}
              </span>
            ) : (
              <span className="flex flex-col items-start gap-1">
                <Indicator tone="warn">Not set</Indicator>
                <span className="text-xs text-muted">
                  Runs against targets that need a live model are refused until COUNTERPROOF_LLM_PROVIDER is set.
                </span>
              </span>
            ),
          },
        ]}
      />
      <p className="text-xs text-muted">
        Models are only used by independent-implementation targets and model-assisted search.
      </p>
      <TrustStatement kind="llm" />
    </>
  );
}

// ---------------------------------------------------------------------------- components
const COMPONENT_ROLES: { key: keyof AppConfig["components"]; role: string }[] = [
  { key: "market", role: "Synthetic marketplace" },
  { key: "runner", role: "Replay runner" },
  { key: "checker", role: "Deterministic checker" },
];

function ComponentFacts({ config }: { config: AppConfig }) {
  return (
    <>
      <ul className="grid gap-3 sm:grid-cols-3">
        {COMPONENT_ROLES.map(({ key, role }) => {
          const comp: ComponentInfo | undefined = config.components[key];
          return (
            <li key={key} className="min-w-0 space-y-1 rounded-md border border-line bg-inset px-3 py-2.5">
              <p className="text-xs text-muted">{role}</p>
              {comp ? (
                <>
                  <p className="break-all font-mono text-xs text-fg">
                    {comp.name}@{comp.version}
                  </p>
                  <Digest value={comp.digest} label={`${comp.name} digest`} />
                </>
              ) : (
                <p className="text-sm text-subtle">not reported</p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted">
        Backend version <span className="font-mono">{config.version}</span>. New challenge specs record these digests, so
        a replay can be matched to the exact code that produced it.
      </p>
    </>
  );
}
