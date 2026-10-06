import { Bot, FileText, FlaskConical, Globe, Server, Wrench } from "lucide-react";
import type { NetworkKind, TargetLabel } from "@/lib/api";
import { networkLabel } from "@/lib/chain";
import { Badge, type BadgeSize } from "./badge";

export type ProvenanceBadgeProps =
  | {
      kind: "target";
      /** Target label from the backend (spec.target.label / target_info.label). */
      value: TargetLabel | string;
      /** For independent implementations: whether a live hosted model drives it (default true). */
      requiresModel?: boolean;
      size?: BadgeSize;
      className?: string;
    }
  | {
      kind: "network";
      value: NetworkKind | string;
      size?: BadgeSize;
      className?: string;
    };

/**
 * Where a result comes from. Targets:
 *  - intentionally-vulnerable-fixture -> prominent amber "Intentionally vulnerable fixture - planted defects"
 *  - repaired-fixture -> "Repaired fixture"
 *  - independent-implementation -> "Independent implementation (live model)"
 * Networks: "Monad Testnet (10143)", "Local anvil (31337) - not Monad", "Off-chain only".
 */
export function ProvenanceBadge(props: ProvenanceBadgeProps) {
  const { size, className } = props;
  if (props.kind === "network") {
    const v = props.value;
    const icon = v === "monad-testnet" ? <Globe /> : v === "anvil-local" ? <Server /> : <FileText />;
    return (
      <Badge tone="neutral" size={size} icon={icon} className={className} title={networkTitle(v)}>
        {networkLabel(v)}
      </Badge>
    );
  }
  switch (props.value) {
    case "intentionally-vulnerable-fixture":
      return (
        <Badge
          tone="warn"
          size={size ?? "lg"}
          icon={<FlaskConical />}
          className={className}
          title="Written with planted defects so the full loop can be demonstrated. Findings against it are demonstrations, not discoveries."
        >
          Intentionally vulnerable fixture - planted defects
        </Badge>
      );
    case "repaired-fixture":
      return (
        <Badge
          tone="neutral"
          size={size}
          icon={<Wrench />}
          className={className}
          title="The fixture with its planted defects repaired by the CounterProof team."
        >
          Repaired fixture
        </Badge>
      );
    case "independent-implementation":
      return (
        <Badge
          tone="neutral"
          size={size}
          icon={<Bot />}
          className={className}
          title="Not written to fail. Decisions come from a hosted language model; results are statistical and depend on provider, model and date."
        >
          {props.requiresModel === false ? "Independent implementation" : "Independent implementation (live model)"}
        </Badge>
      );
    default:
      return (
        <Badge tone="neutral" size={size} className={className}>
          {props.value || "Unknown provenance"}
        </Badge>
      );
  }
}

function networkTitle(v: string): string {
  if (v === "anvil-local") return "A local development chain on this machine. Transactions here are not on Monad.";
  if (v === "monad-testnet") return "Monad public testnet. Test MON has no monetary value.";
  if (v === "offchain") return "No blockchain: no reward, no settlement; evidence bundles only.";
  return v;
}
