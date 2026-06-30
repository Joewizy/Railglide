import {
  Connection,
  clusterApiUrl,
  type SignatureResult,
  type TransactionConfirmationStrategy,
} from "@solana/web3.js";
import { getChain, IS_MAINNET } from "./network";

/**
 * RPC for Solana balance reads and transaction sending. The official
 * api.mainnet-beta endpoint 403s browser traffic, so the mainnet fallback is a
 * CORS-friendly public node — override with NEXT_PUBLIC_SOLANA_RPC in prod.
 */
export const SOLANA_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC ||
  (IS_MAINNET
    ? "https://solana-rpc.publicnode.com"
    : clusterApiUrl("devnet"));

/** Relay's numeric chain id for the active Solana cluster (see network.ts). */
export const SOLANA_CHAIN_ID =
  getChain(IS_MAINNET ? "solana" : "solana-devnet")?.numericId ?? 792703809;

let connection: Connection | undefined;

/**
 * Shared Connection for balances, sending, and confirmation.
 *
 * The Relay SVM adapter confirms via `connection.confirmTransaction`, which
 * relies on a WebSocket `signatureSubscribe`. Public HTTP RPCs lack a usable WS,
 * so it hangs until block-height expiry and falsely fails a successful swap — so
 * we confirm by polling `getSignatureStatuses` over HTTP instead.
 */
export function getSolanaConnection(): Connection {
  if (connection) return connection;
  const conn = new Connection(SOLANA_RPC, "confirmed");

  const pollConfirm = async (
    strategy: TransactionConfirmationStrategy | string
  ): Promise<{ context: { slot: number }; value: SignatureResult }> => {
    const signature =
      typeof strategy === "string" ? strategy : strategy.signature;
    const deadline = Date.now() + 90_000;
    let slot = 0;
    while (Date.now() < deadline) {
      const { context, value } = await conn.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      slot = context.slot;
      const status = value[0];
      if (status) {
        if (status.err) {
          return { context: { slot: status.slot ?? slot }, value: { err: status.err } };
        }
        if (
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized"
        ) {
          return { context: { slot: status.slot ?? slot }, value: { err: null } };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return { context: { slot }, value: { err: "confirmation-timeout" } };
  };

  // Replace the WS-based confirmation with HTTP polling.
  conn.confirmTransaction = pollConfirm as Connection["confirmTransaction"];
  connection = conn;
  return conn;
}
