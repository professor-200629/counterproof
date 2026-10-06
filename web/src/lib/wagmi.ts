/**
 * wagmi configuration.
 *
 * Chains: Monad Testnet (10143, explorer overridden to testnet.monadscan.com) and the
 * local anvil chain (31337, viem's `foundry`, no explorer).
 * Connectors: the browser's injected wallet; plus, only when NEXT_PUBLIC_DEV_WALLET=1,
 * a mock connector holding anvil's public dev accounts for local demos.
 */
import { createConfig, http } from "wagmi";
import { injected, mock } from "wagmi/connectors";
import { foundry, monadTestnet as viemMonadTestnet } from "viem/chains";
import { defineChain, type Address, type Chain } from "viem";

/** viem's Monad testnet with the explorer replaced by MonadScan. */
export const monadTestnet = {
  ...viemMonadTestnet,
  blockExplorers: {
    default: { name: "MonadScan", url: "https://testnet.monadscan.com" },
  },
} as const satisfies Chain;

/** RPC of the local anvil chain (NEXT_PUBLIC_ANVIL_RPC_URL, default http://127.0.0.1:8545). */
export const ANVIL_RPC_URL = process.env.NEXT_PUBLIC_ANVIL_RPC_URL || "http://127.0.0.1:8545";

/**
 * Local anvil chain. Not Monad. No explorer. The RPC override lives in the chain itself, so
 * reads, the dev-account (mock) connector's sends and wallet_addEthereumChain all reach the
 * same node.
 */
export const anvilLocal = defineChain({
  ...foundry,
  rpcUrls: { default: { http: [ANVIL_RPC_URL] } },
});

export const DEV_WALLET_ENABLED = process.env.NEXT_PUBLIC_DEV_WALLET === "1";

/** Anvil's well-known public dev accounts (keys are public; never fund them on a real network). */
export const ANVIL_DEV_ACCOUNTS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
] as const satisfies readonly [Address, ...Address[]];

export const DEV_WALLET_LABEL = "Local dev account (anvil) - never use on testnet";

/** True when this browser last connected with the dev account (wagmi's recentConnectorId).
 *  Only then does the mock connector reconnect after a full page load; a first visit is
 *  never auto-connected. */
function devWalletWasLastUsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return JSON.parse(window.localStorage.getItem("wagmi.recentConnectorId") ?? "null") === "mock";
  } catch {
    return false;
  }
}

const connectors = DEV_WALLET_ENABLED
  ? [injected(), mock({ accounts: ANVIL_DEV_ACCOUNTS, features: { reconnect: true, defaultConnected: devWalletWasLastUsed() } })]
  : [injected()];

export const wagmiConfig = createConfig({
  ssr: true,
  // The dev account (local mode only) reconnects to the first chain, so anvil goes first there;
  // everywhere else Monad testnet is the default.
  chains: DEV_WALLET_ENABLED ? [anvilLocal, monadTestnet] : [monadTestnet, anvilLocal],
  connectors,
  transports: {
    [monadTestnet.id]: http(),
    [anvilLocal.id]: http(ANVIL_RPC_URL),
  },
});

export type SupportedChainId = (typeof wagmiConfig)["chains"][number]["id"];

/** Wallet chain for the backend's network (10143 / 31337); undefined when off-chain or unknown. */
export function supportedChainIdFor(network: string | null | undefined): SupportedChainId | undefined {
  if (network === "monad-testnet") return monadTestnet.id;
  if (network === "anvil-local") return anvilLocal.id;
  return undefined;
}

/** Human label for a connector; the mock connector always carries the dev-account warning. */
export function connectorLabel(connector: { type: string; name: string } | null | undefined): string {
  if (!connector) return "No wallet";
  if (connector.type === "mock") return DEV_WALLET_LABEL;
  return connector.name || "Browser wallet";
}

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
