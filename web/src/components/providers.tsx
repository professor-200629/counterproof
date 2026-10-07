"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { makeQueryClient } from "@/lib/queries";
import { SNAPSHOT_MODE } from "@/lib/snapshot";
import { wagmiConfig } from "@/lib/wagmi";

/**
 * WagmiProvider + QueryClientProvider. One QueryClient per browser session. The read-only
 * snapshot never reconnects a wallet (it has no wallet controls at all).
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount={!SNAPSHOT_MODE}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
