/**
 * Chainrails rail — chain-name mapping + shared types.
 *
 * Chainrails identifies chains with its own `{CHAIN}_{TESTNET|MAINNET}`
 * enum. The testnet names are verified via `crapi.chains.getSupported`
 * (see scripts/test-chainrails.mjs); mainnet names follow the same
 * pattern and should be re-verified before the mainnet flip.
 *
 * The SDK (`@chainrails/sdk`) needs the API key, so every SDK call stays
 * server-side in src/app/api/chainrails/*. This module is pure and safe
 * to import from either client or server.
 *
 * See ARCHITECTURE.md §"The four rails".
 */

import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";
import { getChain, type ChainId } from "@/config/network";

/**
 * App ChainId → Chainrails chain enum.
 *
 * Verified testnet set (crapi.chains.getSupported({ network: "testnet" })):
 *   ARBITRUM_TESTNET, AVALANCHE_TESTNET, BASE_TESTNET, STARKNET_TESTNET,
 *   ETHEREUM_TESTNET, OPTIMISM_TESTNET, MONAD_TESTNET, SOLANA_TESTNET
 */
export const CHAINRAILS_CHAIN: Partial<Record<ChainId, string>> = {
  // Mainnet — supported by the Chainrails chain registry.
  ethereum: "ETHEREUM_MAINNET",
  base: "BASE_MAINNET",
  arbitrum: "ARBITRUM_MAINNET",
  optimism: "OPTIMISM_MAINNET",
  polygon: "POLYGON_MAINNET",
  avalanche: "AVALANCHE_MAINNET",
  bnb: "BSC_MAINNET",
  solana: "SOLANA_MAINNET",
  starknet: "STARKNET_MAINNET",
  // Testnet — verified.
  sepolia: "ETHEREUM_TESTNET",
  "base-sepolia": "BASE_TESTNET",
  "arbitrum-sepolia": "ARBITRUM_TESTNET",
  "op-sepolia": "OPTIMISM_TESTNET",
  "avalanche-fuji": "AVALANCHE_TESTNET",
  "solana-devnet": "SOLANA_TESTNET",
  "starknet-sepolia": "STARKNET_TESTNET",
};

export function isChainrailsSupported(chainId: ChainId): boolean {
  return chainId in CHAINRAILS_CHAIN;
}

// ---------------------------------------------------------------------------
// Ramp destinations (on-ramp / Buy).
//
// ChainRails delivers to a pasted address, so an on-ramp destination needs no
// connected wallet, RPC, or token registry — only a label, the ChainRails
// chain enum, and the address format to validate. That lets us offer chains
// the app has no wallet support for (Monad, HyperEVM, Lisk, Tron) as buy
// destinations without adding them to the shared chain registry.
//
// The full live mainnet set (13) comes from @chainrails/common InternalChains.
// Paycrest is our #1 on-ramp: where it serves a chain we route there and this
// catalogue is not used; ChainRails covers the rest.
// ---------------------------------------------------------------------------

/**
 * ChainRails OFF-ramp (Sell → fiat) gate. Driven by env so it flips without a
 * code change; defaults OFF when unset. While off: ChainRails-only chains are
 * hidden from the Sell picker and the off-ramp routes reject requests. On-ramp
 * (Buy) is unaffected and stays live.
 *
 * Off because live payouts 403 ("Fiat KYB is required before using live fiat
 * ramp flows") until RailGlide completes Fiat KYB. Set
 * NEXT_PUBLIC_CHAINRAILS_OFFRAMP_ENABLED=true once KYB is approved. It's
 * NEXT_PUBLIC_ because the client Sell picker reads it, not just the server.
 */
export const CHAINRAILS_OFFRAMP_ENABLED =
  process.env.NEXT_PUBLIC_CHAINRAILS_OFFRAMP_ENABLED === "true";

export type RampAddressKind = "evm" | "solana" | "starknet" | "tron";

export interface RampDestination {
  /** ChainRails chain enum sent as `destinationChain`. */
  chainrailsChain: string;
  /** Display name. */
  label: string;
  /** Address format the recipient must match. */
  addressKind: RampAddressKind;
  /** App ChainId when the wallet/registry knows this chain, else null. */
  chainId: ChainId | null;
}

/**
 * ChainRails-only on-ramp destinations — the live mainnet chains Paycrest
 * (our #1) does NOT serve. Paycrest covers Ethereum, Base, Arbitrum, Polygon,
 * BNB, Celo, Lisk, Scroll and Starknet; ChainRails picks up the rest. These
 * are the only chains a Buy routes to ChainRails for.
 */
export const CHAINRAILS_RAMP_DESTINATIONS: RampDestination[] = [
  {
    chainrailsChain: "OPTIMISM_MAINNET",
    label: "Optimism",
    addressKind: "evm",
    chainId: "optimism",
  },
  {
    chainrailsChain: "AVALANCHE_MAINNET",
    label: "Avalanche",
    addressKind: "evm",
    chainId: "avalanche",
  },
  {
    chainrailsChain: "SOLANA_MAINNET",
    label: "Solana",
    addressKind: "solana",
    chainId: "solana",
  },
  {
    chainrailsChain: "MONAD_MAINNET",
    label: "Monad",
    addressKind: "evm",
    chainId: null,
  },
  {
    chainrailsChain: "HYPEREVM_MAINNET",
    label: "HyperEVM",
    addressKind: "evm",
    chainId: null,
  },
  {
    chainrailsChain: "TRON_MAINNET",
    label: "Tron",
    addressKind: "tron",
    chainId: null,
  },
];

/** A country from ChainRails' live ramp catalogue. */
export type RampCountry = {
  countryCode: string;
  name: string;
  /** minAmount is in USDC for both Buy and Sell (INR's 13 = 13 USDC). */
  currency: { code: string; name: string; symbol: string; minAmount: number };
};

/**
 * A country's minimum order, in USDC and (with a live rate) in local money.
 * The one place Buy and Sell work this out, so they always agree.
 */
export function rampMinimum(
  country: RampCountry,
  unitRate: number | null
): { usdc: number; fiat: number | null } {
  const usdc = country.currency.minAmount;
  return { usdc, fiat: unitRate ? Math.ceil(usdc * unitRate) : null };
}

/** True when a USDC amount is under the country's minimum. */
export function isBelowRampMinimum(
  country: RampCountry | undefined,
  usdcAmount: number | null
): boolean {
  return (
    !!country &&
    usdcAmount !== null &&
    usdcAmount > 0 &&
    usdcAmount < country.currency.minAmount
  );
}

/**
 * Pay currencies Paycrest doesn't take that we offer through ChainRails. They
 * sit pinned under Paycrest's list in the Buy currency picker.
 */
export const CHAINRAILS_EXTRA_FIAT = [
  { code: "INR", countryCode: "IN" },
  { code: "MWK", countryCode: "MW" },
  // Dropped by Paycrest in Oct 2026; ChainRails still sells to these.
  { code: "GHS", countryCode: "GH" },
  { code: "ZMW", countryCode: "ZM" },
  { code: "ZAR", countryCode: "ZA" },
] as const;

/**
 * ChainRails destination for an app chain (e.g. Base), so a ChainRails-only
 * currency like INR can still land on the chain the user picked. Null when
 * ChainRails can't deliver there.
 */
export function chainrailsDestinationFor(
  chainId: ChainId
): RampDestination | null {
  const chainrailsChain = CHAINRAILS_CHAIN[chainId];
  if (!chainrailsChain) return null;
  const known = CHAINRAILS_RAMP_DESTINATIONS.find(
    (d) => d.chainrailsChain === chainrailsChain
  );
  if (known) return known;
  return {
    chainrailsChain,
    label: getChain(chainId)?.name ?? chainId,
    addressKind: chainId.startsWith("starknet") ? "starknet" : "evm",
    chainId,
  };
}

/**
 * Block-explorer URL for a ramp order's on-chain delivery tx, or null when we
 * don't have a confirmed explorer for that chain (Monad / HyperEVM mainnet).
 * Keyed on the ChainRails chain enum so the caller doesn't need a registry
 * entry — several ramp-only chains aren't in the shared network config, and the
 * tx path differs (Tron uses /#/transaction/, the rest use /tx/).
 */
export function rampTxUrl(
  chainrailsChain: string,
  txHash: string | null | undefined
): string | null {
  const h = (txHash ?? "").trim();
  if (!h) return null;
  switch (chainrailsChain) {
    case "OPTIMISM_MAINNET":
      return `https://optimistic.etherscan.io/tx/${h}`;
    case "AVALANCHE_MAINNET":
      return `https://snowtrace.io/tx/${h}`;
    case "SOLANA_MAINNET":
      return `https://solscan.io/tx/${h}`;
    case "TRON_MAINNET":
      return `https://tronscan.org/#/transaction/${h}`;
    default:
      return null;
  }
}

/** Validate a recipient address for a ramp destination's address format. */
export function isValidRampAddress(
  kind: RampAddressKind,
  value: string
): boolean {
  const v = value.trim();
  switch (kind) {
    case "solana":
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
    case "starknet":
      return /^0x[0-9a-fA-F]{1,64}$/.test(v);
    case "tron":
      return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v);
    case "evm":
    default:
      return /^0x[0-9a-fA-F]{40}$/.test(v);
  }
}

/**
 * Normalise a raw phone number to E.164 (`+<dial><subscriber>`) for the given
 * country (ISO 3166-1 alpha-2). Falls back to the trimmed input when the number
 * can't be parsed, so we never mangle something we can't reason about.
 */
export function toE164(raw: string, countryCode: string): string {
  const trimmed = raw.trim();
  const parsed = parsePhoneNumberFromString(
    trimmed,
    countryCode.toUpperCase() as CountryCode
  );
  return parsed?.number ?? trimmed;
}

/** Maps an app ChainId onto its Chainrails enum, or throws if unsupported. */
export function toChainrailsChain(chainId: ChainId): string {
  const name = CHAINRAILS_CHAIN[chainId];
  if (!name) {
    throw new Error(`Chainrails does not support chain "${chainId}"`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Ramp order status.
//
// The live REST API (GET /api/v1/ramp/orders/:id) returns status strings that
// do NOT match the SDK's `RampOrderStatuses` enum — the API prefixes them,
// e.g. ORDER_INITIATED, PAYMENT_PENDING, PAYMENT_EXPIRED, ORDER_COMPLETED.
// The SDK's TypeScript types lag the API, so we classify by substring rather
// than trusting a fixed enum, and keep an "unknown" fallback for new values.
// ---------------------------------------------------------------------------

export type RampOrderPhase =
  | "pending" // created, awaiting payment / provider action
  | "processing" // paid, provider is settling / bridging
  | "completed" // crypto delivered — terminal success
  | "expired" // payment window lapsed — terminal
  | "failed" // provider failed / cancelled / refunded — terminal
  | "unknown";

/** True once the order can no longer change — stop polling. */
export function isRampPhaseTerminal(phase: RampOrderPhase): boolean {
  return phase === "completed" || phase === "expired" || phase === "failed";
}

/**
 * Classify a live Chainrails order status into a UI phase. Matches by keyword
 * so it survives the API/SDK prefix drift (ORDER_/PAYMENT_) and unseen values.
 */
export function classifyRampStatus(
  status: string | null | undefined
): RampOrderPhase {
  const s = (status ?? "").toUpperCase();
  if (!s) return "unknown";
  if (
    s.includes("COMPLETED") ||
    s.includes("SETTLED") ||
    s.includes("SUCCESS")
  ) {
    return "completed";
  }
  if (s.includes("EXPIRED")) return "expired";
  if (
    s.includes("FAILED") ||
    s.includes("CANCELLED") ||
    s.includes("REFUNDED")
  ) {
    return "failed";
  }
  if (
    s.includes("PROCESSING") ||
    s.includes("BRIDGING") ||
    s.includes("PAID") ||
    s.includes("FUNDED") ||
    // PAYMENT_RECEIVED = the deposit landed, but the fiat payout (off-ramp) or
    // crypto delivery (on-ramp) is still in flight — NOT terminal. The provider
    // dashboard shows this as "Pending", so we treat it as processing, never
    // "completed" (which would falsely tell the user they'd been paid).
    s.includes("RECEIVED")
  ) {
    return "processing";
  }
  if (
    s.includes("INITIATED") ||
    s.includes("PENDING") ||
    s.includes("CREATED")
  ) {
    return "pending";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Shared types — the slice of the Chainrails quote response the UI needs.
// The route at /api/chainrails/quote returns the SDK payload verbatim;
// the hook narrows it to this shape.
// ---------------------------------------------------------------------------

export interface ChainrailsQuoteRequest {
  sourceChain: string;
  destinationChain: string;
  tokenIn: string;
  tokenOut: string;
  /** Raw base units, decimal string. */
  amount: string;
  recipient: string;
  /** Funding token symbol, e.g. "USDC". */
  amountSymbol: string;
}
