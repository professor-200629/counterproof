import { TrustStatement } from "@/components/truth";
import { Address } from "@/components/ui/address";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { KeyValueList } from "@/components/ui/stat";
import type { AppConfig, ChallengeSpec, ComponentInfo, EvidenceBundle } from "@/lib/api";
import { DataPairs } from "./values";
import { MatchMark } from "@/components/ui/match-mark";
import type { SignatureBinding } from "@/components/settlement/use-recovered-signer";

function ComponentRow({ c, label }: { c: ComponentInfo; label: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs text-fg">
        {c.name}@{c.version}
      </span>
      <Digest value={c.digest} label={`${label} digest`} />
    </span>
  );
}

export interface WhoCheckedProps {
  bundle: EvidenceBundle;
  /** The spec, to compare the declared evaluator and component versions. */
  spec: ChallengeSpec | null;
  /** Backend config, for the isolation backend's own description. */
  config: AppConfig | null;
  /** Whether an attestation signature recovers to the evaluator address (checked in this browser). */
  binding: SignatureBinding;
  /** Heading level of the card title (2 when it is a top-level page section). */
  level?: 2 | 3;
  headingId?: string;
}

/** One line on what ties this bundle to the evaluator's key. */
export function BindingMark({ binding, address }: { binding: SignatureBinding; address: string }) {
  switch (binding.state) {
    case "unsigned":
      return (
        <span className="text-xs text-warn">
          Unsigned: no attestation binds this bundle to the evaluator&apos;s key. It is this backend&apos;s record of a replay it
          ran on behalf of the declared evaluator.
        </span>
      );
    case "checking":
      return <span className="text-xs text-muted">Recovering the attestation signer in this browser.</span>;
    case "unrecoverable":
      return <span className="text-xs text-bad">The attestation signature could not be recovered: {binding.message}</span>;
    case "recovered":
      return (
        <MatchMark
          ok={binding.matches}
          okText="the attestation signature recovers to this address (checked in this browser)"
          badText={
            <>
              the attestation signature recovers to <span className="font-mono">{binding.address}</span>, not {address}
            </>
          }
        />
      );
  }
}

/**
 * Who produced this verdict: the declared trusted evaluator, the software and component
 * versions (with digests) it ran, and the isolation each replay ran in.
 */
export function WhoChecked({ bundle, spec, config, binding, level = 3, headingId }: WhoCheckedProps) {
  const ev = bundle.evaluator;
  const declared = spec?.evaluator ?? null;
  const backends = Array.from(
    new Set(bundle.replays.map((r) => (r.isolation && typeof r.isolation.backend === "string" ? r.isolation.backend : null)).filter(Boolean)),
  ) as string[];
  const firstIso = bundle.replays.find((r) => r.isolation)?.isolation ?? null;
  return (
    <Card>
      <CardHeader
        id={headingId}
        title="Who checked it"
        level={level}
        description="The replay ran under the evaluator declared in the spec; the challenger's own check plays no part in this verdict. Only an attestation signature ties the result to the evaluator's key."
      />
      <CardBody className="space-y-4">
        <KeyValueList
          items={[
            {
              key: "addr",
              label: "Evaluator",
              value: (
                <span className="flex flex-col gap-1">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Address value={ev.address} label="evaluator address" />
                    <span className="text-xs text-muted">
                      address declared in the spec{declared?.name ? ` (${declared.name})` : ""}, copied into this bundle by the backend
                    </span>
                  </span>
                  <BindingMark binding={binding} address={ev.address} />
                </span>
              ),
            },
            {
              key: "trust",
              label: "Trust model",
              value: spec ? (
                <span>
                  <span className="font-mono text-xs">{spec.evaluator_trust}</span>
                  <span className="text-muted"> - a named party you choose to trust, not a proof system</span>
                </span>
              ) : (
                "declared trusted party"
              ),
            },
            { key: "sw", label: "Software", value: <span className="font-mono text-xs">{ev.software}</span> },
            { key: "market", label: "Synthetic market", value: <ComponentRow c={ev.market} label="market" /> },
            { key: "runner", label: "Runner", value: <ComponentRow c={ev.runner} label="runner" /> },
            { key: "checker", label: "Deterministic checker", value: <ComponentRow c={ev.checker} label="checker" /> },
            ...(spec
              ? [
                  {
                    key: "pinned",
                    label: "Versions pinned by the spec",
                    value: (
                      <span className="flex flex-col gap-0.5">
                        <MatchMark ok={ev.market.digest === spec.environment.market.digest} okText="market digest matches" badText="market digest differs from the spec" />
                        <MatchMark ok={ev.runner.digest === spec.environment.runner.digest} okText="runner digest matches" badText="runner digest differs from the spec" />
                        <MatchMark ok={ev.checker.digest === spec.checker.digest} okText="checker digest matches" badText="checker digest differs from the spec" />
                      </span>
                    ),
                  },
                ]
              : []),
            {
              key: "iso",
              label: "Isolation",
              value: (
                <span className="flex flex-col gap-1">
                  <span>
                    <span className="font-mono text-xs">{backends.length ? backends.join(", ") : "not reported"}</span>
                    {spec ? <span className="text-muted"> (the spec requires {spec.environment.isolation})</span> : null}
                  </span>
                  {firstIso ? <DataPairs data={firstIso} /> : null}
                  {backends.map((b) =>
                    config?.isolation?.[b] ? (
                      <span key={b} className="text-xs text-muted">
                        Backend description ({b}, current config): {config.isolation[b].detail}
                      </span>
                    ) : null,
                  )}
                </span>
              ),
            },
          ]}
        />
        <TrustStatement kind="attestation" />
        <TrustStatement kind="llm" />
      </CardBody>
    </Card>
  );
}
