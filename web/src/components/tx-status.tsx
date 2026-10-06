import { Info, TriangleAlert } from "lucide-react";
import { Callout } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { StatusBadge } from "@/components/ui/status-badge";
import type { NetworkKind } from "@/lib/api";
import { MONAD_RESERVE_HINT, RECEIPT_MEANING, txNetworkPhrase } from "@/lib/chain";
import { cn } from "@/lib/cn";
import type { BackendReport } from "@/lib/tx";
import type { TxState } from "@/lib/tx-machine";

export interface TxStatusProps {
  /** From useTrackedTx: you can spread the hook result `<TxStatus {...tx} label="Funding" />`. */
  state: TxState;
  report?: BackendReport;
  chainId?: number;
  explorerUrl?: string | null;
  /** What the transaction does: "Funding", "Settlement", "Withdrawal", "Refund". */
  label: string;
  className?: string;
}

/**
 * Live status of one wallet transaction plus what the backend verified about it.
 * Local anvil transactions say "local anvil (31337)" and never link to an explorer.
 */
export function TxStatus({ state, report, chainId, explorerUrl, label, className }: TxStatusProps) {
  if (state.status === "idle") return null;
  const where = txNetworkPhrase(chainId);
  const hash = "hash" in state ? state.hash : undefined;
  return (
    <div role="status" aria-live="polite" className={cn("space-y-2 rounded-lg border border-line bg-surface p-3 text-sm", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{label} transaction</span>
        <StatusBadge status={state.status} domain="tx" />
        {chainId ? <span className="text-xs text-muted">on {where}</span> : null}
      </div>

      {hash ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>Hash</span>
          <Digest value={hash} label="transaction hash" href={explorerUrl ?? undefined} head={10} tail={8} />
          {!explorerUrl ? <span>(no public explorer for {where})</span> : null}
        </div>
      ) : null}

      {state.status === "awaiting_signature" ? <p className="text-muted">Confirm or reject the request in your wallet.</p> : null}
      {state.status === "pending" ? (
        <p className="text-muted">Sent. Waiting for the receipt from {where}; nothing is final until it is mined.</p>
      ) : null}
      {state.status === "confirmed" ? (
        <p className="text-fg">
          Included in block <span className="font-mono tabular">{state.block.toString()}</span> on {where}.{" "}
          <span className="text-muted">{RECEIPT_MEANING}</span>
        </p>
      ) : null}
      {state.status === "failed" ? <p className="font-medium text-bad">{state.reason}</p> : null}
      {state.status === "rejected" ? <p className="text-muted">{state.reason}</p> : null}

      {report ? <ReportLine report={report} /> : null}
    </div>
  );
}

function ReportLine({ report }: { report: BackendReport }) {
  switch (report.status) {
    case "idle":
    case "skipped":
      return null;
    case "reporting":
      return <p className="text-xs text-muted">Backend: reading the receipt from the chain to verify it.</p>;
    case "verified": {
      const r = report.result;
      const failed = "status" in r && r.status === "failed";
      return (
        <p className={cn("text-xs", failed ? "text-bad" : "text-ok")}>
          {failed
            ? "Backend read the receipt: the transaction failed on chain."
            : "Backend verified the receipt and events on chain (values come from the chain, not from this page)."}
        </p>
      );
    }
    case "failure_recorded":
      return <p className="text-xs text-muted">Backend recorded that no transaction was sent.</p>;
    case "error":
      return (
        <p className="text-xs text-bad" role="alert">
          Backend could not verify it: {report.error}
        </p>
      );
  }
}

/** Funding-step notice: shown only on Monad testnet. */
export function MonadReserveNotice({ network, className }: { network: NetworkKind | null | undefined; className?: string }) {
  if (network !== "monad-testnet") return null;
  return (
    <Callout tone="warn" icon={<TriangleAlert />} title="Monad testnet reserve" className={className}>
      {MONAD_RESERVE_HINT}
    </Callout>
  );
}

/** Notice for local anvil: transactions are local test value, not Monad. */
export function LocalChainNotice({ network, className }: { network: NetworkKind | null | undefined; className?: string }) {
  if (network !== "anvil-local") return null;
  return (
    <Callout tone="neutral" icon={<Info />} title="Local anvil chain (31337) - not Monad testnet" className={className}>
      Transactions go to a development chain on this machine. They have no explorer and no value, and they are not Monad
      transactions.
    </Callout>
  );
}
