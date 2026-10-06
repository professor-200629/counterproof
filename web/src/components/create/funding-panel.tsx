"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Coins, RotateCcw, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { parseEther, type Hex } from "viem";
import { useBalance, useConnection, usePublicClient, useSwitchChain } from "wagmi";
import { WalletButton } from "@/components/shell/wallet-button";
import { LocalChainNotice, MonadReserveNotice, TxStatus } from "@/components/tx-status";
import { Address, Button, ButtonLink, Callout, Countdown, ReasonList, Stepper, TextLink, type StepItem, type StepState } from "@/components/ui";
import { counterProofAbi } from "@/lib/abi";
import { ApiError, api, type AppConfig, type ChallengeRow, type ChallengeSpec, type FundingResult } from "@/lib/api";
import { createChallengeArgs, formatWei, networkForChainId, toChecksumAddress, txNetworkPhrase } from "@/lib/chain";
import { sameHex } from "@/lib/format";
import { qk } from "@/lib/queries";
import { canSendAgain, errorReason, readSentTxHash, subscribeSentTxHash, useTrackedTx } from "@/lib/tx";
import { supportedChainIdFor } from "@/lib/wagmi";
import { useNow } from "@/components/ui/time";
import { decodeContractError, errorNameFromReason, explainCreateChallengeError } from "./contract-errors";

export interface CreatedChallenge {
  challenge: ChallengeRow;
  spec: ChallengeSpec;
  digest: string;
}

type Preflight =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok" }
  | { status: "skipped" }
  | { status: "revert"; name: string; args: readonly unknown[] }
  | { status: "unknown"; reason: string };

export interface FundingPanelProps {
  config: AppConfig;
  created: CreatedChallenge;
  /** Go back to editing (create wizard only). The unfunded challenge row stays in the backend. */
  onDiscard?: () => void;
  /**
   * Rendered on the challenge's own pages (settlement) rather than at the end of the create
   * wizard: no redirect after verification (the page refreshes from the backend) and no
   * "open challenge" link.
   */
  inPlace?: boolean;
}

/**
 * Funding: createChallenge(specDigest, evaluator, submissionDeadline, settlementDeadline)
 * with value = reward, from the publisher bound in the spec. The hash goes to the backend,
 * which reads the receipt and the ChallengeCreated event from the chain itself.
 */
export function FundingPanel({ config, created, onDiscard, inPlace = false }: FundingPanelProps) {
  const router = useRouter();
  const qc = useQueryClient();
  const connection = useConnection();
  const switchChain = useSwitchChain();
  const { challenge, spec, digest } = created;

  const network = networkForChainId(spec.settlement?.chain_id);
  const chainId = supportedChainIdFor(network);
  const contract = spec.settlement ? toChecksumAddress(spec.settlement.contract) : null;
  const account = connection.status === "connected" ? connection.address : undefined;

  const tx = useTrackedTx({ kind: "fund", challengeId: challenge.id, chainId });
  const publicClient = usePublicClient({ chainId });
  const balance = useBalance({ address: account, chainId, query: { enabled: !!account && chainId !== undefined } });
  const now = useNow(5_000);
  const [preflight, setPreflight] = useState<Preflight>({ status: "idle" });

  const verifyAgain = useMutation({
    mutationFn: (hash: Hex) => api.recordFunding(challenge.id, { tx_hash: hash }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.challenge(challenge.id) });
      void qc.invalidateQueries({ queryKey: qk.challenges });
      void qc.invalidateQueries({ queryKey: qk.overview });
    },
  });

  const reportVerified =
    tx.report.status === "verified" && "onchain_id" in tx.report.result ? (tx.report.result as FundingResult) : null;
  const verified: FundingResult | null = reportVerified ?? verifyAgain.data ?? null;

  useEffect(() => {
    if (verified && !inPlace) router.push(`/challenges/${challenge.id}`);
  }, [verified, inPlace, router, challenge.id]);

  // ------------------------------------------------------------------ checks (all from real state)
  const reward = BigInt(spec.reward.amount_wei);
  const reserve = network === "monad-testnet" ? parseEther("10") : BigInt(0);
  const accountMatches = sameHex(account, spec.publisher.address) === true;
  const wrongChain = connection.status === "connected" && chainId !== undefined && connection.chainId !== chainId;
  const nowSec = now === null ? null : Math.floor(now / 1000);
  const deadlinePassed = nowSec !== null && spec.deadlines.submission_deadline <= nowSec + 30;
  const contractDiffers = sameHex(config.chain.contract, contract) === false;
  const lowBalance = balance.data ? balance.data.value < reward + reserve : false;

  const blockers: string[] = [];
  if (!contract || chainId === undefined) blockers.push("The spec has no on-chain settlement terms.");
  if (config.chain.contract_has_code === false) blockers.push("No contract code at the configured address on this chain.");
  if (contractDiffers) blockers.push("The backend's contract differs from the one in this spec.");
  if (!account) blockers.push("Connect the publisher's wallet.");
  else if (!accountMatches) blockers.push(`Switch your wallet to the publisher account ${spec.publisher.address}.`);
  if (deadlinePassed) blockers.push("The submission deadline has passed or is less than 30 s away; the contract would revert.");

  const state = tx.state;
  const failure = state.status === "failed" ? state.failure : null;
  const reverted = failure === "reverted";
  const receiptUnknown = failure === "receipt_unknown";
  const notExecuted = failure === "cancelled" || failure === "replaced";
  const sendError = failure === "not_sent" && state.status === "failed" ? state.reason : null;
  const sendErrorName = errorNameFromReason(sendError);
  const backendError = tx.report.status === "error" ? tx.report.error : null;
  // Sending again is safe only when no transaction of ours can still escrow the reward.
  const canResend = canSendAgain(state);
  const canDiscard = !!onDiscard && !tx.isBusy && state.status !== "confirmed" && !receiptUnknown && !verified;

  const handleFund = async () => {
    if (!contract || !account || blockers.length > 0) return;
    const { args, value } = createChallengeArgs(spec, digest);
    if (publicClient) {
      setPreflight({ status: "checking" });
      try {
        await publicClient.simulateContract({
          address: contract,
          abi: counterProofAbi,
          functionName: "createChallenge",
          args,
          value,
          account,
        });
        setPreflight({ status: "ok" });
      } catch (e) {
        const decoded = decodeContractError(e);
        if (decoded) {
          setPreflight({ status: "revert", name: decoded.name, args: decoded.args });
          return;
        }
        setPreflight({ status: "unknown", reason: errorReason(e) });
      }
    } else {
      setPreflight({ status: "skipped" });
    }
    await tx.send({ address: contract, abi: counterProofAbi, functionName: "createChallenge", args, value });
  };

  // ------------------------------------------------------------------ progress (from real events only)
  const fundState: StepState =
    state.status === "confirmed" ? "complete" : state.status === "failed" || state.status === "rejected" ? "error" : "current";
  const verifyState: StepState = verified
    ? "complete"
    : tx.report.status === "error" || verifyAgain.isError
      ? "error"
      : tx.report.status === "reporting" || verifyAgain.isPending
        ? "current"
        : "upcoming";
  const steps: StepItem[] = [
    {
      id: "stored",
      label: "Spec stored, challenge created",
      description: `Backend challenge #${challenge.id}, status awaiting funding`,
      state: "complete",
    },
    {
      id: "fund",
      label: `Fund on ${txNetworkPhrase(chainId)}`,
      description: "Your wallet signs createChallenge with the reward as value",
      state: fundState,
    },
    {
      id: "verify",
      label: "Backend verifies the receipt",
      description: "Reads ChallengeCreated from the chain and checks it against the spec",
      state: verifyState,
    },
    inPlace
      ? { id: "open", label: "Search runs and submissions open", state: verified ? "complete" : "upcoming" }
      : { id: "open", label: "Open the challenge", state: verified ? "current" : "upcoming" },
  ];

  return (
    <div className="space-y-4">
      <Stepper steps={steps} label="Publishing progress" orientation="vertical" />

      <MonadReserveNotice network={network} />
      <LocalChainNotice network={network} />

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-line bg-surface p-4 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]">
        <dt className="text-muted">Contract</dt>
        <dd className="min-w-0">
          <Address value={contract} label="contract address" full />
        </dd>
        <dt className="text-muted">Value</dt>
        <dd className="font-mono text-xs text-fg">
          {formatWei(reward, network)} ({spec.reward.amount_wei} wei)
        </dd>
        <dt className="text-muted">Publisher (must send)</dt>
        <dd className="min-w-0">
          <Address value={spec.publisher.address} label="publisher address" full />
        </dd>
        <dt className="text-muted">Connected wallet</dt>
        <dd className="min-w-0">
          {account ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <Address value={account} label="connected address" full />
              <span className={accountMatches ? "text-xs text-ok" : "text-xs text-bad"}>
                {accountMatches ? "matches the publisher" : "not the publisher"}
              </span>
            </span>
          ) : (
            <WalletButton className="items-start justify-start" />
          )}
        </dd>
        {account ? (
          <>
            <dt className="text-muted">Wallet network</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span className={wrongChain ? "text-warn" : "text-fg"}>{txNetworkPhrase(connection.chainId)}</span>
              {wrongChain && chainId !== undefined ? (
                <Button
                  size="sm"
                  variant="secondary"
                  busy={switchChain.isPending}
                  busyLabel="Confirm in wallet"
                  onClick={() => switchChain.mutate({ chainId })}
                >
                  Switch to {txNetworkPhrase(chainId)}
                </Button>
              ) : null}
            </dd>
            <dt className="text-muted">Balance</dt>
            <dd className="text-fg">
              {balance.data ? (
                <span className={lowBalance ? "text-warn" : undefined}>
                  {formatWei(balance.data.value, network)} on {txNetworkPhrase(chainId)}
                </span>
              ) : balance.isError ? (
                <span className="text-muted">could not be read: {errorReason(balance.error)}</span>
              ) : (
                <span className="text-subtle">reading from the chain</span>
              )}
            </dd>
          </>
        ) : null}
        <dt className="text-muted">Submissions close</dt>
        <dd>
          <Countdown to={spec.deadlines.submission_deadline} prefix="in" />
        </dd>
      </dl>

      {lowBalance && balance.data ? (
        <Callout tone="warn" icon={<TriangleAlert />} title="Balance may be too low">
          {network === "monad-testnet"
            ? `Sending ${formatWei(reward, network)} would leave less than the 10 MON reserve (plus gas). Monad reverts such a transaction and still bills the gas limit.`
            : `The balance is below the reward of ${formatWei(reward, network)} plus gas.`}
        </Callout>
      ) : null}

      {preflight.status === "revert" ? (
        <Callout tone="bad" icon={<CircleAlert />} title={`Pre-flight check: the contract would revert (${preflight.name})`} role="alert">
          {explainCreateChallengeError(preflight.name, preflight.args)} Nothing was sent to your wallet.
        </Callout>
      ) : null}
      {preflight.status === "unknown" ? (
        <Callout tone="warn" icon={<TriangleAlert />} title="Pre-flight check could not run">
          eth_call on {txNetworkPhrase(chainId)} failed: {preflight.reason}. The request went to your wallet anyway; it runs its own
          estimate.
        </Callout>
      ) : null}

      <TxStatus {...tx} label="Funding" />

      {sendErrorName ? (
        <Callout tone="bad" icon={<CircleAlert />} title={`Contract error: ${sendErrorName}`} role="alert">
          {explainCreateChallengeError(sendErrorName)}
        </Callout>
      ) : null}
      {reverted ? (
        <Callout tone="bad" icon={<CircleAlert />} title="Reverted on chain - no reward escrowed" role="alert">
          The transaction was mined but reverted, so nothing is held by the contract.
          {network === "monad-testnet" ? " On Monad testnet this also happens when the balance would end below the 10 MON reserve." : ""}
        </Callout>
      ) : null}
      {notExecuted ? (
        <Callout tone="neutral" icon={<CircleAlert />} title="Not executed - no reward escrowed">
          The wallet replaced this transaction on the same nonce, so createChallenge never ran and nothing is held by the contract.
          You can fund again.
        </Callout>
      ) : null}
      {receiptUnknown ? (
        <Callout tone="warn" icon={<TriangleAlert />} title="Do not send again yet">
          The transaction has a hash but its receipt could not be read. It may still be mined; sending again could fund a
          second on-chain challenge. Ask the backend to check the hash instead.
        </Callout>
      ) : null}
      {backendError && state.status === "confirmed" ? (
        <Callout tone="bad" icon={<CircleAlert />} title="Mined, but the backend could not verify it" role="alert">
          {backendError} The challenge stays &quot;awaiting funding&quot; until verification succeeds.
        </Callout>
      ) : null}
      {verifyAgain.isError ? (
        <Callout tone="bad" icon={<CircleAlert />} title="Verification failed again" role="alert">
          {verifyAgain.error instanceof ApiError ? verifyAgain.error.detail : errorReason(verifyAgain.error)}
        </Callout>
      ) : null}
      {verified ? (
        <Callout tone="ok" icon={<Coins />} title="Funding verified from the chain" role="status">
          On-chain challenge #{verified.onchain_id}, block {verified.block}.{" "}
          {inPlace ? "This page refreshes from the backend." : `Opening backend challenge #${challenge.id}...`}
        </Callout>
      ) : null}

      <ReasonList reasons={verified || tx.isBusy || state.status === "confirmed" ? [] : blockers} />

      <div className="flex flex-wrap items-center gap-2">
        {(canResend || tx.isBusy) && !verified ? (
          <Button
            variant="primary"
            icon={state.status === "idle" ? <Coins /> : <RotateCcw />}
            onClick={() => void handleFund()}
            disabled={blockers.length > 0}
            busy={preflight.status === "checking" || tx.isBusy}
            busyLabel={
              preflight.status === "checking"
                ? "Running pre-flight check"
                : state.status === "pending"
                  ? "Waiting for the receipt"
                  : "Confirm in your wallet"
            }
          >
            {state.status === "idle" ? `Fund ${formatWei(reward, network)}` : "Try funding again"}
          </Button>
        ) : null}
        {(receiptUnknown || (state.status === "confirmed" && (backendError || verifyAgain.isError))) && tx.hash && !verified ? (
          <Button
            variant="primary"
            icon={<RotateCcw />}
            busy={verifyAgain.isPending}
            busyLabel="Backend is reading the chain"
            onClick={() => tx.hash && verifyAgain.mutate(tx.hash)}
          >
            Ask the backend to verify the hash again
          </Button>
        ) : null}
        {inPlace || tx.isBusy ? null : (
          <ButtonLink href={`/challenges/${challenge.id}`} variant="secondary">
            Open challenge #{challenge.id}
          </ButtonLink>
        )}
        {canDiscard ? (
          <Button variant="ghost" onClick={onDiscard}>
            Discard and edit the terms
          </Button>
        ) : null}
      </div>
      {!verified && !tx.isBusy ? (
        <VerifySentHash
          challengeId={challenge.id}
          busy={verifyAgain.isPending}
          onVerify={(hash) => verifyAgain.mutate(hash)}
        />
      ) : null}
      {canDiscard ? (
        <p className="text-xs text-muted">
          Discarding returns to the form. Challenge #{challenge.id} stays in the backend as &quot;awaiting funding&quot;; no funds
          have moved. It can still be funded later from its{" "}
          <TextLink href={`/challenges/${challenge.id}/settlement#step-funded`}>Settlement page</TextLink>.
        </p>
      ) : null}
    </div>
  );
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * For a funding transaction that was sent but never reached the backend (another tab, a
 * closed page, a wallet that sent it later): hand its hash to the backend, which reads the
 * receipt and the ChallengeCreated event from the chain. Prefilled with a hash this browser
 * sent and the backend has not verified yet.
 */
function VerifySentHash({ challengeId, busy, onVerify }: { challengeId: number; busy: boolean; onVerify: (hash: Hex) => void }) {
  const id = useId();
  const remembered = useSyncExternalStore(
    subscribeSentTxHash,
    () => readSentTxHash(challengeId, "fund"),
    () => null,
  );
  const [typed, setTyped] = useState<string | null>(null);
  const value = typed ?? remembered ?? "";
  const valid = TX_HASH_RE.test(value.trim());
  return (
    <details className="rounded-md border border-line bg-surface" open={remembered !== null || undefined}>
      <summary className="cursor-pointer rounded-md px-3 py-2 text-sm text-fg hover:bg-raised/60">
        Already sent a funding transaction? Verify its hash
      </summary>
      <form
        className="space-y-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onVerify(value.trim() as Hex);
        }}
      >
        <label htmlFor={id} className="block text-sm font-medium text-fg">
          Funding transaction hash
        </label>
        <input
          id={id}
          value={value}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="0x..."
          spellCheck={false}
          autoComplete="off"
          aria-describedby={`${id}-hint`}
          aria-invalid={value !== "" && !valid ? true : undefined}
          className="block h-9 w-full min-w-0 rounded-md border border-control bg-inset px-3 font-mono text-xs text-fg placeholder:text-subtle hover:border-control-strong focus-visible:border-accent aria-[invalid=true]:border-bad-line"
        />
        <p id={`${id}-hint`} className="text-xs text-muted">
          {remembered && typed === null
            ? "This browser sent this hash and the backend has not verified it yet. "
            : ""}
          The backend reads the receipt from the chain and checks the ChallengeCreated event against this spec; nothing typed here is
          trusted. Use this instead of funding again: a second createChallenge would escrow a second reward.
        </p>
        <Button type="submit" size="sm" variant="secondary" disabled={!valid} busy={busy} busyLabel="Backend is reading the chain">
          Verify this hash
        </Button>
      </form>
    </details>
  );
}
