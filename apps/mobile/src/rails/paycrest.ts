// Paycrest pure types + helpers. Mirrors web's rails/paycrest.ts (non-server
// parts); hoist to @railglide/shared when unifying rail contracts.
import type { ChainId } from "@railglide/shared/network";

// Paycrest dropped GHS, XOF, ZMW and ZAR (Oct 2026). Check
// GET https://api.paycrest.io/v1/currencies when in doubt. Mirrors web.
export const PAYCREST_FIAT = ["NGN", "KES", "UGX", "TZS"] as const;

export type PaycrestFiat = (typeof PAYCREST_FIAT)[number];

export function isPaycrestFiat(code: string): code is PaycrestFiat {
  return (PAYCREST_FIAT as readonly string[]).includes(code.toUpperCase());
}

export type PaycrestToken = "USDC" | "USDT";
export type PaycrestDirection = "offramp" | "onramp";

/**
 * Paycrest rejects an order if the reference runs long (empirically past ~70
 * chars). Keep ours under this so the encoded wallet always fits.
 */
export const PAYCREST_REFERENCE_MAX_LENGTH = 70;

/**
 * Encodes the wallet into the order `reference` so History can tie the order
 * back to it. Paycrest overrides the off-ramp refundAddress to its own account
 * default, so the wallet isn't otherwise recoverable — `orderMatchesWallet`
 * (server) keys off the address embedded here. Mirrors web's builder; the "sw-"
 * prefix and short tag keep it under PAYCREST_REFERENCE_MAX_LENGTH.
 */
export function buildPaycrestReference(
  direction: PaycrestDirection,
  address: string | undefined
): string {
  const wallet = address ? address.toLowerCase() : "anon";
  const tag = direction === "offramp" ? "off" : "on";
  return `sw-${tag}-${wallet}-${Date.now()}`;
}

/** App ChainId → Paycrest network slug (mainnet only — Paycrest has no sandbox). */
export const PAYCREST_NETWORK_SLUGS: Partial<Record<ChainId, string>> = {
  base: "base",
  ethereum: "ethereum",
  arbitrum: "arbitrum-one",
  polygon: "polygon",
  bnb: "bnb-smart-chain",
};

export function paycrestNetworkSlug(chainId: ChainId): string | null {
  return PAYCREST_NETWORK_SLUGS[chainId] ?? null;
}

/** Paycrest network slug → app ChainId (reverse of paycrestNetworkSlug). */
export function chainIdFromPaycrestSlug(slug: string): ChainId | null {
  const entry = Object.entries(PAYCREST_NETWORK_SLUGS).find(
    ([, s]) => s === slug
  );
  return entry ? (entry[0] as ChainId) : null;
}

/** ChainIds Paycrest can off-ramp, for the source-chain picker. */
export const PAYCREST_CHAIN_IDS = Object.keys(
  PAYCREST_NETWORK_SLUGS
) as ChainId[];

/** A payout institution (bank or mobile-money) from Paycrest's catalogue. */
export interface PaycrestInstitution {
  name: string;
  /** Code passed as recipient.institution, e.g. "GTBINGLA", "OPAYNGPC". */
  code: string;
  type: "bank" | "mobile_money";
}

/** Bank or mobile-money payout destination. */
export interface PaycrestRecipient {
  institution: string;
  accountIdentifier: string;
  accountName: string;
  memo?: string;
}

export type PaycrestOrderStatus =
  | "initiated"
  | "deposited"
  | "pending"
  | "processing"
  | "validated"
  | "settling"
  | "fulfilled"
  | "settled"
  | "refunding"
  | "refunded"
  | "expired";

/** A created order, normalised by the backend from the Paycrest response. */
export interface PaycrestOrder {
  id: string;
  status: PaycrestOrderStatus;
  direction: PaycrestDirection;
  amount: string;
  currency: string;
  rate?: string;
  /** Off-ramp: on-chain address the user funds with stablecoin. */
  receiveAddress?: string;
  /** On-ramp: virtual account / mobile number to deposit fiat into. */
  depositInstitution?: string;
  depositAccountIdentifier?: string;
  depositAccountName?: string;
  /** On-ramp: exact fiat amount the user must transfer. */
  amountToTransfer?: string;
  depositCurrency?: string;
  /** On-ramp: wallet that receives the stablecoin. */
  recipientAddress?: string;
  validUntil?: string;
  amountPaid?: string;
  senderFee?: string;
  transactionFee?: string;
  txHash?: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * What the user must send for an off-ramp order: Paycrest's amountToTransfer,
 * else amount + senderFee + transactionFee. Never the bare `amount` — that
 * leaves the order short by the fees. (Mirrors apps/web/src/rails/paycrest.ts.)
 */
export function paycrestAmountDue(
  order: Pick<
    PaycrestOrder,
    "amount" | "amountToTransfer" | "senderFee" | "transactionFee"
  >
): string {
  if (Number(order.amountToTransfer) > 0) return order.amountToTransfer!;
  const total =
    Number(order.amount ?? 0) +
    Number(order.senderFee ?? 0) +
    Number(order.transactionFee ?? 0);
  // Round up at 6 decimals so we never send a hair short.
  return String(Math.ceil(total * 1e6) / 1e6);
}

export type PaycrestOutcome = "success" | "failed" | "expired" | "pending";

/** True once the provider has started paying out (on-ramp timeline → settling). */
export function paycrestPayoutInFlight(order: PaycrestOrder): boolean {
  return [
    "processing",
    "validated",
    "settling",
    "fulfilled",
    "settled",
  ].includes(order.status);
}

/** Direction-aware terminal check for the client poller. */
export function classifyPaycrestOrder(
  order: PaycrestOrder,
  direction: PaycrestDirection
): PaycrestOutcome {
  if (order.status === "settled") return "success";
  if (direction === "offramp" && order.status === "fulfilled") return "success";
  if (order.status === "refunded") return "failed";
  if (order.status === "expired") return "expired";
  if (order.validUntil && new Date(order.validUntil).getTime() < Date.now()) {
    // Funding window closed with no deposit credited yet.
    if (!order.amountPaid || Number(order.amountPaid) <= 0) return "expired";
  }
  return "pending";
}

/** Unwrap `{ "error": "…" }` if a caller passed the raw API body through. */
function unwrapErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: unknown;
      message?: unknown;
    };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // keep original
  }
  return trimmed;
}

/** Turns a raw Paycrest error into something a non-technical user can act on. */
export function humanizePaycrestError(message: string): string {
  const raw = unwrapErrorMessage(message);
  const m = raw.toLowerCase();
  if (m.includes("failed to create virtual account")) {
    return "We couldn't create a payment account for this order. Try again in a moment, or pick a different amount.";
  }
  if (m.includes("no provider available")) {
    return "No provider can fill an order this size right now. Try a smaller amount, or check back shortly.";
  }
  if (m.includes("rate validation") || m.includes("no rate")) {
    return "We couldn't lock a rate for that amount — try a different amount.";
  }
  if (m.includes("insufficient") || m.includes("minimum")) {
    return "That amount is outside the supported range for this payout — try a different amount.";
  }
  if (m.includes("failed to initiate payment order")) {
    return "We couldn't start this payout — please try again in a moment.";
  }
  const cleaned = raw
    .replace(/^failed to validate payload\s*\[[^\]]*\]\s*/i, "")
    .replace(/\bpaycrest\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim();
  return cleaned || "Something went wrong — try again.";
}
