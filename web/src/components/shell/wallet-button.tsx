"use client";

import { ChevronDown, LogOut, TriangleAlert, Wallet } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/cn";
import { chainIdForNetwork, txNetworkPhrase } from "@/lib/chain";
import { shortAddress } from "@/lib/format";
import { useConfig } from "@/lib/queries";
import { errorReason, isUserRejection } from "@/lib/tx-machine";
import { DEV_WALLET_LABEL, connectorLabel, type SupportedChainId } from "@/lib/wagmi";

/**
 * Warnings about the connected wallet in visible text that never truncates: the anvil dev
 * account label and, on small screens, which network the wallet must switch to. The header
 * renders this in its own full-width row; elsewhere WalletButton shows them inline.
 */
export function WalletNotices({ className }: { className?: string }) {
  const connection = useConnection();
  const { data: config } = useConfig();
  if (connection.status !== "connected") return null;
  const targetChainId = chainIdForNetwork(config?.network) as SupportedChainId | null;
  const isMock = connection.connector.type === "mock";
  const wrongChain = targetChainId !== null && connection.chainId !== targetChainId;
  if (!isMock && !wrongChain) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", isMock ? null : "sm:hidden", className)}>
      {isMock ? <DevAccountWarning /> : null}
      {wrongChain ? (
        <p className="text-xs text-warn sm:hidden">
          Wallet is on {txNetworkPhrase(connection.chainId)}; the backend uses {txNetworkPhrase(targetChainId)}.
        </p>
      ) : null}
    </div>
  );
}

/** The mandatory dev-account label: large badge, wraps instead of truncating. */
function DevAccountWarning() {
  return (
    <Badge tone="warn" size="lg" icon={<TriangleAlert />}>
      {DEV_WALLET_LABEL}
    </Badge>
  );
}

/**
 * Connect / account control.
 * - Lists available connectors: the browser wallet, plus the anvil dev account only when
 *   NEXT_PUBLIC_DEV_WALLET=1 and the backend runs on local anvil, always labelled as such.
 * - Warns and offers a switch when the wallet is on a different chain than the backend.
 * - `notices="separate"` (the header) leaves the warnings to WalletNotices.
 */
export function WalletButton({ className, notices = "inline" }: { className?: string; notices?: "inline" | "separate" }) {
  const connection = useConnection();
  const allConnectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const { data: config } = useConfig();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);

  const targetChainId = chainIdForNetwork(config?.network) as SupportedChainId | null;
  // The anvil dev accounts exist only on the local chain; on Monad they could only fail.
  const connectors = allConnectors.filter((c) => c.type !== "mock" || config?.network === "anvil-local");

  // Disclosure pattern: focus moves into the list on open and back to the trigger on Escape.
  useEffect(() => {
    if (!open) return;
    firstOptionRef.current?.focus();
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const connectError = connect.error && !isUserRejection(connect.error) ? errorReason(connect.error) : null;

  if (connection.status === "connected") {
    const isMock = connection.connector.type === "mock";
    const wrongChain = targetChainId !== null && connection.chainId !== targetChainId;
    const where = `Wallet is on ${txNetworkPhrase(connection.chainId)}; the backend uses ${txNetworkPhrase(targetChainId)}.`;
    return (
      <div className={cn("flex min-w-0 flex-wrap items-center justify-end gap-1.5", className)}>
        {isMock && notices === "inline" ? <DevAccountWarning /> : null}
        {wrongChain ? (
          <Button
            size="sm"
            variant="secondary"
            className="border-warn-line text-warn"
            busy={switchChain.isPending}
            busyLabel="Confirm in wallet"
            onClick={() => switchChain.mutate({ chainId: targetChainId })}
            title={where}
          >
            <span className="sm:hidden">Switch network</span>
            <span className="hidden sm:inline">Wrong network: switch to {txNetworkPhrase(targetChainId)}</span>
          </Button>
        ) : null}
        {wrongChain && notices === "inline" ? <span className="basis-full text-right text-xs text-warn sm:hidden">{where}</span> : null}
        <span
          className="inline-flex h-8 items-center gap-1 rounded-md border border-line bg-raised pl-2.5 pr-1 font-mono text-xs text-fg"
          title={`${connection.address} via ${connectorLabel(connection.connector)} on ${txNetworkPhrase(connection.chainId)}`}
        >
          <Wallet aria-hidden="true" className="size-3.5 text-muted" />
          <span className="sr-only">Connected account </span>
          {shortAddress(connection.address)}
          <CopyButton value={connection.address} label="connected address" />
        </span>
        <Button size="sm" variant="ghost" icon={<LogOut />} onClick={() => {
            // Forget the dev account so it does not reconnect on the next page load.
            try {
              window.localStorage.removeItem("wagmi.recentConnectorId");
            } catch {
              /* storage unavailable: nothing to forget */
            }
            disconnect.mutate({});
          }} aria-label="Disconnect wallet">
          <span className="hidden sm:inline">Disconnect</span>
        </Button>
      </div>
    );
  }

  const busy = connection.status === "connecting" || connection.status === "reconnecting" || connect.isPending;
  const doConnect = (connectorUid: string) => {
    const connector = connectors.find((c) => c.uid === connectorUid);
    if (!connector) return;
    setOpen(false);
    connect.mutate({ connector, ...(targetChainId ? { chainId: targetChainId } : {}) });
  };

  return (
    <div ref={wrapRef} className={cn("relative flex flex-col items-end", className)}>
      {connectors.length <= 1 ? (
        <Button
          size="sm"
          variant="primary"
          icon={<Wallet />}
          busy={busy}
          busyLabel="Connecting"
          disabled={connectors.length === 0}
          onClick={() => connectors[0] && doConnect(connectors[0].uid)}
        >
          Connect wallet
        </Button>
      ) : (
        <>
          <Button
            ref={triggerRef}
            size="sm"
            variant="primary"
            icon={<Wallet />}
            busy={busy}
            busyLabel="Connecting"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen((o) => !o)}
          >
            Connect wallet
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </Button>
          {open ? (
            <div
              id={menuId}
              className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-line bg-surface p-1 shadow-lg"
            >
              <ul className="space-y-0.5" aria-label="Wallet connectors">
                {connectors.map((c, i) => (
                  <li key={c.uid}>
                    <button
                      ref={i === 0 ? firstOptionRef : undefined}
                      type="button"
                      onClick={() => doConnect(c.uid)}
                      className="flex w-full flex-col items-start rounded-md px-3 py-2 text-left text-sm hover:bg-raised"
                    >
                      <span className={cn("font-medium", c.type === "mock" ? "text-warn" : "text-fg")}>{connectorLabel(c)}</span>
                      {c.type === "mock" ? (
                        <span className="text-xs text-muted">Public anvil keys, local chain 31337 only.</span>
                      ) : (
                        <span className="text-xs text-muted">Injected browser wallet (e.g. MetaMask, Rabby).</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      {connectError ? (
        <p role="alert" className="mt-1 max-w-xs text-right text-xs text-bad">
          {/provider not found/i.test(connectError) ? "No browser wallet found. Install one or enable it for this site." : connectError}
        </p>
      ) : null}
    </div>
  );
}
