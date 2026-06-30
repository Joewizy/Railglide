import {
  WalletAdapterNetwork,
  type Adapter,
} from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { IS_MAINNET } from "./network";

const network = IS_MAINNET
  ? WalletAdapterNetwork.Mainnet
  : WalletAdapterNetwork.Devnet;

/** Wallet adapters shown by the Solana wallet modal. */
export function createSolanaWalletAdapters(): Adapter[] {
  return [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network })];
}
