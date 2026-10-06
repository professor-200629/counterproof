import type { ReactNode } from "react";
import { StatusBadge } from "@/components/ui/status-badge";
import { TimeAgo } from "@/components/ui/time";
import { Address } from "@/components/ui/address";
import { TxHash } from "@/components/tx-hash";
import type { ActivityEntry, ChainTransaction } from "@/lib/api";
import { cn } from "@/lib/cn";

const KIND_WORD: Record<string, string> = {
  fund: "Funding",
  commit: "Commit",
  settle: "Settlement",
  refund: "Refund",
  withdraw: "Withdrawal",
  deploy: "Deployment",
};

/**
 * Transactions the backend recorded after reading their receipts from the chain.
 * Failed rows are red and show the backend's reason; they are never shown as confirmed.
 */
export function RecordedTxList({
  txs,
  empty,
  renderDetail,
  className,
}: {
  txs: ChainTransaction[];
  empty?: ReactNode;
  /** Extra, kind-specific detail under a row (backend-verified `detail` fields). */
  renderDetail?: (tx: ChainTransaction) => ReactNode;
  className?: string;
}) {
  if (txs.length === 0) return empty ? <>{empty}</> : null;
  return (
    <ul className={cn("space-y-2", className)} aria-label="Recorded transactions">
      {txs.map((t) => (
        <li
          key={`${t.chain_id}-${t.hash}`}
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            t.status === "failed" ? "border-bad-line bg-bad-soft" : t.status === "pending" ? "border-warn-line bg-warn-soft" : "border-line bg-inset",
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">{KIND_WORD[t.kind] ?? t.kind}</span>
            <StatusBadge status={t.status} domain="tx" size="sm" />
            {t.block_number !== null ? (
              <span className="text-xs text-muted">
                block <span className="font-mono tabular">{t.block_number}</span>
              </span>
            ) : null}
            <span className="text-xs text-muted">
              recorded <TimeAgo ts={t.updated_at} />
            </span>
          </div>
          <div className="mt-1">
            <TxHash hash={t.hash} chainId={t.chain_id} label={`${KIND_WORD[t.kind] ?? t.kind} transaction hash`} />
          </div>
          {t.from_addr ? (
            <div className="mt-1 text-xs text-muted">
              sent by <Address value={t.from_addr} label="sender" />
            </div>
          ) : null}
          {t.status === "failed" ? (
            <p className="mt-1 text-xs font-medium text-bad">
              {t.error ? `Failed: ${t.error}` : "Failed on chain (reverted)."} Nothing was paid by this transaction.
            </p>
          ) : null}
          {renderDetail ? renderDetail(t) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Wallet attempts the backend logged without a receipt (rejected in the wallet, or the
 * wallet could not send). Shown amber/red with the backend's message.
 */
export function FailedAttempts({ entries, className }: { entries: ActivityEntry[]; className?: string }) {
  if (entries.length === 0) return null;
  return (
    <div className={cn("space-y-1.5", className)}>
      <p className="text-xs font-medium text-muted">Attempts that did not produce a transaction</p>
      <ul className="space-y-1.5">
        {entries.slice(0, 5).map((e) => {
          const rejected = /reject/i.test(e.message);
          return (
            <li
              key={e.id}
              className={cn(
                "rounded-md border px-3 py-1.5 text-xs",
                rejected ? "border-warn-line bg-warn-soft text-fg" : "border-bad-line bg-bad-soft text-fg",
              )}
            >
              <span className={cn("font-semibold", rejected ? "text-warn" : "text-bad")}>
                {rejected ? "Rejected in wallet" : "Not sent"}
              </span>{" "}
              <span className="break-words">{e.message}</span>{" "}
              <span className="text-muted">
                (<TimeAgo ts={e.created_at} />)
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
