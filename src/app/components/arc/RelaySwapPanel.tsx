"use client";

/**
 * RelaySwapPanel — Bridge & Swap via Relay's SwapWidget (same-chain swaps and
 * cross-chain bridges, EVM + Solana). Execution happens inside the widget.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SwapWidget,
  type LinkedWallet,
  type Token,
} from "@relayprotocol/relay-kit-ui";
import {
  adaptViemWallet,
  type AdaptedWallet,
  type RelayChain,
} from "@relayprotocol/relay-sdk";
import { adaptSolanaWallet } from "@relayprotocol/relay-svm-wallet-adapter";
import { configureDynamicChains } from "@relayprotocol/relay-sdk/chain-utils";
import { useAccountModal, useConnectModal } from "@rainbow-me/rainbowkit";
import { useWalletClient } from "wagmi";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { SendOptions, VersionedTransaction } from "@solana/web3.js";
import toast from "react-hot-toast";
import { Icon } from "./icons";
import { clearPendingLaunch, loadPendingLaunch } from "./swapUrl";
import { getSolanaBalance } from "./solanaBalance";
import { getSolanaConnection, SOLANA_CHAIN_ID } from "@/config/solana";
import {
  DEFAULT_SETTLEMENT_CHAIN_ID,
  getChain,
  getToken,
  getTokenAddress,
  type ChainId,
  type TokenSymbol,
} from "@/config/network";

function relayToken(symbol: TokenSymbol, chainId: ChainId): Token | undefined {
  const chain = getChain(chainId);
  const entry = getToken(symbol);
  const address = getTokenAddress(symbol, chainId);
  if (!chain?.numericId || !entry || !address) return undefined;
  return {
    chainId: chain.numericId,
    address,
    name: entry.name,
    symbol: entry.symbol,
    decimals: entry.decimals,
    logoURI: "",
    verified: true,
  };
}

/**
 * Seed the widget with a sensible pair for the active network. `to` is only
 * set when a token distinct from `from` actually resolves on this chain —
 * otherwise we leave it undefined and let the widget prompt (e.g. WETH has no
 * testnet address, which would otherwise produce a USDC→USDC default).
 */
function defaultPair(): { from?: Token; to?: Token } {
  const chainId = DEFAULT_SETTLEMENT_CHAIN_ID;
  const from = relayToken("USDC", chainId);
  const to = relayToken("ETH", chainId) ?? relayToken("USDT", chainId);
  return { from, to: to?.address === from?.address ? undefined : to };
}

function pairFromLaunch(
  fromSymbol?: string,
  toSymbol?: string
): { from?: Token; to?: Token } {
  const chainId = DEFAULT_SETTLEMENT_CHAIN_ID;
  const defaults = defaultPair();
  const from = fromSymbol
    ? relayToken(fromSymbol as TokenSymbol, chainId)
    : undefined;
  const to = toSymbol
    ? relayToken(toSymbol as TokenSymbol, chainId)
    : undefined;
  const resolvedFrom = from ?? defaults.from;
  const resolvedTo =
    to && to.address !== resolvedFrom?.address ? to : defaults.to;
  return { from: resolvedFrom, to: resolvedTo };
}

export function RelaySwapPanel() {
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();
  const { data: walletClient } = useWalletClient();
  const connection = getSolanaConnection();
  const {
    publicKey,
    sendTransaction,
    wallet: solanaWalletAdapter,
  } = useWallet();
  const { setVisible: setSolanaModalVisible } = useWalletModal();

  const evmAddress = walletClient?.account?.address;
  const solanaAddress = publicKey?.toBase58();

  const [fromToken, setFromToken] = useState<Token | undefined>();
  const [toToken, setToToken] = useState<Token | undefined>();
  // Held back until the launch prefill is applied — the widget reads
  // defaultAmount only on first mount.
  const [defaultAmount, setDefaultAmount] = useState("10");
  const [ready, setReady] = useState(false);
  const [chainsReady, setChainsReady] = useState(false);

  // Relay signs from the Sell chain, so the active wallet follows the Sell token.
  const fromIsSolana = fromToken?.chainId === SOLANA_CHAIN_ID;

  // Connected wallets, shown in the per-side Sell/Buy selectors.
  const linkedWallets = useMemo<LinkedWallet[]>(() => {
    const list: LinkedWallet[] = [];
    if (evmAddress) {
      list.push({ address: evmAddress, vmType: "evm", connector: "evm" });
    }
    if (solanaAddress) {
      list.push({
        address: solanaAddress,
        vmType: "svm",
        connector: solanaWalletAdapter?.adapter.name ?? "Solana",
        walletLogoUrl: solanaWalletAdapter?.adapter.icon,
      });
    }
    return list;
  }, [evmAddress, solanaAddress, solanaWalletAdapter]);

  // The active signer for the current Sell chain (SVM adapter or viem).
  const wallet = useMemo<AdaptedWallet | undefined>(() => {
    if (fromIsSolana) {
      if (!publicKey) return undefined;
      const adapted = adaptSolanaWallet(
        publicKey.toBase58(),
        SOLANA_CHAIN_ID,
        connection,
        async (tx: VersionedTransaction, options?: SendOptions) => {
          const signature = await sendTransaction(tx, connection, options);
          return { signature };
        }
      );
      // The SVM adapter has no getBalance; read SOL/SPL balances from the RPC.
      return {
        ...adapted,
        getBalance: (_chainId, walletAddress, tokenAddress) =>
          getSolanaBalance(connection, walletAddress, tokenAddress),
      };
    }
    return walletClient ? adaptViemWallet(walletClient) : undefined;
  }, [fromIsSolana, publicKey, walletClient, connection, sendTransaction]);

  // Route the connect CTA to the modal matching the Sell chain's VM.
  const handleConnectWallet = useCallback(() => {
    if (fromIsSolana) setSolanaModalVisible(true);
    else openConnectModal?.();
  }, [fromIsSolana, openConnectModal, setSolanaModalVisible]);

  // Connect a wallet for the chain being linked. RainbowKit holds one EVM wallet
  // and disables openConnectModal once connected, so fall through to the Solana
  // modal (or the EVM account modal when both VMs are already linked).
  const handleLinkWallet = useCallback(
    (params?: { chain?: RelayChain; direction?: "to" | "from" }) => {
      if (params?.chain?.vmType === "svm") setSolanaModalVisible(true);
      else if (openConnectModal) openConnectModal();
      else if (!solanaAddress) setSolanaModalVisible(true);
      else openAccountModal?.();
    },
    [openConnectModal, openAccountModal, solanaAddress, setSolanaModalVisible]
  );

  // Pull Relay's full chain list onto the shared client so the widget matches
  // the live Relay app; fall back to the static config if the fetch fails.
  useEffect(() => {
    let active = true;
    configureDynamicChains()
      .catch(() => {})
      .finally(() => {
        if (active) setChainsReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const launch = loadPendingLaunch();
    const base = defaultPair();
    if (launch?.flow === "bridge") {
      const seeded = pairFromLaunch(launch.fromToken, launch.toToken);
      setFromToken(seeded.from ?? base.from);
      setToToken(seeded.to ?? base.to);
      if (launch.amount) setDefaultAmount(launch.amount);
      clearPendingLaunch();
    } else {
      setFromToken(base.from);
      setToToken(base.to);
    }
    setReady(true);
  }, []);

  return (
    <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
      <div className="col gap-4" style={{ width: "100%", maxWidth: 420 }}>
        <header className="col gap-1">
          <h1 style={{ fontSize: 28, lineHeight: 1.1, letterSpacing: "-0.02em", fontWeight: 500 }}>
            Bridge &amp; Swap
          </h1>
          <span className="muted" style={{ fontSize: 14 }}>
            Swap on one chain or bridge across — routed for the best price.
          </span>
        </header>

        {ready && chainsReady ? (
          <SwapWidget
            wallet={wallet}
            multiWalletSupportEnabled
            linkedWallets={linkedWallets}
            onLinkNewWallet={handleLinkWallet}
            fromToken={fromToken}
            setFromToken={setFromToken}
            toToken={toToken}
            setToToken={setToToken}
            defaultAmount={defaultAmount}
            supportedWalletVMs={["evm", "svm"]}
            onConnectWallet={handleConnectWallet}
            onSwapSuccess={() => {
              toast.success("Swap complete");
            }}
            onSwapError={(message, data) => {
              // The widget surfaces its own failure message; just log details.
              console.error("[relay] swap error:", message, data);
            }}
          />
        ) : (
          <div
            className="row center"
            style={{ minHeight: 360, justifyContent: "center", color: "var(--fg-mute)" }}
          >
            <Icon.Spinner size={18} />
          </div>
        )}
      </div>
    </div>
  );
}
