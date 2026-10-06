import { Digest } from "@/components/ui/digest";
import { ANVIL_CHAIN_ID, explorerTxUrlForChainId, txNetworkPhrase } from "@/lib/chain";
import { cn } from "@/lib/cn";

/** Words for an anvil transaction: never "Monad", never an explorer link. */
export const ANVIL_TX_NOTE = "local anvil (31337) transaction - no public explorer";

export interface TxHashProps {
  hash: string | null | undefined;
  /** The chain the transaction belongs to (the recorded row's chain_id, else the challenge's). */
  chainId: number | null | undefined;
  /** What the hash is ("funding transaction hash"); used for the copy button. */
  label?: string;
  /** Characters kept around the ellipsis. */
  head?: number;
  tail?: number;
  /** Text when there is no hash. */
  emptyText?: string;
  className?: string;
}

/**
 * A transaction hash with its network. Monad testnet hashes link to MonadScan; local anvil
 * hashes say "local anvil (31337)" and have no link. Used wherever a single transaction is
 * shown (tables with their own Network column may use Digest directly).
 */
export function TxHash({ hash, chainId, label = "transaction hash", head = 10, tail = 8, emptyText = "no transaction", className }: TxHashProps) {
  if (!hash) return <span className={cn("text-sm text-subtle", className)}>{emptyText}</span>;
  const href = explorerTxUrlForChainId(chainId, hash);
  return (
    <span className={cn("inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-0.5", className)}>
      <Digest value={hash} label={label} href={href} head={head} tail={tail} />
      <span className="text-xs text-muted">
        {href ? `on ${txNetworkPhrase(chainId)} (opens MonadScan)` : chainId === ANVIL_CHAIN_ID ? ANVIL_TX_NOTE : `on ${txNetworkPhrase(chainId)}`}
      </span>
    </span>
  );
}
