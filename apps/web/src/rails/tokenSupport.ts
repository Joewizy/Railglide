/**
 * Which stablecoins each provider supports on each chain.
 *
 * /api/tokens fetches this live from Paycrest (/v1/tokens) and ChainRails
 * (/chains/{chain}/tokens). The tables below are the fallback when a provider
 * errors or rate-limits — copied from those same endpoints on 2026-10-27.
 *
 * This only says WHICH tokens are supported. The token contract addresses we
 * send to stay in packages/shared/src/network.ts and are never fetched.
 */

export type Stablecoin = "USDC" | "USDT";

/** Paycrest network slug → tokens, e.g. { base: ["USDC", "USDT"] }. */
export type PaycrestTokenMap = Record<string, Stablecoin[]>;
/** ChainRails chain enum → tokens, e.g. { TRON_MAINNET: ["USDT"] }. */
export type ChainrailsTokenMap = Record<string, Stablecoin[]>;

export type TokenSupport = {
  paycrest: PaycrestTokenMap;
  chainrails: ChainrailsTokenMap;
};

export const PAYCREST_TOKENS_FALLBACK: PaycrestTokenMap = {
  ethereum: ["USDC", "USDT"],
  base: ["USDC", "USDT"],
  "arbitrum-one": ["USDC", "USDT"],
  polygon: ["USDC", "USDT"],
  "bnb-smart-chain": ["USDC", "USDT"],
  celo: ["USDC", "USDT"],
  starknet: ["USDC", "USDT"],
  solana: ["USDC", "USDT"],
  tron: ["USDT"],
};

// Monad and HyperEVM list USDT0, not USDT, so they count as USDC-only here.
export const CHAINRAILS_TOKENS_FALLBACK: ChainrailsTokenMap = {
  ETHEREUM_MAINNET: ["USDC", "USDT"],
  ARBITRUM_MAINNET: ["USDC", "USDT"],
  AVALANCHE_MAINNET: ["USDC", "USDT"],
  BASE_MAINNET: ["USDC"],
  STARKNET_MAINNET: ["USDC", "USDT"],
  OPTIMISM_MAINNET: ["USDC", "USDT"],
  MONAD_MAINNET: ["USDC"],
  SOLANA_MAINNET: ["USDC"],
  BSC_MAINNET: ["USDC", "USDT"],
  POLYGON_MAINNET: ["USDC", "USDT"],
  HYPEREVM_MAINNET: ["USDC"],
  TRON_MAINNET: ["USDT"],
};

/** The ChainRails chains we ask about (the keys above). */
export const CHAINRAILS_TOKEN_CHAINS = Object.keys(CHAINRAILS_TOKENS_FALLBACK);

export const TOKEN_SUPPORT_FALLBACK: TokenSupport = {
  paycrest: PAYCREST_TOKENS_FALLBACK,
  chainrails: CHAINRAILS_TOKENS_FALLBACK,
};

/** Keep only USDC / USDT from a provider's symbol list. */
export function onlyStablecoins(symbols: string[]): Stablecoin[] {
  return [...new Set(symbols)].filter(
    (s): s is Stablecoin => s === "USDC" || s === "USDT"
  );
}
