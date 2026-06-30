"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { RelayKitProvider } from "@relayprotocol/relay-kit-ui";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { Adapter } from "@solana/wallet-adapter-base";
import "@relayprotocol/relay-kit-ui/styles.css";
import "@rainbow-me/rainbowkit/styles.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import { RELAY_API, RELAY_CHAINS, RELAY_THEME } from "@/config/relay";
import { SOLANA_RPC } from "@/config/solana";
import { createSolanaWalletAdapters } from "@/config/solanaWallets";
import { relayAppFees } from "@/config/fees";
import config from "./rainbowKitConfig";
import { rainbowKitTheme } from "./rainbowKitConfig";
import { Analytics } from "@vercel/analytics/next";

export function Providers(props: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const solanaWallets = useMemo<Adapter[]>(
    () => createSolanaWalletAdapters(),
    []
  );

  return (
    <WagmiProvider config={config}>
      <Analytics />
      <QueryClientProvider client={queryClient}>
        <ConnectionProvider endpoint={SOLANA_RPC}>
          <WalletProvider wallets={solanaWallets} autoConnect>
            <WalletModalProvider>
              <RelayKitProvider
                theme={RELAY_THEME}
                options={{
                  appName: "Railglide",
                  chains: RELAY_CHAINS,
                  baseApiUrl: RELAY_API,
                  themeScheme: "light",
                  appFees: relayAppFees(),
                }}
              >
                <RainbowKitProvider
                  showRecentTransactions
                  theme={rainbowKitTheme}
                >
                  {props.children}
                </RainbowKitProvider>
              </RelayKitProvider>
            </WalletModalProvider>
          </WalletProvider>
        </ConnectionProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
