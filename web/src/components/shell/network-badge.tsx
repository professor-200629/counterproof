"use client";

import { FileText, Globe, Server, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { networkLabel } from "@/lib/chain";
import { useConfig } from "@/lib/queries";
import { SNAPSHOT_MANIFEST, SNAPSHOT_MODE } from "@/lib/snapshot";

/**
 * Top-bar badge for the backend's configured network, e.g.
 * "Local anvil (31337) - not Monad", "Monad Testnet (10143)", "Off-chain only".
 * Shows "RPC unreachable" in amber when the backend cannot reach the chain.
 */
export function NetworkBadge() {
  const { data: config, isPending, isError } = useConfig();
  if (SNAPSHOT_MODE) {
    // The recorded network, from the build's manifest. The backend's RPC / contract health
    // was a moment in the recording, not something this page checks.
    const n = SNAPSHOT_MANIFEST?.network ?? config?.network;
    if (!n) return <Badge tone="neutral">Network: as recorded</Badge>;
    const icon = n === "monad-testnet" ? <Globe /> : n === "anvil-local" ? <Server /> : <FileText />;
    return (
      <Badge
        tone="neutral"
        icon={icon}
        title={`Recorded on ${SNAPSHOT_MANIFEST?.network_label ?? config?.network_label ?? networkLabel(n)}. This hosted snapshot is not connected to that network's evaluator.`}
      >
        {networkLabel(n)}
      </Badge>
    );
  }
  if (isPending) {
    return (
      <Badge tone="neutral" aria-live="polite">
        Network: loading
      </Badge>
    );
  }
  if (isError || !config) {
    return (
      <Badge tone="warn" icon={<Unplug />} title="GET /api/config failed. The backend may not be running.">
        Backend unreachable
      </Badge>
    );
  }
  const n = config.network;
  const icon = n === "monad-testnet" ? <Globe /> : n === "anvil-local" ? <Server /> : <FileText />;
  const onChain = n !== "offchain";
  const unreachable = onChain && !config.chain.reachable;
  const wrongChain = onChain && config.chain.reachable && config.chain.chain_id_matches === false;
  const noContract = onChain && config.chain.reachable && config.chain.contract_has_code === false;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone="neutral" icon={icon} title={config.network_label}>
        {networkLabel(n)}
      </Badge>
      {unreachable ? (
        <Badge tone="warn" title={config.chain.error ?? "The backend could not reach the chain RPC."}>
          RPC unreachable
        </Badge>
      ) : null}
      {wrongChain ? (
        <Badge
          tone="warn"
          title={`The RPC reports chain ${config.chain.rpc_chain_id ?? "unknown"}, the backend expects ${config.chain.chain_id ?? "unknown"}.`}
        >
          Chain id mismatch
        </Badge>
      ) : null}
      {noContract ? (
        <Badge tone="warn" title={`No contract code at ${config.chain.contract ?? "the configured address"}.`}>
          Contract not deployed
        </Badge>
      ) : null}
    </span>
  );
}
