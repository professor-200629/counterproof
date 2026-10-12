import { Bot, FileText, FlaskConical, Globe, Server, Wrench } from "lucide-react";
import type { NetworkKind, TargetLabel } from "@/lib/api";
import { networkLabel } from "@/lib/chain";
import { cn } from "@/lib/cn";
import { targetLabelText, targetLabelTitle } from "@/lib/target-labels";
import { Badge, type BadgeSize } from "./badge";

export type ProvenanceBadgeProps =
  | {
      kind: "target";
      /** Target label from the backend (spec.target.label / target_info.label). */
      value: TargetLabel | string;
      /** For live-model agents: whether a hosted model drives it (default true). */
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
 * Where a result comes from. Targets (display text from lib/target-labels.ts; the stored
 * label values never change):
 *  - intentionally-vulnerable-fixture -> prominent amber "Intentionally vulnerable fixture - planted defects"
 *  - repaired-fixture -> "Repaired fixture"
 *  - independent-implementation -> "Live-model agent (team-written, no planted defects)"
 *  - repaired-live-model -> "Repaired live-model agent (team-written)"
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
  const text = targetLabelText(props.value, props.requiresModel);
  const title = targetLabelTitle(props.value);
  // A target label is a statement about provenance: on a narrow screen it wraps instead of
  // being cut off with an ellipsis ("lg" badges already wrap).
  const wrap = (s: BadgeSize | undefined) => cn(s !== "lg" && WRAP_SMALL, className);
  switch (props.value) {
    case "intentionally-vulnerable-fixture":
      return (
        <Badge tone="warn" size={size ?? "lg"} icon={<FlaskConical />} className={wrap(size ?? "lg")} title={title}>
          {text}
        </Badge>
      );
    case "repaired-fixture":
    case "repaired-live-model":
      return (
        <Badge tone="neutral" size={size} icon={<Wrench />} className={wrap(size)} title={title}>
          {text}
        </Badge>
      );
    case "independent-implementation":
      return (
        <Badge tone="neutral" size={size} icon={<Bot />} className={wrap(size)} title={title}>
          {text}
        </Badge>
      );
    default:
      return (
        <Badge tone="neutral" size={size} className={wrap(size)}>
          {text}
        </Badge>
      );
  }
}

/**
 * Overrides of the sm / md Badge presets (fixed height, pill, one truncated line) so the label
 * text wraps. `cn` is plain clsx, so the overrides use Tailwind's important modifier to win
 * regardless of stylesheet order.
 */
const WRAP_SMALL = "h-auto! rounded-md! py-0.5! leading-snug! [&>span:last-child]:whitespace-normal";

function networkTitle(v: string): string {
  if (v === "anvil-local") return "A local development chain on this machine. Transactions here are not on Monad.";
  if (v === "monad-testnet") return "Monad public testnet. Test MON has no monetary value.";
  if (v === "offchain") return "No blockchain: no reward, no settlement; evidence bundles only.";
  return v;
}
