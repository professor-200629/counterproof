"use client";

import { ArrowDownToLine, HandCoins, Send, Undo2 } from "lucide-react";
import { useState } from "react";
import { useConnection, useReadContract } from "wagmi";
import type { Address as ViemAddress, Hex } from "viem";
import { Address } from "@/components/ui/address";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { ReasonList } from "@/components/ui/reason-list";
import { Countdown, DateTime } from "@/components/ui/time";
import { TxStatus } from "@/components/tx-status";
import { WalletButton } from "@/components/shell/wallet-button";
import { counterProofAbi } from "@/lib/abi";
import type { ChallengeView, NetworkKind, OnchainChallenge, SettlementAttestation } from "@/lib/api";
import { formatWei, settleArgs, toChecksumAddress, txNetworkPhrase } from "@/lib/chain";
import { useTrackedTx } from "@/lib/tx";
import type { SupportedChainId } from "@/lib/wagmi";
import { ReadOnlyNote } from "@/components/snapshot";
import { SNAPSHOT_MODE } from "@/lib/snapshot";
import { sameAddress } from "./derive";

/**
 * Whether this page may read the contract itself. Always in the local console; in the hosted
 * snapshot only on Monad testnet (public RPC), never the evaluator owner's local anvil chain.
 */
export function canReadChainLive(network: NetworkKind): boolean {
  return !SNAPSHOT_MODE || network === "monad-testnet";
}

export interface ChainTarget {
  /** CounterProof contract the challenge lives in. */
  contract: Hex | null;
  /** Wallet chain for the challenge's network; undefined when off-chain or unknown. */
  chainId: SupportedChainId | undefined;
  network: NetworkKind;
}

/** Disconnected-wallet state with an inline connect control. */
function ConnectPrompt({ what }: { what: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-line px-3 py-2.5 text-sm">
      <span className="text-muted">No wallet connected. Connect one to {what}.</span>
      <WalletButton />
    </div>
  );
}

// ---------------------------------------------------------------------------- settle
export interface SettleActionProps extends ChainTarget {
  view: ChallengeView;
  attestation: SettlementAttestation;
  onchain: OnchainChallenge | null;
  /** Current time in unix seconds (null before hydration). */
  nowSec: number | null;
}

/**
 * Relay the evaluator's attestation to `settle(a, signature)`. Anyone may relay it; the
 * contract pays only the recipient bound at commit time.
 */
export function SettleAction({ view, attestation, onchain, nowSec, contract, chainId, network }: SettleActionProps) {
  const connection = useConnection();
  const tx = useTrackedTx({ kind: "settle", challengeId: view.id, chainId });
  const [argError, setArgError] = useState<string | null>(null);
  const recipient = attestation.typed_data.message.recipient;
  const reward = onchain?.reward_wei ?? view.reward_wei;
  const deadline = onchain?.settlement_deadline ?? view.spec.deadlines.settlement_deadline;
  const domain = attestation.typed_data.domain;
  // A confirmed settle (here or verified by the backend) means a second one can only revert with AlreadySettled.
  const alreadySent = tx.state.status === "confirmed" || (tx.report.status === "verified" && "status" in tx.report.result && tx.report.result.status === "confirmed");

  const reasons: string[] = [];
  if (alreadySent) reasons.push("This settlement transaction is confirmed; sending another would revert with AlreadySettled and still cost gas.");
  if (!sameAddress(attestation.signer, view.spec.evaluator.address)) {
    reasons.push("The attestation signer is not the evaluator declared in the spec; the contract would revert with SignerNotEvaluator.");
  }
  if (chainId !== undefined && Number(domain.chainId) !== chainId) {
    reasons.push(`The attestation is for chain ${domain.chainId}, not ${txNetworkPhrase(chainId)}; the signature would not verify.`);
  }
  if (contract && !sameAddress(domain.verifyingContract, contract)) {
    reasons.push("The attestation names a different verifying contract than this challenge's; the signature would not verify.");
  }
  if (view.status !== "funded") reasons.push(`The challenge is ${view.status.replace(/_/g, " ")}, not funded.`);
  if (onchain && onchain.status !== "funded") reasons.push(`The contract reports this challenge as ${onchain.status}.`);
  if (!contract) reasons.push("No contract address is configured for this challenge.");
  if (!chainId) reasons.push("The challenge's network has no wallet chain.");
  if (nowSec !== null && nowSec > attestation.expiry) reasons.push("The attestation has expired; the contract would revert with AttestationExpired.");
  if (nowSec !== null && nowSec > deadline) reasons.push("The settlement deadline has passed; the contract would revert with SettlementDeadlinePassed.");

  const onRelay = async () => {
    setArgError(null);
    if (!contract) return;
    let args: ReturnType<typeof settleArgs>;
    try {
      args = settleArgs(attestation.typed_data, attestation.signature);
    } catch (e) {
      setArgError(e instanceof Error ? e.message : String(e));
      return;
    }
    await tx.send({ address: contract, abi: counterProofAbi, functionName: "settle", args });
  };

  return (
    <div className="space-y-3">
      <Callout tone="neutral" icon={<HandCoins />} title="Anyone may relay - the payout always goes to the bound recipient">
        Whoever sends this transaction (the challenger, the publisher or anyone else) pays its gas and receives nothing. The
        contract credits the reward only to the recipient that was bound when the submission was committed:{" "}
        <span className="font-mono text-xs break-all">{recipient}</span>.
      </Callout>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr]">
        <dt className="text-muted">Recipient (bound at commit)</dt>
        <dd className="min-w-0">
          <Address value={recipient} label="payout recipient" full />
        </dd>
        <dt className="text-muted">Reward in escrow</dt>
        <dd className="tabular text-fg">
          {formatWei(reward, network)}{" "}
          <span className="text-xs text-muted">{onchain ? "(read from the contract by the backend)" : "(from the backend's challenge record)"}</span>
        </dd>
        {SNAPSHOT_MODE ? null : (
          <>
            <dt className="text-muted">Relaying from</dt>
            <dd className="min-w-0">
              {connection.address ? (
                <Address
                  value={connection.address}
                  label="your wallet address"
                  note={sameAddress(connection.address, recipient) ? "you are the recipient" : "not the recipient - the reward still goes to the recipient"}
                />
              ) : (
                <span className="text-muted">no wallet connected</span>
              )}
            </dd>
          </>
        )}
        <dt className="text-muted">Settlement window</dt>
        <dd className="text-sm">
          <Countdown to={deadline} prefix="Closes in" expiredText="Closed" /> <span className="text-xs text-muted">(<DateTime ts={deadline} />)</span>
        </dd>
      </dl>

      {SNAPSHOT_MODE ? <ReadOnlyNote action="Relaying settle() to the contract" /> : null}
      {SNAPSHOT_MODE ? null : (
        <>
          {!connection.address ? <ConnectPrompt what="relay the settlement" /> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              icon={<Send />}
              onClick={onRelay}
              disabled={!connection.address || reasons.length > 0}
              busy={tx.isBusy}
              busyLabel={tx.state.status === "awaiting_signature" ? "Confirm in your wallet" : "Waiting for the receipt"}
            >
              Relay settle() on {txNetworkPhrase(chainId)}
            </Button>
            {tx.state.status !== "idle" && !tx.isBusy ? (
              <Button variant="ghost" size="sm" onClick={tx.reset}>
                Clear status
              </Button>
            ) : null}
          </div>
          <ReasonList reasons={reasons} />
          {argError ? (
            <p role="alert" className="text-sm font-medium text-bad">
              Could not build the settle arguments from the stored attestation: {argError}
            </p>
          ) : null}
          <TxStatus {...tx} label="Settlement" />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- withdraw
export interface WithdrawActionProps extends ChainTarget {
  view: ChallengeView;
  /** Whose credit this step is about: the recipient after a settlement, the publisher after a refund. */
  beneficiary: string;
  beneficiaryRole: "recipient" | "publisher";
}

/** Live credits from the contract and a `withdraw()` for the connected account. */
export function WithdrawAction({ view, beneficiary, beneficiaryRole, contract, chainId, network }: WithdrawActionProps) {
  const connection = useConnection();
  const beneficiaryAddr = toChecksumAddress(beneficiary) as ViemAddress | null;
  // The snapshot has no wallet: there is no "me".
  const me = SNAPSHOT_MODE ? undefined : connection.address;
  const meIsBeneficiary = sameAddress(me, beneficiary);
  const live = canReadChainLive(network);

  const beneficiaryCredits = useReadContract({
    address: contract ?? undefined,
    abi: counterProofAbi,
    functionName: "credits",
    args: beneficiaryAddr ? [beneficiaryAddr] : undefined,
    chainId,
    query: { enabled: live && !!contract && !!beneficiaryAddr && !!chainId },
  });
  const myCredits = useReadContract({
    address: contract ?? undefined,
    abi: counterProofAbi,
    functionName: "credits",
    args: me ? [me] : undefined,
    chainId,
    query: { enabled: live && !!contract && !!me && !!chainId && !meIsBeneficiary },
  });

  const tx = useTrackedTx({
    kind: "withdraw",
    challengeId: view.id,
    chainId,
    onConfirmed: () => {
      void beneficiaryCredits.refetch();
      void myCredits.refetch();
    },
  });

  const mine = meIsBeneficiary ? beneficiaryCredits.data : myCredits.data;
  const mineQuery = meIsBeneficiary ? beneficiaryCredits : myCredits;
  const canWithdraw = typeof mine === "bigint" && mine > BigInt(0);

  const onWithdraw = async () => {
    if (!contract) return;
    await tx.send({ address: contract, abi: counterProofAbi, functionName: "withdraw" });
  };

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr]">
        <dt className="text-muted">Credit of the {beneficiaryRole}</dt>
        <dd className="min-w-0 space-y-0.5">
          <Address value={beneficiary} label={beneficiaryRole} />
          <div className="text-sm">
            {!live ? (
              <span className="text-muted">
                Not read: {network === "anvil-local" ? "local anvil chain" : txNetworkPhrase(chainId)} - not reachable from this hosted
                snapshot; values below are as recorded.
              </span>
            ) : !contract || !chainId ? (
              <span className="text-muted">No contract to read.</span>
            ) : beneficiaryCredits.isPending ? (
              <span className="text-muted">Reading credits({beneficiaryRole}) from {txNetworkPhrase(chainId)}.</span>
            ) : beneficiaryCredits.isError ? (
              <span className="text-warn">
                Could not read credits from {txNetworkPhrase(chainId)}: {beneficiaryCredits.error.message.split("\n")[0]}
              </span>
            ) : (
              <>
                <span className="font-semibold tabular text-fg">{formatWei(beneficiaryCredits.data, network)}</span>{" "}
                <span className="text-xs text-muted">
                  {SNAPSHOT_MODE
                    ? "credits(), read live from the contract on Monad testnet by this page (now, not at snapshot time)"
                    : "credits(), read from the contract by this page"}
                </span>
              </>
            )}
          </div>
        </dd>
        {me && !meIsBeneficiary ? (
          <>
            <dt className="text-muted">Your credit</dt>
            <dd className="min-w-0 text-sm">
              {myCredits.isPending ? (
                <span className="text-muted">Reading your credits.</span>
              ) : myCredits.isError ? (
                <span className="text-warn">Could not read your credits: {myCredits.error.message.split("\n")[0]}</span>
              ) : (
                <span className="tabular">{formatWei(myCredits.data, network)}</span>
              )}
            </dd>
          </>
        ) : null}
      </dl>

      <p className="text-xs text-muted">
        Credits are pull payments per account, across all challenges in this contract. <span className="font-mono">withdraw()</span>{" "}
        sends the connected account&apos;s whole credit to that account; nobody can withdraw someone else&apos;s credit.
      </p>

      {SNAPSHOT_MODE ? (
        <ReadOnlyNote action="Withdrawing a credit" />
      ) : !me ? (
        <ConnectPrompt what={`withdraw (only the ${beneficiaryRole}'s own wallet can withdraw its credit)`} />
      ) : canWithdraw ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            icon={<ArrowDownToLine />}
            onClick={onWithdraw}
            busy={tx.isBusy}
            busyLabel={tx.state.status === "awaiting_signature" ? "Confirm in your wallet" : "Waiting for the receipt"}
          >
            Withdraw {formatWei(mine, network)}
          </Button>
          {tx.state.status !== "idle" && !tx.isBusy ? (
            <Button variant="ghost" size="sm" onClick={tx.reset}>
              Clear status
            </Button>
          ) : null}
        </div>
      ) : mineQuery.isSuccess ? (
        <p className="text-sm text-muted">The connected account has no credit to withdraw.</p>
      ) : null}
      {SNAPSHOT_MODE ? null : <TxStatus {...tx} label="Withdrawal" />}
    </div>
  );
}

// ---------------------------------------------------------------------------- refund
export interface RefundActionProps extends ChainTarget {
  view: ChallengeView;
  onchain: OnchainChallenge | null;
  nowSec: number | null;
}

/** `refund(id)` once the settlement deadline has passed without a settlement. Anyone may call it. */
export function RefundAction({ view, onchain, nowSec, contract, chainId, network }: RefundActionProps) {
  const connection = useConnection();
  const tx = useTrackedTx({ kind: "refund", challengeId: view.id, chainId });
  const deadline = onchain?.settlement_deadline ?? view.spec.deadlines.settlement_deadline;
  const open = nowSec !== null && nowSec > deadline;
  const publisher = onchain?.publisher ?? view.spec.publisher.address;
  const alreadySent = tx.state.status === "confirmed" || (tx.report.status === "verified" && "status" in tx.report.result && tx.report.result.status === "confirmed");

  const reasons: string[] = [];
  if (alreadySent) reasons.push("This refund transaction is confirmed; sending another would revert with AlreadyRefunded and still cost gas.");
  if (onchain && onchain.status !== "funded") reasons.push(`The contract reports this challenge as ${onchain.status}.`);
  if (!view.onchain_id) reasons.push("The challenge has no on-chain id.");
  if (!contract) reasons.push("No contract address is configured for this challenge.");
  if (!chainId) reasons.push("The challenge's network has no wallet chain.");

  const onRefund = async () => {
    if (!contract || !view.onchain_id) return;
    await tx.send({ address: contract, abi: counterProofAbi, functionName: "refund", args: [BigInt(view.onchain_id)] });
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        If nobody settles before the settlement deadline, anyone may call <span className="font-mono">refund()</span>. The
        reward ({formatWei(onchain?.reward_wei ?? view.reward_wei, network)}) returns to the publisher&apos;s credit (
        <Address value={publisher} label="publisher" />
        ), which the publisher then withdraws.
      </p>
      {!open && SNAPSHOT_MODE ? (
        <p className="text-sm">
          Refund was not open when recorded: settlement deadline <DateTime ts={deadline} />{" "}
          <span className="text-xs text-muted">
            (<Countdown to={deadline} />)
          </span>
        </p>
      ) : !open ? (
        <p className="text-sm">
          <Countdown to={deadline} prefix="Refund opens in" expiredText="Refund is open" />{" "}
          <span className="text-xs text-muted">
            (settlement deadline <DateTime ts={deadline} />)
          </span>
        </p>
      ) : SNAPSHOT_MODE ? (
        <ReadOnlyNote action="Sending refund() to the contract" />
      ) : (
        <>
          {!connection.address ? <ConnectPrompt what="send the refund" /> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              icon={<Undo2 />}
              onClick={onRefund}
              disabled={!connection.address || reasons.length > 0}
              busy={tx.isBusy}
              busyLabel={tx.state.status === "awaiting_signature" ? "Confirm in your wallet" : "Waiting for the receipt"}
            >
              Refund to publisher
            </Button>
            {tx.state.status !== "idle" && !tx.isBusy ? (
              <Button variant="ghost" size="sm" onClick={tx.reset}>
                Clear status
              </Button>
            ) : null}
          </div>
          <ReasonList reasons={reasons} />
        </>
      )}
      {SNAPSHOT_MODE ? null : <TxStatus {...tx} label="Refund" />}
    </div>
  );
}
