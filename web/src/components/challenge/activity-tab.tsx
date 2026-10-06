"use client";

import { ActivityList, ActivityRef } from "@/components/activity-list";
import { TrustStatement } from "@/components/truth";
import { Address } from "@/components/ui/address";
import { Digest } from "@/components/ui/digest";
import { Section } from "@/components/ui/section";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { TimeAgo } from "@/components/ui/time";
import type { ChallengeView } from "@/lib/api";
import { explorerTxUrlForChainId, txNetworkPhrase } from "@/lib/chain";
import { formatNumber } from "@/lib/format";

/** Activity: recorded chain transactions (backend-verified receipts) and the backend's activity log. */
export function ActivityTab({ view }: { view: ChallengeView }) {
  const offchain = view.status === "offchain" || view.network === "offchain";
  const txs = [...view.transactions].sort((a, b) => b.created_at - a.created_at);

  return (
    <div className="space-y-8">
      {!offchain || txs.length > 0 ? (
        <Section
          title="Transactions"
          description="Every hash the wallet produced was reported to the backend, which read the receipt from the chain itself. Values here are the backend's, not the browser's."
        >
          {txs.length === 0 ? (
            <EmptyState title="No transactions recorded" description="Funding, settlement, refund and withdrawal transactions appear here once reported." compact />
          ) : (
            <div className="space-y-2">
              <Table className="relative" caption="Recorded transactions for this challenge">
                <THead>
                  <tr>
                    <TH>Kind</TH>
                    <TH>Status</TH>
                    <TH>Hash</TH>
                    <TH>Network</TH>
                    <TH className="text-right">Block</TH>
                    <TH>From</TH>
                    <TH>Recorded</TH>
                  </tr>
                </THead>
                <TBody>
                  {txs.map((t) => (
                    <TR key={`${t.hash}-${t.kind}`}>
                      <TD mono>{t.kind}</TD>
                      <TD>
                        <StatusBadge status={t.status} domain="tx" size="sm" />
                        {t.error ? <span className="mt-1 block max-w-[18rem] break-words text-xs text-bad">{t.error}</span> : null}
                      </TD>
                      <TD>
                        <Digest value={t.hash} label={`${t.kind} transaction hash`} href={explorerTxUrlForChainId(t.chain_id, t.hash)} head={6} tail={4} />
                      </TD>
                      <TD className="whitespace-nowrap text-sm">{txNetworkPhrase(t.chain_id)}</TD>
                      <TD numeric>{t.block_number !== null ? formatNumber(t.block_number) : "-"}</TD>
                      <TD>{t.from_addr ? <Address value={t.from_addr} label="sender" /> : <span className="text-subtle">-</span>}</TD>
                      <TD>
                        <TimeAgo ts={t.created_at} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <TrustStatement kind="receipt" />
            </div>
          )}
        </Section>
      ) : null}

      <Section title="Activity log" description="The backend's own log for this challenge, newest first, verbatim.">
        {view.activity.length === 0 ? (
          <EmptyState title="No activity yet" compact />
        ) : (
          <ActivityList entries={view.activity} renderRef={(e) => <ActivityRef entry={e} chainId={view.chain_id} />} />
        )}
      </Section>
    </div>
  );
}
